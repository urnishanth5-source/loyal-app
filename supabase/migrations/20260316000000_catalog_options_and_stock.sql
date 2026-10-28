alter table public.billing_settings
  add column if not exists catalog_custom_fields jsonb not null default '[]'::jsonb;

alter table public.billing_catalog_items
  add column if not exists brand text,
  add column if not exists design text,
  add column if not exists size text,
  add column if not exists stock_quantity numeric(14,3),
  add column if not exists custom_values jsonb not null default '{}'::jsonb;

alter table public.billing_catalog_items
  drop constraint if exists billing_catalog_items_stock_quantity_check;

alter table public.billing_catalog_items
  add constraint billing_catalog_items_stock_quantity_check
  check (stock_quantity is null or stock_quantity >= 0);

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
    if v_stock < new.quantity then
      raise exception 'Insufficient stock for %', new.name;
    end if;
    update public.billing_catalog_items
    set stock_quantity = stock_quantity - new.quantity,
        updated_at = clock_timestamp()
    where id = new.catalog_item_id;
  end if;
  return new;
end;
$$;

drop trigger if exists billing_invoice_item_decrement_stock
  on public.billing_invoice_items;

create trigger billing_invoice_item_decrement_stock
before insert on public.billing_invoice_items
for each row execute function public.perklyn_decrement_billing_stock();

create or replace function public.perklyn_restore_billing_stock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_catalog_item_id uuid;
  v_item_type text;
begin
  select catalog_item_id, item_type
  into v_catalog_item_id, v_item_type
  from public.billing_invoice_items
  where id = new.invoice_item_id;

  if v_catalog_item_id is not null and v_item_type = 'product' then
    update public.billing_catalog_items
    set stock_quantity = stock_quantity + new.quantity,
        updated_at = clock_timestamp()
    where id = v_catalog_item_id
      and stock_quantity is not null;
  end if;
  return new;
end;
$$;

drop trigger if exists billing_credit_note_item_restore_stock
  on public.billing_credit_note_items;

create trigger billing_credit_note_item_restore_stock
after insert on public.billing_credit_note_items
for each row execute function public.perklyn_restore_billing_stock();

revoke all on function public.perklyn_decrement_billing_stock() from public, anon, authenticated;
revoke all on function public.perklyn_restore_billing_stock() from public, anon, authenticated;
