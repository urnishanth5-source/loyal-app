create or replace view public.perklyn_user_directory
with (security_barrier = true)
as
select
  users.id as user_id,
  profiles.value->>'phone' as login_phone,
  profiles.value->>'name' as user_name,
  profiles.value->>'role' as user_role,
  nullif(profiles.value->>'businessName', '') as business_name,
  users.email as login_email,
  users.created_at as account_created_at,
  users.last_sign_in_at,
  users.email_confirmed_at,
  users.recovery_sent_at as password_reset_sent_at,
  case
    when coalesce(users.encrypted_password, '') <> '' then 'set'
    else 'not_set'
  end as password_status,
  case
    when users.banned_until is not null and users.banned_until > now() then 'suspended'
    else 'active'
  end as account_status
from auth.users as users
left join public.kv_store_3a123995 as profiles
  on profiles.key = 'profile:' || users.id::text;

comment on view public.perklyn_user_directory is
  'Administrative user directory. Passwords and password hashes are intentionally excluded.';

revoke all on public.perklyn_user_directory from public, anon, authenticated;
grant select on public.perklyn_user_directory to service_role;
