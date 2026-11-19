alter table public.billing_catalog_items
  drop constraint if exists billing_catalog_items_stock_quantity_check;

create or replace function public.perklyn_decrement_billing_stock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item_type text;
  v_stock numeric(14,3);
begin
  if new.catalog_item_id is null then
    return new;
  end if;

  select item_type, stock_quantity
  into v_item_type, v_stock
  from public.billing_catalog_items
  where id = new.catalog_item_id
  for update;

  if not found then
    raise exception 'Catalog item no longer exists';
  end if;

  if v_item_type = 'product' and v_stock is not null then
    update public.billing_catalog_items
    set stock_quantity = stock_quantity - new.quantity,
        updated_at = clock_timestamp()
    where id = new.catalog_item_id;
  end if;
  return new;
end;
$$;

revoke all on function public.perklyn_decrement_billing_stock()
  from public, anon, authenticated;

create or replace function public.perklyn_update_billing_invoice(
  p_business_id bigint,
  p_owner_user_id uuid,
  p_invoice_id uuid,
  p_lines jsonb,
  p_totals jsonb,
  p_points_awarded integer
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice public.billing_invoices%rowtype;
  v_existing public.billing_invoice_items%rowtype;
  v_payment_count integer;
  v_delta integer;
  v_membership_key text;
  v_membership jsonb;
  v_balance bigint;
  v_state jsonb;
  v_customers jsonb;
begin
  select * into v_invoice
  from public.billing_invoices
  where id = p_invoice_id
    and business_id = p_business_id
    and owner_user_id = p_owner_user_id
  for update;

  if not found then raise exception 'Invoice not found'; end if;
  if v_invoice.status <> 'paid' then
    raise exception 'Only paid invoices without credit notes can be edited';
  end if;
  if exists (
    select 1 from public.billing_credit_notes where invoice_id = p_invoice_id
  ) then
    raise exception 'Invoices with credit notes cannot be edited';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'An invoice must contain at least one item';
  end if;

  select count(*) into v_payment_count
  from public.billing_payments
  where invoice_id = p_invoice_id;
  if v_payment_count <> 1 then
    raise exception 'Split-payment invoices cannot be edited directly';
  end if;

  -- Return the original stock before applying the complete edited invoice.
  for v_existing in
    select * from public.billing_invoice_items
    where invoice_id = p_invoice_id
    for update
  loop
    if v_existing.catalog_item_id is not null
      and v_existing.item_type = 'product' then
      update public.billing_catalog_items
      set stock_quantity = stock_quantity + v_existing.quantity,
          updated_at = clock_timestamp()
      where id = v_existing.catalog_item_id
        and business_id = p_business_id
        and stock_quantity is not null;
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) line
    where line->>'catalog_item_id' is not null
      and not exists (
        select 1
        from public.billing_catalog_items catalog
        where catalog.id = (line->>'catalog_item_id')::uuid
          and catalog.business_id = p_business_id
      )
  ) then
    raise exception 'An edited catalog item does not belong to this business';
  end if;

  delete from public.billing_invoice_items where invoice_id = p_invoice_id;

  -- Reinserting the edited lines invokes the stock trigger exactly once.
  insert into public.billing_invoice_items(
    id, invoice_id, catalog_item_id, line_number, item_type, name, hsn_sac,
    unit, quantity, unit_price_paise, price_includes_tax, gst_rate_bps,
    gross_before_discount_paise, line_discount_paise,
    allocated_cart_discount_paise, taxable_paise, cgst_paise, sgst_paise,
    igst_paise, total_paise
  )
  select
    (line->>'id')::uuid,
    p_invoice_id,
    nullif(line->>'catalog_item_id', '')::uuid,
    (line->>'line_number')::integer,
    line->>'item_type',
    line->>'name',
    line->>'hsn_sac',
    line->>'unit',
    (line->>'quantity')::numeric,
    (line->>'unit_price_paise')::bigint,
    (line->>'price_includes_tax')::boolean,
    (line->>'gst_rate_bps')::integer,
    (line->>'gross_before_discount_paise')::bigint,
    (line->>'line_discount_paise')::bigint,
    (line->>'allocated_cart_discount_paise')::bigint,
    (line->>'taxable_paise')::bigint,
    (line->>'cgst_paise')::bigint,
    (line->>'sgst_paise')::bigint,
    (line->>'igst_paise')::bigint,
    (line->>'total_paise')::bigint
  from jsonb_array_elements(p_lines) line;

  v_delta := p_points_awarded - v_invoice.points_awarded;
  if v_delta <> 0 and v_invoice.customer_phone is not null then
    v_membership_key :=
      'pending:' ||
      regexp_replace(v_invoice.customer_phone, '\D', '', 'g') ||
      ':' || p_business_id;
    select value into v_membership
    from public.kv_store_3a123995
    where key = v_membership_key
    for update;
    if v_membership is not null then
      v_balance := coalesce((v_membership->>'points')::bigint, 0) + v_delta;
      if v_balance < 0 then
        raise exception 'Customer does not have enough points to reduce this invoice total';
      end if;
      v_membership := v_membership || jsonb_build_object(
        'points', v_balance,
        'updatedAt', clock_timestamp()
      );
      update public.kv_store_3a123995
      set value = v_membership
      where key = v_membership_key;

      select value into v_state
      from public.kv_store_3a123995
      where key = 'state:' || p_owner_user_id::text
      for update;
      if v_state is not null then
        select coalesce(jsonb_agg(
          case
            when regexp_replace(customer->>'phone', '\D', '', 'g') =
              regexp_replace(v_invoice.customer_phone, '\D', '', 'g')
            then customer || jsonb_build_object('points', v_balance)
            else customer
          end
        ), '[]'::jsonb)
        into v_customers
        from jsonb_array_elements(
          coalesce(v_state->'customers', '[]'::jsonb)
        ) customer;

        update public.kv_store_3a123995
        set value = v_state || jsonb_build_object('customers', v_customers)
        where key = 'state:' || p_owner_user_id::text;
      end if;
    end if;
  end if;

  update public.billing_invoices set
    subtotal_paise = (p_totals->>'subtotal_paise')::bigint,
    line_discount_paise = (p_totals->>'line_discount_paise')::bigint,
    cart_discount_paise = (p_totals->>'cart_discount_paise')::bigint,
    taxable_paise = (p_totals->>'taxable_paise')::bigint,
    cgst_paise = (p_totals->>'cgst_paise')::bigint,
    sgst_paise = (p_totals->>'sgst_paise')::bigint,
    igst_paise = (p_totals->>'igst_paise')::bigint,
    total_paise = (p_totals->>'total_paise')::bigint,
    points_awarded = p_points_awarded
  where id = p_invoice_id;

  update public.billing_payments
  set amount_paise = (p_totals->>'total_paise')::bigint
  where invoice_id = p_invoice_id;

  return (
    select to_jsonb(invoice)
    from public.billing_invoices invoice
    where id = p_invoice_id
  );
end;
$$;

revoke all on function public.perklyn_update_billing_invoice(
  bigint, uuid, uuid, jsonb, jsonb, integer
) from public, anon, authenticated;
