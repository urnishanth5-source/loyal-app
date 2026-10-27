insert into public.kv_store_3a123995(key, value)
select
  'rfid-identifier:' || cards.identifier_hash,
  cards.value || jsonb_build_object(
    'cardKey', cards.key,
    'reservationStatus', 'reserved'
  )
from (
  select distinct on (value->>'identifierHash')
    key,
    value,
    value->>'identifierHash' as identifier_hash
  from public.kv_store_3a123995
  where key like 'rfid-card:%'
    and value->>'identifierHash' is not null
    and value->>'status' in ('active', 'blocked')
  order by
    value->>'identifierHash',
    value->>'activatedAt' asc nulls last
) as cards
on conflict (key) do nothing;

create or replace function public.perklyn_activate_rfid_card(
  p_card_key text,
  p_registry_key text,
  p_card_value jsonb,
  p_customer_id text,
  p_owner_id text,
  p_business_id bigint,
  p_replaced_card_key text default null,
  p_replaced_registry_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_registry jsonb;
  v_replaced_card jsonb;
  v_replaced_registry jsonb;
  v_replaced_value jsonb;
  v_now timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(lock_id)
  from (
    select distinct unnest(array[
      hashtext(p_registry_key),
      hashtext(coalesce(p_replaced_registry_key, p_registry_key))
    ]) as lock_id
  ) as locks
  order by lock_id;

  select value into v_registry
  from public.kv_store_3a123995
  where key = p_registry_key
  for update;

  if v_registry is not null
     and coalesce(v_registry->>'reservationStatus', 'reserved') = 'reserved' then
    if v_registry->>'ownerId' = p_owner_id
       and (v_registry->>'businessId')::bigint = p_business_id
       and v_registry->>'customerId' = p_customer_id then
      return jsonb_build_object('result', 'already_active', 'card', v_registry);
    end if;
    return jsonb_build_object('result', 'already_linked', 'card', v_registry);
  end if;

  if p_replaced_card_key is not null then
    select value into v_replaced_card
    from public.kv_store_3a123995
    where key = p_replaced_card_key
    for update;

    select value into v_replaced_registry
    from public.kv_store_3a123995
    where key = p_replaced_registry_key
    for update;

    if v_replaced_card is null
       or v_replaced_card->>'status' <> 'active'
       or v_replaced_card->>'ownerId' <> p_owner_id
       or (v_replaced_card->>'businessId')::bigint <> p_business_id
       or v_replaced_card->>'customerId' <> p_customer_id
       or v_replaced_registry is null
       or coalesce(v_replaced_registry->>'reservationStatus', 'reserved') <> 'reserved' then
      return jsonb_build_object('result', 'invalid_replacement');
    end if;
  end if;

  insert into public.kv_store_3a123995(key, value)
  values (p_card_key, p_card_value)
  on conflict (key) do update set value = excluded.value;

  insert into public.kv_store_3a123995(key, value)
  values (
    p_registry_key,
    p_card_value || jsonb_build_object(
      'cardKey', p_card_key,
      'reservationStatus', 'reserved'
    )
  )
  on conflict (key) do update set value = excluded.value;

  if p_replaced_card_key is not null then
    v_replaced_value := v_replaced_card || jsonb_build_object(
      'status', 'replaced',
      'replacedAt', v_now,
      'replacedByCardId', p_card_value->>'id'
    );
    update public.kv_store_3a123995
    set value = v_replaced_value
    where key = p_replaced_card_key;

    update public.kv_store_3a123995
    set value = v_replaced_registry || jsonb_build_object(
      'reservationStatus', 'released',
      'releasedAt', v_now,
      'replacedByCardId', p_card_value->>'id'
    )
    where key = p_replaced_registry_key;
  end if;

  return jsonb_build_object('result', 'activated', 'card', p_card_value);
end;
$$;

revoke all on function public.perklyn_activate_rfid_card(text, text, jsonb, text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.perklyn_activate_rfid_card(text, text, jsonb, text, text, bigint, text, text) to service_role;
