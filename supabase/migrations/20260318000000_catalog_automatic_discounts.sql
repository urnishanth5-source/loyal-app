alter table public.billing_catalog_items
  add column if not exists discount_type text not null default 'none',
  add column if not exists discount_value numeric(14,2) not null default 0;

alter table public.billing_catalog_items
  drop constraint if exists billing_catalog_items_discount_type_check,
  drop constraint if exists billing_catalog_items_discount_value_check;

alter table public.billing_catalog_items
  add constraint billing_catalog_items_discount_type_check
    check (discount_type in ('none', 'percent', 'fixed')),
  add constraint billing_catalog_items_discount_value_check
    check (
      discount_value >= 0
      and (discount_type <> 'percent' or discount_value <= 100)
    );
