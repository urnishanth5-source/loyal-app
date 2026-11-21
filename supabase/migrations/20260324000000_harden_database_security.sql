alter table if exists public.kv_store_3a123995 enable row level security;
alter table if exists public.kv_store_3a123995 force row level security;

alter table if exists public.billing_settings force row level security;
alter table if exists public.billing_document_counters force row level security;
alter table if exists public.billing_catalog_items force row level security;
alter table if exists public.billing_invoices force row level security;
alter table if exists public.billing_invoice_items force row level security;
alter table if exists public.billing_payments force row level security;
alter table if exists public.billing_credit_notes force row level security;
alter table if exists public.billing_credit_note_items force row level security;

revoke all on public.kv_store_3a123995 from public, anon, authenticated;
revoke all on public.billing_settings from public, anon, authenticated;
revoke all on public.billing_document_counters from public, anon, authenticated;
revoke all on public.billing_catalog_items from public, anon, authenticated;
revoke all on public.billing_invoices from public, anon, authenticated;
revoke all on public.billing_invoice_items from public, anon, authenticated;
revoke all on public.billing_payments from public, anon, authenticated;
revoke all on public.billing_credit_notes from public, anon, authenticated;
revoke all on public.billing_credit_note_items from public, anon, authenticated;

revoke all on public.perklyn_user_directory from public, anon, authenticated;
grant select on public.perklyn_user_directory to service_role;
