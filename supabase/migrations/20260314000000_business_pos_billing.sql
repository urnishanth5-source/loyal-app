create table if not exists public.billing_settings (
  business_id bigint primary key,
  owner_user_id uuid not null,
  legal_name text not null,
  gstin text,
  address_line_1 text not null,
  address_line_2 text,
  city text not null,
  state_name text not null,
  state_code text not null,
  postal_code text not null,
  invoice_prefix text not null default 'INV',
  credit_note_prefix text not null default 'CN',
  points_per_rupee numeric(10,4) not null default 1 check (points_per_rupee >= 0),
  catalog_custom_fields jsonb not null default '[]'::jsonb,
  catalog_option_values jsonb not null default '{"brands":[],"designs":[],"sizes":[],"categories":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_document_counters (
  business_id bigint not null,
  fiscal_year text not null,
  document_type text not null check (document_type in ('invoice', 'credit_note')),
  next_number bigint not null default 1 check (next_number > 0),
  primary key (business_id, fiscal_year, document_type)
);

create table if not exists public.billing_catalog_items (
  id uuid primary key,
  business_id bigint not null,
  owner_user_id uuid not null,
  item_type text not null check (item_type in ('product', 'service')),
  name text not null,
  category text,
  brand text,
  design text,
  size text,
  sku text,
  barcode text,
  hsn_sac text not null,
  unit text not null,
  price_paise bigint not null check (price_paise >= 0),
  gst_rate_bps integer not null check (gst_rate_bps in (0, 500, 1200, 1800, 2800)),
  price_includes_tax boolean not null default true,
  stock_quantity numeric(14,3),
  custom_values jsonb not null default '{}'::jsonb,
  discount_type text not null default 'none' check (discount_type in ('none', 'percent', 'fixed')),
  discount_value numeric(14,2) not null default 0 check (discount_value >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists billing_catalog_business_barcode
  on public.billing_catalog_items(business_id, barcode)
  where barcode is not null and barcode <> '';
create unique index if not exists billing_catalog_business_sku
  on public.billing_catalog_items(business_id, sku)
  where sku is not null and sku <> '';
create index if not exists billing_catalog_business_active
  on public.billing_catalog_items(business_id, active, name);

create table if not exists public.billing_invoices (
  id uuid primary key,
  business_id bigint not null,
  owner_user_id uuid not null,
  invoice_number text not null,
  fiscal_year text not null,
  status text not null default 'paid' check (status in ('paid', 'partially_refunded', 'refunded')),
  customer_id text,
  customer_name text,
  customer_phone text,
  place_of_supply_code text not null,
  subtotal_paise bigint not null,
  line_discount_paise bigint not null,
  cart_discount_paise bigint not null,
  taxable_paise bigint not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  total_paise bigint not null check (total_paise >= 0),
  refunded_paise bigint not null default 0,
  points_per_rupee_snapshot numeric(10,4) not null,
  points_awarded integer not null default 0,
  points_reversed integer not null default 0,
  seller_snapshot jsonb not null,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  unique (business_id, invoice_number),
  unique (business_id, idempotency_key)
);

create index if not exists billing_invoices_business_created
  on public.billing_invoices(business_id, created_at desc);

create table if not exists public.billing_invoice_items (
  id uuid primary key,
  invoice_id uuid not null references public.billing_invoices(id),
  catalog_item_id uuid,
  line_number integer not null,
  item_type text not null,
  name text not null,
  hsn_sac text not null,
  unit text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_price_paise bigint not null,
  price_includes_tax boolean not null,
  gst_rate_bps integer not null,
  gross_before_discount_paise bigint not null,
  line_discount_paise bigint not null,
  allocated_cart_discount_paise bigint not null,
  taxable_paise bigint not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  total_paise bigint not null
);

create table if not exists public.billing_payments (
  id uuid primary key,
  invoice_id uuid not null references public.billing_invoices(id),
  payment_mode text not null check (payment_mode in ('cash', 'upi', 'card')),
  amount_paise bigint not null check (amount_paise > 0),
  reference text,
  created_at timestamptz not null default now()
);

create table if not exists public.billing_credit_notes (
  id uuid primary key,
  invoice_id uuid not null references public.billing_invoices(id),
  business_id bigint not null,
  owner_user_id uuid not null,
  credit_note_number text not null,
  fiscal_year text not null,
  reason text not null,
  subtotal_paise bigint not null,
  taxable_paise bigint not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  total_paise bigint not null,
  points_reversal_requested integer not null,
  points_reversed integer not null default 0,
  refund_mode text not null check (refund_mode in ('cash', 'upi', 'card')),
  refund_reference text,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  unique (business_id, credit_note_number),
  unique (business_id, idempotency_key)
);

create table if not exists public.billing_credit_note_items (
  id uuid primary key,
  credit_note_id uuid not null references public.billing_credit_notes(id),
  invoice_item_id uuid not null references public.billing_invoice_items(id),
  quantity numeric(14,3) not null check (quantity > 0),
  subtotal_paise bigint not null,
  taxable_paise bigint not null,
  cgst_paise bigint not null,
  sgst_paise bigint not null,
  igst_paise bigint not null,
  total_paise bigint not null
);

alter table public.billing_settings enable row level security;
alter table public.billing_document_counters enable row level security;
alter table public.billing_catalog_items enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_invoice_items enable row level security;
alter table public.billing_payments enable row level security;
alter table public.billing_credit_notes enable row level security;
alter table public.billing_credit_note_items enable row level security;

revoke all on public.billing_settings from public, anon, authenticated;
revoke all on public.billing_document_counters from public, anon, authenticated;
revoke all on public.billing_catalog_items from public, anon, authenticated;
revoke all on public.billing_invoices from public, anon, authenticated;
revoke all on public.billing_invoice_items from public, anon, authenticated;
revoke all on public.billing_payments from public, anon, authenticated;
revoke all on public.billing_credit_notes from public, anon, authenticated;
revoke all on public.billing_credit_note_items from public, anon, authenticated;

create or replace function public.perklyn_finalize_billing_invoice(
  p_business_id bigint,
  p_owner_user_id uuid,
  p_invoice jsonb,
  p_items jsonb,
  p_payments jsonb,
  p_membership_key text default null,
  p_activity jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.billing_invoices%rowtype;
  v_sequence bigint;
  v_invoice_number text;
  v_invoice_id uuid := (p_invoice->>'id')::uuid;
  v_membership jsonb;
  v_state jsonb;
  v_balance bigint;
  v_customers jsonb;
begin
  select * into v_existing
  from public.billing_invoices
  where business_id = p_business_id
    and idempotency_key = (p_invoice->>'idempotency_key')::uuid;
  if found then
    return jsonb_build_object('invoice', to_jsonb(v_existing), 'duplicate', true);
  end if;

  insert into public.billing_document_counters(business_id, fiscal_year, document_type, next_number)
  values (p_business_id, p_invoice->>'fiscal_year', 'invoice', 1)
  on conflict do nothing;
  select next_number into v_sequence
  from public.billing_document_counters
  where business_id = p_business_id
    and fiscal_year = p_invoice->>'fiscal_year'
    and document_type = 'invoice'
  for update;
  update public.billing_document_counters
  set next_number = next_number + 1
  where business_id = p_business_id
    and fiscal_year = p_invoice->>'fiscal_year'
    and document_type = 'invoice';
  v_invoice_number := (p_invoice->>'invoice_prefix') || '/' || (p_invoice->>'fiscal_year') || '/' || lpad(v_sequence::text, 6, '0');

  insert into public.billing_invoices(
    id, business_id, owner_user_id, invoice_number, fiscal_year, customer_id,
    customer_name, customer_phone, place_of_supply_code, subtotal_paise,
    line_discount_paise, cart_discount_paise, taxable_paise, cgst_paise,
    sgst_paise, igst_paise, total_paise, points_per_rupee_snapshot,
    points_awarded, seller_snapshot, idempotency_key
  ) values (
    v_invoice_id, p_business_id, p_owner_user_id, v_invoice_number,
    p_invoice->>'fiscal_year', nullif(p_invoice->>'customer_id', ''),
    nullif(p_invoice->>'customer_name', ''), nullif(p_invoice->>'customer_phone', ''),
    p_invoice->>'place_of_supply_code', (p_invoice->>'subtotal_paise')::bigint,
    (p_invoice->>'line_discount_paise')::bigint, (p_invoice->>'cart_discount_paise')::bigint,
    (p_invoice->>'taxable_paise')::bigint, (p_invoice->>'cgst_paise')::bigint,
    (p_invoice->>'sgst_paise')::bigint, (p_invoice->>'igst_paise')::bigint,
    (p_invoice->>'total_paise')::bigint, (p_invoice->>'points_per_rupee_snapshot')::numeric,
    (p_invoice->>'points_awarded')::integer, p_invoice->'seller_snapshot',
    (p_invoice->>'idempotency_key')::uuid
  );

  insert into public.billing_invoice_items(
    id, invoice_id, catalog_item_id, line_number, item_type, name, hsn_sac,
    unit, quantity, unit_price_paise, price_includes_tax, gst_rate_bps,
    gross_before_discount_paise, line_discount_paise, allocated_cart_discount_paise,
    taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise
  )
  select
    (item->>'id')::uuid, v_invoice_id, nullif(item->>'catalog_item_id', '')::uuid,
    (item->>'line_number')::integer, item->>'item_type', item->>'name',
    item->>'hsn_sac', item->>'unit', (item->>'quantity')::numeric,
    (item->>'unit_price_paise')::bigint, (item->>'price_includes_tax')::boolean,
    (item->>'gst_rate_bps')::integer, (item->>'gross_before_discount_paise')::bigint,
    (item->>'line_discount_paise')::bigint, (item->>'allocated_cart_discount_paise')::bigint,
    (item->>'taxable_paise')::bigint, (item->>'cgst_paise')::bigint,
    (item->>'sgst_paise')::bigint, (item->>'igst_paise')::bigint,
    (item->>'total_paise')::bigint
  from jsonb_array_elements(p_items) as item;

  insert into public.billing_payments(id, invoice_id, payment_mode, amount_paise, reference)
  select
    (payment->>'id')::uuid, v_invoice_id, payment->>'payment_mode',
    (payment->>'amount_paise')::bigint, nullif(payment->>'reference', '')
  from jsonb_array_elements(p_payments) as payment;

  if p_membership_key is not null and (p_invoice->>'points_awarded')::integer > 0 then
    select value into v_membership
    from public.kv_store_3a123995
    where key = p_membership_key
    for update;
    if v_membership is not null then
      v_balance := coalesce((v_membership->>'points')::bigint, 0) + (p_invoice->>'points_awarded')::integer;
      v_membership := v_membership || jsonb_build_object(
        'points', v_balance,
        'updatedAt', clock_timestamp(),
        'transactions', jsonb_build_array(p_activity) || coalesce(v_membership->'transactions', '[]'::jsonb)
      );
      update public.kv_store_3a123995 set value = v_membership where key = p_membership_key;

      select value into v_state from public.kv_store_3a123995 where key = 'state:' || p_owner_user_id::text for update;
      if v_state is not null then
        select coalesce(jsonb_agg(
          case when regexp_replace(customer->>'phone', '\D', '', 'g') = regexp_replace(p_invoice->>'customer_phone', '\D', '', 'g')
            then customer || jsonb_build_object('points', v_balance)
            else customer end
        ), '[]'::jsonb) into v_customers
        from jsonb_array_elements(coalesce(v_state->'customers', '[]'::jsonb)) customer;
        v_state := v_state || jsonb_build_object(
          'customers', v_customers,
          'activities', jsonb_build_array(p_activity) || coalesce(v_state->'activities', '[]'::jsonb)
        );
        update public.kv_store_3a123995 set value = v_state where key = 'state:' || p_owner_user_id::text;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'invoice', (select to_jsonb(invoice) from public.billing_invoices invoice where id = v_invoice_id),
    'balance', v_balance,
    'duplicate', false
  );
end;
$$;

create or replace function public.perklyn_create_billing_credit_note(
  p_business_id bigint,
  p_owner_user_id uuid,
  p_credit_note jsonb,
  p_items jsonb,
  p_membership_key text default null,
  p_activity jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice public.billing_invoices%rowtype;
  v_existing public.billing_credit_notes%rowtype;
  v_sequence bigint;
  v_number text;
  v_membership jsonb;
  v_state jsonb;
  v_customers jsonb;
  v_balance bigint;
  v_requested integer := (p_credit_note->>'points_reversal_requested')::integer;
  v_actual integer := 0;
  v_total_refunded bigint;
begin
  select * into v_existing from public.billing_credit_notes
  where business_id = p_business_id
    and idempotency_key = (p_credit_note->>'idempotency_key')::uuid;
  if found then return jsonb_build_object('creditNote', to_jsonb(v_existing), 'duplicate', true); end if;

  select * into v_invoice from public.billing_invoices
  where id = (p_credit_note->>'invoice_id')::uuid and business_id = p_business_id
  for update;
  if not found then raise exception 'Invoice not found'; end if;
  if v_invoice.refunded_paise + (p_credit_note->>'total_paise')::bigint > v_invoice.total_paise then
    raise exception 'Refund exceeds the remaining invoice amount';
  end if;

  insert into public.billing_document_counters(business_id, fiscal_year, document_type, next_number)
  values (p_business_id, p_credit_note->>'fiscal_year', 'credit_note', 1)
  on conflict do nothing;
  select next_number into v_sequence from public.billing_document_counters
  where business_id = p_business_id and fiscal_year = p_credit_note->>'fiscal_year'
    and document_type = 'credit_note' for update;
  update public.billing_document_counters set next_number = next_number + 1
  where business_id = p_business_id and fiscal_year = p_credit_note->>'fiscal_year'
    and document_type = 'credit_note';
  v_number := (p_credit_note->>'credit_note_prefix') || '/' || (p_credit_note->>'fiscal_year') || '/' || lpad(v_sequence::text, 6, '0');

  if p_membership_key is not null and v_requested > 0 then
    select value into v_membership from public.kv_store_3a123995 where key = p_membership_key for update;
    if v_membership is not null then
      v_actual := least(coalesce((v_membership->>'points')::integer, 0), v_requested);
      v_balance := greatest(0, coalesce((v_membership->>'points')::bigint, 0) - v_actual);
      v_membership := v_membership || jsonb_build_object(
        'points', v_balance,
        'updatedAt', clock_timestamp(),
        'transactions', jsonb_build_array(p_activity || jsonb_build_object('points', v_actual)) || coalesce(v_membership->'transactions', '[]'::jsonb)
      );
      update public.kv_store_3a123995 set value = v_membership where key = p_membership_key;

      select value into v_state from public.kv_store_3a123995 where key = 'state:' || p_owner_user_id::text for update;
      if v_state is not null then
        select coalesce(jsonb_agg(
          case when regexp_replace(customer->>'phone', '\D', '', 'g') = regexp_replace(v_invoice.customer_phone, '\D', '', 'g')
            then customer || jsonb_build_object('points', v_balance)
            else customer end
        ), '[]'::jsonb) into v_customers
        from jsonb_array_elements(coalesce(v_state->'customers', '[]'::jsonb)) customer;
        v_state := v_state || jsonb_build_object(
          'customers', v_customers,
          'activities', jsonb_build_array(p_activity || jsonb_build_object('points', v_actual)) || coalesce(v_state->'activities', '[]'::jsonb)
        );
        update public.kv_store_3a123995 set value = v_state where key = 'state:' || p_owner_user_id::text;
      end if;
    end if;
  end if;

  insert into public.billing_credit_notes(
    id, invoice_id, business_id, owner_user_id, credit_note_number, fiscal_year,
    reason, subtotal_paise, taxable_paise, cgst_paise, sgst_paise, igst_paise,
    total_paise, points_reversal_requested, points_reversed, refund_mode,
    refund_reference, idempotency_key
  ) values (
    (p_credit_note->>'id')::uuid, v_invoice.id, p_business_id, p_owner_user_id,
    v_number, p_credit_note->>'fiscal_year', p_credit_note->>'reason',
    (p_credit_note->>'subtotal_paise')::bigint, (p_credit_note->>'taxable_paise')::bigint,
    (p_credit_note->>'cgst_paise')::bigint, (p_credit_note->>'sgst_paise')::bigint,
    (p_credit_note->>'igst_paise')::bigint, (p_credit_note->>'total_paise')::bigint,
    v_requested, v_actual, p_credit_note->>'refund_mode',
    nullif(p_credit_note->>'refund_reference', ''), (p_credit_note->>'idempotency_key')::uuid
  );

  insert into public.billing_credit_note_items(
    id, credit_note_id, invoice_item_id, quantity, subtotal_paise, taxable_paise,
    cgst_paise, sgst_paise, igst_paise, total_paise
  )
  select
    (item->>'id')::uuid, (p_credit_note->>'id')::uuid,
    (item->>'invoice_item_id')::uuid, (item->>'quantity')::numeric,
    (item->>'subtotal_paise')::bigint, (item->>'taxable_paise')::bigint,
    (item->>'cgst_paise')::bigint, (item->>'sgst_paise')::bigint,
    (item->>'igst_paise')::bigint, (item->>'total_paise')::bigint
  from jsonb_array_elements(p_items) item;

  v_total_refunded := v_invoice.refunded_paise + (p_credit_note->>'total_paise')::bigint;
  update public.billing_invoices set
    refunded_paise = v_total_refunded,
    points_reversed = points_reversed + v_actual,
    status = case when v_total_refunded >= total_paise then 'refunded' else 'partially_refunded' end
  where id = v_invoice.id;

  return jsonb_build_object(
    'creditNote', (select to_jsonb(note) from public.billing_credit_notes note where id = (p_credit_note->>'id')::uuid),
    'balance', v_balance,
    'duplicate', false
  );
end;
$$;

revoke all on function public.perklyn_finalize_billing_invoice(bigint, uuid, jsonb, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.perklyn_create_billing_credit_note(bigint, uuid, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.perklyn_finalize_billing_invoice(bigint, uuid, jsonb, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.perklyn_create_billing_credit_note(bigint, uuid, jsonb, jsonb, text, jsonb) to service_role;
