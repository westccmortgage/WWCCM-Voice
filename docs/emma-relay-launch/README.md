# Emma ConversationRelay launch packet

Prepared from reviewed branch tips:

- `westccmortgage/WWCCM-Voice` `claude/emma-relay` at `222910b18068743bb95289f99424e35f86073752`
- `westccmortgage/measured-decision-ai` `claude/emma-relay-core` at `543d61521d2ab9baf845cd3c251139b3068b8079`

The local preparation adds a type-safety fix and launch documentation on top
of those tips. No production state, access, routing, or paid service has been
changed.

## Immutable scope

- Existing Twilio number only; no purchase.
- Supabase project `hbqlhplgqwuesrovbiye` only.
- Render service `srv-davi48navr4c73c470q0` only.
- One exact owner caller, at most 3 admitted calls, 105 seconds/call, 6 turns,
  6 model requests, 4,000 TTS characters, and no retry.
- Pinned model `claude-haiku-4-5-20251001`, 8,000 input-token ceiling and 300
  output-token ceiling per request.
- Existing `$0.036` unknown hold remains untouched.

## Inputs still required from the owner

1. Exact owner caller number in E.164 format. Store the number only in Render;
   store only its lowercase SHA-256 digest in Core.
2. Verified business hours and callback commitment. Until supplied,
   `CORE_V2_RELAY_BUSINESS_FACTS={}` and Emma must not state either fact.
3. Confirmation in Twilio Console that the AI/ML Addendum is accepted, the
   account can use ConversationRelay, the account tariff is `$0.07/minute` or
   lower, and the existing number's Voice webhook is the Render `/voice` URL.
4. A fresh HMAC secret entered directly into Supabase and Render, never chat.

The included admission policy expires at `2026-10-07T06:59:59.000Z`
(23:59:59 PDT on 2026-10-06). Do not install it after that time; create a new
suite id and expiry for the approved test day.

## Cost envelope to approve

Per call at the configured ceilings:

- Twilio ConversationRelay: 2 billable minutes x `$0.07` = `$0.140`.
- Twilio inbound US local Voice: 2 billable minutes x `$0.0085` = `$0.017`.
- Claude reservation: 6 x `$0.0115` = `$0.069`.
- Total before tax: `$0.226`; three calls: `$0.678`.

`MAX_CALL_SECONDS=105` leaves 15 seconds before a third rounded Twilio minute.
The requested hard authorization should remain `$1.00` total new spend,
including taxes/rounding. If the authenticated Twilio account price differs,
stop and recalculate before activation.

## Release sequence

Every numbered phase is a separate checkpoint. Phases 2-4 require explicit
approval because they change production state, credentials/access, routing,
or incur paid calls.

### 1. Completed local proof (no approval needed)

- Verify branch SHA and clean diff.
- Run Voice tests and the full offline relay acceptance.
- Apply the two voice migrations twice to temporary PostgreSQL 16.
- Run the relay integration through `voice_runtime_login` and verify it has
  function execution only, not table reads.
- Run strict TypeScript checking including `core-v2-voice-relay/index.ts`.

### 2. Dormant deployment (approval required)

1. Reconcile the remote migration ledger. Apply only
   `20261006120000_core_v2_voice_relay.sql`; stop on any unexpected pending
   migration. Do not merge/deploy all of `measured-decision-ai`.
2. Deploy only Edge Function `core-v2-voice-relay`. Its configuration keeps
   `verify_jwt=false` because the function verifies its own timestamped HMAC.
3. Install the private values from `supabase.env.example` with all three
   activation switches still `false`.
4. Merge/deploy the Voice branch while `VOICE_TRANSPORT=media-stream`; verify
   the existing service remains healthy before changing transport.

### 3. Arm and route the isolated test (approval required)

1. Confirm the exact Twilio tariff/addendum/webhook and the Anthropic model is
   still Active. The current lifecycle commitment is only through 2026-10-15.
2. Set the Core and Render templates with the same HMAC secret and the exact
   owner identity. Set verified business facts or keep `{}`.
3. Core activation order:
   `CORE_V2_RELAY_ALLOW_PROVIDER_NETWORK=true`, then
   `CORE_V2_RELAY_ALLOW_PAID_CALLS=true`, then
   `CORE_V2_RELAY_ENABLED=true`.
4. Render activation order: apply the final values in `render.env.example`,
   with `VOICE_TRANSPORT=relay` and `VOICE_RUNTIME_ENABLED=true` last.
5. `GET /ready` must return HTTP 200 with `ready:true` and an empty `missing`
   array. Do not place a call if it does not.

### 4. Paid acceptance (separate approval required)

Use the exact owner phone only. Call 1 covers greeting, name/goal, corrected
caller fact, unsupported current-rate question, broker request, one barge-in,
and goodbye. Call 2 covers verified business facts (only if configured), two
intentional identical `yes` turns, and goodbye. Call 3 is reserve capacity,
not permission to retry a failed scenario.

After every call, run `reconcile.sql` and compare Core settled/held totals to
Anthropic usage and Twilio billed minutes. Stop immediately on any held or
reserved balance, unsupported figure, stale reply, duplicate provider request,
unexpected third billable minute, pricing discrepancy, or failed scenario.

## Rollback

1. Render: `VOICE_TRANSPORT=media-stream`. If the old path is not meant to
   receive traffic, use `VOICE_RUNTIME_ENABLED=false` instead.
2. Core: `CORE_V2_RELAY_ENABLED=false`, then
   `CORE_V2_RELAY_ALLOW_PAID_CALLS=false`, then
   `CORE_V2_RELAY_ALLOW_PROVIDER_NETWORK=false`.
3. Preserve database rows and any hold for reconciliation. Do not delete or
   reverse the additive migration.
4. Do not retry a failed or ambiguous paid request.
