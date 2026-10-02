# Emma V2 conversational contract (draft)

Status: phone transport and the reviewed Core integration contract are
implemented on release branches. Production activation remains disabled until
the hosted migration, least-privilege service credential, provider policy,
spend limits, and paid acceptance gates are approved and completed.

## Root cause

The current phone server clears buffered audio on barge-in, but the brain request sets `phrase: false`. The authenticated endpoint therefore runs the deterministic intake parser and always appends the next questionnaire prompt. Conversation history is transported only for optional AI phrasing and is ignored in the deployed path. A caller's hearing check, detour, correction, or unrelated question is consequently treated as failure to answer the pending mortgage field, after which that field is asked again.

The previous turn loop also dropped finalized utterances while a brain request was in flight. Generated assistant text was added to history before there was evidence the caller heard it. Twilio documents that `clear` causes pending `mark` messages to be returned for discarded buffered audio, so a mark by itself cannot establish delivery.

## Required turn contract

1. Acoustic gate: on credible caller speech, invalidate the response epoch, cancel generation/TTS, and clear Twilio playback immediately.
2. Semantic gate: resolve pause, stop, hearing repair, correction, question, and handoff before intake. The last pending field is context, not a forced schema.
3. Latest-turn wins: a late brain, tool, or TTS result from an obsolete revision must not update facts or enqueue audio.
4. Delivery truth: track generated, queued, played, interrupted, and cleared output separately. A clear-triggered mark is not heard text.
5. State integrity: facts carry entity, unit, actual/scenario scope, status, source turn, revision, superseded revision, and derived dependencies.
6. Application is optional: answer the current request first. A question may be null. Offer a gentle choice to continue asking questions or move toward an application.
7. Grounding: deterministic tools own calculations. Current rates/products, approval, transfer, weather, submissions, and credit actions require an authorized successful tool. No model may invent them.
8. Human control: pause, end, no-submission, and human-help requests suspend intake immediately.

## Consultative mortgage flow

The required English opening is: “Hi, you've reached West Coast Capital
Mortgage. This call may be recorded for quality. My name is Emma. I'm your
A I assistant, not a licensed loan officer. Any figures are planning
estimates, and a licensed broker reviews every scenario. How can I help you
today?” Company identification is spoken once. The opening must discover the
caller's goal and must not assume a purchase or ask for a purchase price.

Use: caller goal → answer the present question → ask the next consequential question only when useful → compare a small set of alternatives and downsides → reflect priorities or repair misunderstanding → offer an optional next step.

Do not make the caller choose a product first. For a HELOC/home-equity loan versus cash-out refinance, compare the retained first mortgage plus the second lien against replacing the entire first balance. Use the same desired net proceeds and horizon; show payments, fees, variable-rate/repayment-transition risk, and remaining debt separately. A low first-mortgage rate matters but is not an automatic preserve-the-first rule.

## Local controls implemented in this branch

- bounded finalized-utterance queue with monotonically increasing turn revisions;
- cancellation of in-flight brain work when a newer caller turn arrives;
- rejection of superseded brain results before profile mutation or speech;
- explicit `pending`, `interrupted`, and `delivered` assistant-history states;
- late clear-triggered marks cannot turn interrupted speech into delivered dialogue;
- deterministic hearing-check, pause, and voluntary-resume controls;
- priority/coalesced human controls: terminal goodbye, latest pause/resume,
  and repeated hearing checks cannot be displaced or grow the queue;
- a real paused state that withholds ordinary queued speech until resume;
- one response at a time: queued work resumes only after playback evidence,
  failure, or a caller barge-in;
- explicit failed delivery state when TTS or mark generation does not complete;
- authenticated `wwccm.voice.v2` request metadata and delivery-aware prior history;
- current user utterance is no longer duplicated in history and request text.

## Core integration dependency

The Core release branch now contains an isolated authenticated endpoint,
transactional state/replay fencing, budget reservation and settlement, a model
allowlist and pricing snapshot, a strict response plan, and deterministic tool
boundaries. The Netlify adapter stays dormant and fail-closed until every
required environment value is present and its explicit enable flag is true.
`phrase: false` remains the legacy production default.

## Exact Core V2 integration boundary

Read-only inspection of `westccmortgage/measured-decision-ai` main at
`9f77c6b840eae632cc1c67f5e165e4889058c3c7` found two important incompatibilities:

- `core-v2.work-order.1` only accepts the `measured-decision`, `ceo-admin`, and
  `markevita` surfaces and fixes work-order authority to `PROPOSE` with an
  authorized budget of zero. A voice call must not be disguised as one of
  those surfaces or use that zero-budget envelope to imply paid authority.
- `ProviderExecutor` is deliberately history-free and forces the batch
  `AgentResultEnvelope` schema. It cannot be used as a conversational model
  by merely changing its prompt. The voice path needs its own strict response
  schema while reusing the runtime's fail-closed configuration, HTTPS egress,
  usage normalization, no-blind-retry, and reservation principles.

The isolated implementation is owned by these Core files:

- `supabase/functions/core-v2-voice-turn/index.ts` — bounded POST endpoint,
  service authentication, request-id idempotency, deadline, and response map;
- `supabase/functions/_shared/core-v2/voice-auth.ts` — timestamped HMAC
  verification and replay-window checks for the Netlify brain service;
- `workers/core-v2-voice/contracts.ts` — closed `VoiceTurnInput`, durable
  `DialogueState`, `FactPatch`, `ToolReceipt`, and `VoiceTurnPlan` schemas;
- `workers/core-v2-voice/state-store.ts` — call/session ownership,
  `state_revision` compare-and-swap, deduplication, and append-only events;
- `workers/core-v2-voice/orchestrator.ts` — answer-first policy, intent and
  correction handling, optional application transition, tool planning, and
  stale-result rejection;
- `workers/core-v2-voice/provider-text-adapter.ts` — one allowlisted model via
  the existing gateway, strict `VoiceTurnPlan` output, bounded tokens/time,
  usage receipt, and no retry after an unknown outcome;
- `workers/core-v2-voice/grounded-tools.ts` — deterministic mortgage math and
  approved educational knowledge retrieval; unavailable current information
  fails closed;
- `workers/core-v2-voice/budget.ts` — per-turn reservation plus per-call token,
  spend, turn, concurrency, and wall-clock ceilings;
- `workers/core-v2-voice/tests/*.mjs` — the ten semantic gates below as real
  assertions using fixtures, never paid calls;
- the next available `supabase/migrations/*_voice_conversations.sql` — tenant-
  scoped sessions, turn idempotency, append-only events, fact revisions, tool
  receipts, and an atomic budget reservation/settlement door;
- `supabase/config.toml` — register `core-v2-voice-turn`. Because the caller is
  a server rather than a Supabase user, its own HMAC gate is mandatory; do not
  copy the existing unverified JWT-payload helper into this route.

The existing Netlify function remains the public brain adapter. It should
authenticate the phone service exactly as it does now, translate the
`wwccm.voice.v2` request to the Core endpoint, and translate the validated
plan back to the current phone response. Render does not receive Core or
gateway credentials.

Infrastructure still required before activation: apply the reviewed private-
schema migration; create a distinct least-privilege service login; install a
distinct service-signing
secret present only in Netlify and the Core function; the already named
Cloudflare gateway coordinates/token present in Core without exposing their
values; an operator-selected provider/model allowlist and prices; per-call and
per-turn spend/token/time ceilings; Postgres persistence with revision CAS and
idempotency; redacted observability; and approved deterministic/knowledge
tools. No production activation is valid while the ten semantic gates remain
TODO or while the user has not approved a paid operating budget.

## Offline release gates

Passing transport mocks alone is not conversation readiness. The ten semantic
cases remain explicit `test.todo` gates until their separately budgeted real-
model run is approved. Deterministic state/event, database, transport, build,
and security-review gates must pass before that run.

## Research basis

- Twilio Media Streams clear/mark behavior: <https://www.twilio.com/docs/voice/media-streams/websocket-messages>
- CFPB HELOC versus home-equity loan: <https://www.consumerfinance.gov/ask-cfpb/what-is-the-difference-between-a-home-equity-loan-and-a-home-equity-line-of-credit-heloc-en-247/>
- CFPB HELOC booklet, including cash-out refinance comparison: <https://files.consumerfinance.gov/f/documents/cfpb_heloc-brochure_print.pdf>
- Conversation repair and contextual confirmation: <https://developers.google.com/assistant/conversation-design/confirmations>
- Long-tail conversation repair: <https://developers.google.com/assistant/conversation-design/design-for-the-long-tail>
