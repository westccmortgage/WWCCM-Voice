-- Read-only, aggregate reconciliation after each approved call. Run with an
-- administrator/migrator connection; the runtime login intentionally cannot
-- read these private tables. This query returns no caller or reply text.

select
  c.suite_id,
  count(*) as calls_claimed,
  count(*) filter (where c.closed_at is not null) as calls_closed,
  coalesce(sum(c.turns_used), 0) as turns_used,
  coalesce(sum(c.provider_requests), 0) as provider_requests,
  coalesce(sum(c.reserved), 0) as reserved_usd,
  coalesce(sum(c.settled), 0) as settled_usd,
  coalesce(sum(c.held), 0) as held_usd
from core_v2_voice_private.core_v2_voice_relay_calls c
where c.suite_id = 'emma-owner-20261006'
group by c.suite_id;

select
  t.money_state,
  t.reply_state,
  t.delivery,
  count(*) as turns,
  coalesce(sum(t.reserved_usd), 0) as reserved_usd,
  coalesce(sum(t.settled_usd), 0) as settled_usd
from core_v2_voice_private.core_v2_voice_relay_turns t
join core_v2_voice_private.core_v2_voice_relay_calls c
  using (call_identity_digest)
where c.suite_id = 'emma-owner-20261006'
group by t.money_state, t.reply_state, t.delivery
order by t.money_state, t.reply_state, t.delivery;
