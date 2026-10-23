create or replace function public.perklyn_activate_rfid_card(
  p_card_key text,
  p_card_value jsonb,
  p_customer_id text,
  p_reassign boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing jsonb;
begin
  perform pg_advisory_xact_lock(hashtext(p_card_key));
  select value into v_existing from public.kv_store_3a123995 where key = p_card_key for update;

  if v_existing is not null and v_existing->>'status' = 'active'
     and v_existing->>'customerId' <> p_customer_id and not p_reassign then
    return jsonb_build_object('result', 'already_linked', 'card', v_existing);
  end if;

  if v_existing is not null and v_existing->>'status' = 'active'
     and v_existing->>'customerId' = p_customer_id then
    return jsonb_build_object('result', 'already_active', 'card', v_existing);
  end if;

  if v_existing is not null and v_existing->>'status' in ('blocked', 'replaced') and not p_reassign then
    return jsonb_build_object('result', 'inactive_card', 'card', v_existing);
  end if;

  insert into public.kv_store_3a123995(key, value) values (p_card_key, p_card_value)
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('result', 'activated', 'card', p_card_value);
end;
$$;

create or replace function public.perklyn_rfid_points_transaction(
  p_membership_key text,
  p_transaction_key text,
  p_delta integer,
  p_transaction_value jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_membership jsonb;
  v_existing jsonb;
  v_balance bigint;
  v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtext(p_transaction_key));
  select value into v_existing from public.kv_store_3a123995 where key = p_transaction_key;
  if v_existing is not null then
    return jsonb_build_object('result', 'duplicate', 'transaction', v_existing, 'balance', v_existing->'balanceAfter');
  end if;

  select value into v_membership
  from public.kv_store_3a123995
  where key = p_membership_key
  for update;
  if v_membership is null then return jsonb_build_object('result', 'membership_not_found'); end if;

  v_balance := coalesce((v_membership->>'points')::bigint, 0) + p_delta;
  if v_balance < 0 then
    return jsonb_build_object('result', 'insufficient_points', 'balance', coalesce((v_membership->>'points')::bigint, 0));
  end if;

  p_transaction_value := p_transaction_value || jsonb_build_object('balanceAfter', v_balance, 'occurredAt', v_now);
  v_membership := v_membership || jsonb_build_object(
    'points', v_balance,
    'updatedAt', v_now,
    'transactions', jsonb_build_array(p_transaction_value) || coalesce(v_membership->'transactions', '[]'::jsonb)
  );
  update public.kv_store_3a123995 set value = v_membership where key = p_membership_key;
  insert into public.kv_store_3a123995(key, value) values (p_transaction_key, p_transaction_value);
  return jsonb_build_object('result', 'completed', 'transaction', p_transaction_value, 'balance', v_balance);
end;
$$;

revoke all on function public.perklyn_activate_rfid_card(text, jsonb, text, boolean) from public, anon, authenticated;
revoke all on function public.perklyn_rfid_points_transaction(text, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.perklyn_activate_rfid_card(text, jsonb, text, boolean) to service_role;
grant execute on function public.perklyn_rfid_points_transaction(text, text, integer, jsonb) to service_role;
