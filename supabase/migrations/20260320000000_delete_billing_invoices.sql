create or replace function public.perklyn_delete_billing_invoice(
  p_business_id bigint,
  p_owner_user_id uuid,
  p_invoice_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice public.billing_invoices%rowtype;
  v_item public.billing_invoice_items%rowtype;
  v_membership_key text;
  v_membership jsonb;
  v_balance bigint;
  v_state jsonb;
  v_customers jsonb;
  v_transactions jsonb;
  v_activities jsonb;
begin
  select * into v_invoice
  from public.billing_invoices
  where id = p_invoice_id
    and business_id = p_business_id
    and owner_user_id = p_owner_user_id
  for update;
  if not found then raise exception 'Invoice not found'; end if;
  if exists (select 1 from public.billing_credit_notes where invoice_id = p_invoice_id) then
    raise exception 'Invoices with credit notes cannot be deleted';
  end if;

  for v_item in
    select * from public.billing_invoice_items where invoice_id = p_invoice_id for update
  loop
    if v_item.catalog_item_id is not null and v_item.item_type = 'product' then
      update public.billing_catalog_items
      set stock_quantity = stock_quantity + v_item.quantity,
          updated_at = clock_timestamp()
      where id = v_item.catalog_item_id and stock_quantity is not null;
    end if;
  end loop;

  if v_invoice.customer_phone is not null and v_invoice.points_awarded > 0 then
    v_membership_key := 'pending:' || regexp_replace(v_invoice.customer_phone, '\D', '', 'g') || ':' || p_business_id;
    select value into v_membership
    from public.kv_store_3a123995
    where key = v_membership_key
    for update;
    if v_membership is not null then
      v_balance := greatest(0, coalesce((v_membership->>'points')::bigint, 0) - v_invoice.points_awarded);
      select coalesce(jsonb_agg(transaction), '[]'::jsonb)
      into v_transactions
      from jsonb_array_elements(coalesce(v_membership->'transactions', '[]'::jsonb)) transaction
      where transaction->>'id' <> 'billing:' || p_invoice_id::text;
      v_membership := v_membership || jsonb_build_object(
        'points', v_balance,
        'updatedAt', clock_timestamp(),
        'transactions', v_transactions
      );
      update public.kv_store_3a123995 set value = v_membership where key = v_membership_key;

      select value into v_state
      from public.kv_store_3a123995
      where key = 'state:' || p_owner_user_id::text
      for update;
      if v_state is not null then
        select coalesce(jsonb_agg(
          case when regexp_replace(customer->>'phone', '\D', '', 'g') = regexp_replace(v_invoice.customer_phone, '\D', '', 'g')
            then customer || jsonb_build_object('points', v_balance)
            else customer end
        ), '[]'::jsonb)
        into v_customers
        from jsonb_array_elements(coalesce(v_state->'customers', '[]'::jsonb)) customer;
        select coalesce(jsonb_agg(activity), '[]'::jsonb)
        into v_activities
        from jsonb_array_elements(coalesce(v_state->'activities', '[]'::jsonb)) activity
        where activity->>'id' <> 'billing:' || p_invoice_id::text;
        update public.kv_store_3a123995
        set value = v_state || jsonb_build_object(
          'customers', v_customers,
          'activities', v_activities
        )
        where key = 'state:' || p_owner_user_id::text;
      end if;
    end if;
  end if;

  delete from public.billing_payments where invoice_id = p_invoice_id;
  delete from public.billing_invoice_items where invoice_id = p_invoice_id;
  delete from public.billing_invoices where id = p_invoice_id;

  return jsonb_build_object(
    'deleted', true,
    'invoiceId', p_invoice_id,
    'totalPaise', v_invoice.total_paise
  );
end;
$$;

revoke all on function public.perklyn_delete_billing_invoice(bigint, uuid, uuid)
  from public, anon, authenticated;
