alter table public.billing_settings
  add column if not exists catalog_option_values jsonb not null
  default '{"brands":[],"designs":[],"sizes":[],"categories":[]}'::jsonb;
