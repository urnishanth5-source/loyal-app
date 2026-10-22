create or replace function public.perklyn_create_nfc_issue(
  p_active_key text,
  p_issue_key text,
  p_issue_value jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active jsonb;
  v_current jsonb;
  v_issue jsonb;
  v_now timestamptz := clock_timestamp();
begin
  select value into v_active
  from public.kv_store_3a123995
  where key = p_active_key
  for update;

  if v_active is null or v_active->>'status' <> 'active' then
    return jsonb_build_object('result', 'inactive_card');
  end if;

  if coalesce(v_active->>'currentIssueKey', '') <> '' then
    select value into v_current
    from public.kv_store_3a123995
    where key = v_active->>'currentIssueKey'
    for update;

    if v_current->>'status' = 'pending' and (v_current->>'expiresAt')::timestamptz > v_now then
      return jsonb_build_object('result', 'active_issue_exists', 'issue', v_current);
    elsif v_current->>'status' = 'pending' then
      v_current := jsonb_set(jsonb_set(v_current, '{status}', '"expired"'), '{expiredAt}', to_jsonb(v_now));
      update public.kv_store_3a123995 set value = v_current where key = v_active->>'currentIssueKey';
    end if;
  end if;

  v_issue := p_issue_value
    || jsonb_build_object('status', 'pending', 'createdAt', v_now, 'expiresAt', v_now + interval '5 minutes');
  insert into public.kv_store_3a123995(key, value) values (p_issue_key, v_issue);
  v_active := v_active || jsonb_build_object('currentIssueKey', p_issue_key, 'updatedAt', v_now);
  update public.kv_store_3a123995 set value = v_active where key = p_active_key;
  return jsonb_build_object('result', 'created', 'issue', v_issue, 'serverNow', v_now);
end;
$$;

create or replace function public.perklyn_claim_nfc_issue(
  p_active_key text,
  p_issue_key text,
  p_membership_key text,
  p_membership_seed jsonb,
  p_claimant_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active jsonb;
  v_issue jsonb;
  v_membership jsonb;
  v_now timestamptz := clock_timestamp();
  v_amount integer;
  v_balance bigint;
  v_nfc_points bigint;
  v_created boolean := false;
begin
  select value into v_active from public.kv_store_3a123995 where key = p_active_key for update;
  if v_active is null or v_active->>'status' <> 'active' or v_active->>'currentIssueKey' <> p_issue_key then
    return jsonb_build_object('result', 'not_current');
  end if;

  select value into v_issue from public.kv_store_3a123995 where key = p_issue_key for update;
  if v_issue is null then return jsonb_build_object('result', 'not_found'); end if;
  if v_issue->>'status' <> 'pending' then
    return jsonb_build_object('result', v_issue->>'status', 'issue', v_issue);
  end if;
  if (v_issue->>'expiresAt')::timestamptz <= v_now then
    v_issue := v_issue || jsonb_build_object('status', 'expired', 'expiredAt', v_now);
    update public.kv_store_3a123995 set value = v_issue where key = p_issue_key;
    return jsonb_build_object('result', 'expired', 'issue', v_issue);
  end if;

  v_amount := (v_issue->>'amount')::integer;
  v_issue := v_issue || jsonb_build_object(
    'status', 'claimed',
    'claimedAt', v_now,
    'claimedByUserId', p_claimant_user_id,
    'claimedCustomerName', p_membership_seed->>'customerName',
    'claimedCustomerPhone', p_membership_seed->>'phone'
  );
  update public.kv_store_3a123995 set value = v_issue where key = p_issue_key;

  select value into v_membership from public.kv_store_3a123995 where key = p_membership_key for update;
  if v_membership is null then
    v_membership := p_membership_seed;
    v_created := true;
  end if;
  v_balance := coalesce((v_membership->>'points')::bigint, 0) + v_amount;
  v_nfc_points := coalesce((v_membership->>'nfcPoints')::bigint, 0) + v_amount;
  v_membership := v_membership || jsonb_build_object(
    'points', v_balance,
    'nfcPoints', v_nfc_points,
    'updatedAt', v_now
  );
  insert into public.kv_store_3a123995(key, value) values (p_membership_key, v_membership)
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object(
    'result', 'claimed',
    'issue', v_issue,
    'balance', v_balance,
    'nfcPoints', v_nfc_points,
    'membershipCreated', v_created,
    'serverNow', v_now
  );
end;
$$;

create or replace function public.perklyn_cancel_nfc_issue(
  p_active_key text,
  p_issue_key text,
  p_owner_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_active jsonb;
  v_issue jsonb;
  v_now timestamptz := clock_timestamp();
begin
  select value into v_active from public.kv_store_3a123995 where key = p_active_key for update;
  select value into v_issue from public.kv_store_3a123995 where key = p_issue_key for update;
  if v_active is null or v_issue is null or v_active->>'currentIssueKey' <> p_issue_key then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_issue->>'ownerId' <> p_owner_id::text then
    return jsonb_build_object('result', 'forbidden');
  end if;
  if v_issue->>'status' <> 'pending' then
    return jsonb_build_object('result', v_issue->>'status', 'issue', v_issue);
  end if;
  if (v_issue->>'expiresAt')::timestamptz <= v_now then
    v_issue := v_issue || jsonb_build_object('status', 'expired', 'expiredAt', v_now);
    update public.kv_store_3a123995 set value = v_issue where key = p_issue_key;
    return jsonb_build_object('result', 'expired', 'issue', v_issue, 'serverNow', v_now);
  end if;
  v_issue := v_issue || jsonb_build_object('status', 'cancelled', 'cancelledAt', v_now);
  update public.kv_store_3a123995 set value = v_issue where key = p_issue_key;
  return jsonb_build_object('result', 'cancelled', 'issue', v_issue, 'serverNow', v_now);
end;
$$;

revoke all on function public.perklyn_create_nfc_issue(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.perklyn_claim_nfc_issue(text, text, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.perklyn_cancel_nfc_issue(text, text, uuid) from public, anon, authenticated;
grant execute on function public.perklyn_create_nfc_issue(text, text, jsonb) to service_role;
grant execute on function public.perklyn_claim_nfc_issue(text, text, text, jsonb, uuid) to service_role;
grant execute on function public.perklyn_cancel_nfc_issue(text, text, uuid) to service_role;
