alter table public.billing_settings
  add column if not exists receipt_footer text not null default '';
