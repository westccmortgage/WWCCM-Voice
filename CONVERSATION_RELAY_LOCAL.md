# Emma on Twilio ConversationRelay — current state

Branch `claude/emma-relay` (on top of `codex/emma-conversation-relay-local`, c75ef9b).
Core counterpart: `westccmortgage/measured-decision-ai`, migration
`20261006120000_core_v2_voice_relay.sql` and function `core-v2-voice-relay`.
Nothing here is deployed, armed or wired to a phone number. `main` and the
Render service are unchanged. The `emma-synthetic-20261006-0457:S1` $0.036
unknown hold is untouched.

## Shape

```
caller ─PSTN─ Twilio ConversationRelay (STT, TTS, barge-in)
                │  text over WebSocket (/relay)
                ▼
        Render server.mjs  (VOICE_TRANSPORT=relay)
                │  ONE signed request per final caller utterance
                ▼
        Supabase core-v2-voice-relay
          begin    claim revision, count dispatch, reserve priced ceiling
          model    one plain Messages request (existing registry and gates)
          clear    deterministic: figures, rate quotes, eligibility, actions
          complete settle | release | hold; record what may be said
```

- `/voice` is unchanged as a URL. In relay mode it returns ConversationRelay
  TwiML; the disclosures are Twilio's `welcomeGreeting`, not interruptible.
  The existing admission still admits the call; Core's `claim_session` binds
  it to exactly one stream.
- Render holds no model key, only one new HMAC secret shared with
  `core-v2-voice-relay`. The prototype's backend/text-model modules are
  replaced: the model is chosen by `CORE_V2_RELAY_PROVIDER_REGISTRY` in Core.

## Phone behaviour

| Situation | What Emma does | Money |
| --- | --- | --- |
| Ordinary turn | Speaks the cleared reply | settled once |
| Reply states an unsourced figure, a rate quote, eligibility or a completed action | Reason-specific line; the conversation continues | settled |
| Caller interrupts | Twilio stops TTS; next request records `interrupted` + heard prefix | — |
| Caller speaks while a reply is prepared | Old reply discarded unheard; new words answered next; never two requests in flight | settled |
| Same words twice ("yes", "yes") | Two real turns (no text dedupe) | each settled |
| Redelivered request (same request id) | Core returns `repeated`, no model call, call stops | none |
| Known provider refusal (4xx, 429, 529) | Asks the caller to repeat, once; a second ends the call | released |
| Outcome unknown (transport fault, 5xx, Core > 9 s) | Apology line, call ends, nothing retried | held |
| Turn / request / budget / deadline limit | Polite limit line, call ends | — |
| Goodbye | Goodbye line, no model request, `end` after the line | — |

Per-turn diagnostics in Render and Core logs: HTTP status, provider error
type, provider request id, stage, scrubbed reason, timings (begin / model /
complete, prompt→text). Never caller speech, reply text, keys or raw bodies.

## Verified offline (no network, no paid provider)

- Core: 8 unit tests; PostgreSQL 16 migration assertions; end-to-end run of
  the real repository through the restricted runtime login; strict tsc.
- Render: 72 tests pass (9 existing TODO), including the relay protocol and a
  fixed HMAC vector produced by Core's verifier.
- `scripts/relay-offline-acceptance.mjs` (real server.mjs + real Core handler
  + simulated Twilio + scripted model): 11/11 scenarios pass. With a fixed
  700 ms model delay, prompt→text p95 was 716 ms (system overhead ~16 ms).
  That excludes all real network and Twilio speech time: it is not a latency
  result.

## Not proven until a real call

Conversation quality with the real model, phone first-audio latency, Twilio
account eligibility and tariff for ConversationRelay, and the real
Render→Supabase→Anthropic round trip.

---

# Previous prototype notes (c75ef9b, kept for history)


This branch is LOCAL ONLY. `server.mjs` does not import these modules, return new TwiML, or expose a new route. No provider call, webhook/config/deployment change, key entry or paid-service enablement has occurred. Existing failed campaign is closed. Its `emma-synthetic-20261006-0457:S1` $0.036 unknown hold must remain untouched.

## Working local flow

`createConversationRelay` validates the existing signed Twilio WebSocket handshake and server-issued call lease. A bound setup claims an exclusive backend session. A final speech prompt claims a durable turn, reads facts/history, reserves a priced attempt, claims a one-shot dispatch, calls the text model once, settles raw usage, obtains reply approval, prepares output, awaits the WebSocket send callback, then records transport submission. It never labels text as heard. Partial prompts do not purchase anything. Ordinary replies have no Core voice-specific strict-draft propose/finalize orchestration or full draft/tool schema.

`relay-text-model.mjs` builds one plain Messages request through an injected server transport, with no SDK/env/key lookup. Local candidate model is pinned `claude-haiku-4-5-20251001`, current fastest Anthropic model per official overview, $1/M input and $5/M output. No live model registry is changed. Reverify availability at activation; the current retirement commitment only extends to October 15, 2026. A reservation is consumed once locally; actual provider-submission exclusivity and counting must also be durable in the production exchange. No retries. Valid raw usage from truncated text is preserved for settlement, and that text is never spoken.

`relay-backend.mjs` implements operation/call/suite/hash-bound control readbacks through an injected exchange. It does not implement a DB, authorization server or financial-grounding service. Unknown readback closes new actions while accounting cleanup stays available. Exchange operations are claimSession, claimTurn, reserve, claimDispatch, settle, hold, release, approveReply, prepareReply, markSubmitted and interrupt. None invokes a conversational planner. Core can own their durable transactions and grounded tools without generating every conversational utterance.

Interrupt advances a local epoch and asks the backend to CAS the current request's durable epoch. Late model replies are fenced. Returned raw usage is still settled; missing/unknown usage remains held. Approval/prepare/submit phases are separated. The production backend must atomically fence prepared output against interrupts and record a failed/ambiguous send appropriately. Reconnect/restart is refused by the exclusive session claim, not treated as permission to replay.

Caller facts carry source request/text hash, caller entity, current scope, caller-asserted verification, revision and superseded revision. Only a small English set of explicit first-person facts is extracted; no hypothetical/third-party overwrite, numeric infinity, or “I'm Looking” name inference. Active facts stay in the model context; prose history is bounded to the last eight messages. This is not a complete multilingual or semantic extraction system.

Twilio's documented prompt has no stable event ID. This candidate conservatively coalesces identical final text for the whole exclusive call, even if delayed. That prevents a duplicate purchase but also suppresses an intentional verbatim repetition. A production turn-boundary solution must resolve this tradeoff before acceptance; no claims of full natural turn-taking.

## Release blockers and missing contracts

- No production authenticated exchange/model transport exists for this interface; no new endpoint is installed. Existing `core-v2-voice-turn` is NOT that control interface. Durable owner/session/epoch CAS, replay/idempotency, pricing snapshots, aggregate requests/input/output/reasoning/cost/character caps and exact raw-usage settlement readback must be implemented/reviewed server-side. Local mocks are not proof of these contracts. Never wire an in-memory mock as production authority or broaden runtime DB privileges.
- No concrete mortgage tool/approved-source reply policy is wired. `approveReply` must be authoritative and fail closed on unsupported financial claims; ordinary text output has no fabricated tool evidence. Use Core for calculations, eligibility/current information and authorized external actions with committed receipts. A regex or model self-classification is insufficient.
- Real contextual conversation/latency/interrupt behavior is unproven. Tests establish protocol mechanics with deterministic mocked responses only. Current caps are dormant local interface limits, NOT newly approved paid ceilings.
- Twilio account addendum/eligibility and exact account tariff/rounding/taxes remain unverified. Current Console session is expired. No terms accepted or access granted.

## Bounded activation proposal for parent review

Keep +14243041032 and existing Render host; old SMS +15599615053 unchanged. Implement the thin durable control/evidence adapter locally first. Preserve the disabled Core source build34 (management version36) and its unknown hold. Independently verify bindings/caps/grounding before server wiring. Reuse existing secure server credentials where applicable; any new persistent placement/access requires explicit secure approval, never secret entry in chat.

Owner-only steps: review and, if necessary, accept the Twilio predictive/generative AI/ML addendum in Voice > Settings > Privacy & Security; securely complete any separately approved credential placement. Engineers should first perform a harmless eligibility/tariff readback in the authorized account; no automatic addendum toggle, trial activation, top-up or new number.

After those prerequisites, request separate approval for the exact model-only bounded acceptance and then, only after semantic PASS and independent verdict, a one-owner call. Proposed phone envelope for review: one caller, one admission, <=120 seconds from answer, <=6 turns, <=6 ordinary model requests, <=48k input and 2.4k generated tokens, <=4000 TTS characters, no retry/reconnect. Complex tools require an explicitly budgeted extension or refusal. These are proposed limits, not approval.

Published-price arithmetic only: two Relay minutes $0.14; six Haiku requests at 8k input/400 output, no cache/thinking, model ceiling $0.06. Voice, taxes/fees/rounding, existing hold and prior charges are additional. This $0.20 subtotal is NOT an all-in hard cap. Exact account price and slack must be verified before any paid approval; do not automatically reuse the closed $4 campaign.

No user phone invitation until genuine name/goal/fact retention, corrections/hypotheticals, interrupts, grounding, latency and durable receipts pass. Rollback disables the new mode/runtime and leaves existing routing intact; no blind retry.

Sources checked 2026-10-06:
- https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
- https://www.twilio.com/docs/voice/conversationrelay/onboarding
- https://www.twilio.com/en-us/products/conversational-ai/pricing ($0.07/min, Voice separate)
- https://platform.claude.com/docs/en/models/overview
- https://platform.claude.com/docs/en/about-claude/pricing

Validation: focused 19/19; full Voice 79 pass + 9 existing TODO, zero failures. Dependency installation used the repository lockfile, --ignore-scripts, and a new external-disk npm cache; no shared runtime modified.

## Existing-source audit and diagnostics boundary

Reverified against deployed f1fd74 source (unchanged bundle hash196c4725…): there is a dedicated workers/core-v2-voice/orchestrator.ts. Do not describe it as the universal Core planner. Its grounding RISKY_UNCLAIMED expression includes every digit/$/% and words rate/APR/approved/qualified/eligible/current/transfer/submitted. This conservative filter can withhold unclaimed nonfinancial numbers too. The voice orchestrator uses generic refusal speech for unsuccessful conditions, although limitations retain classifications. Anthropic wire is stream:false; provider-text-adapter discards non-2xx error bodies and exposes only status. Old discarded content cannot be recovered by adding logs now.

In the new approval contract, require evidence for mortgage/financial claims; configured business hours/callback times may use server-owned businessFacts. Transfer/application completion is allowed only after actual authorized tool transition readback. Do not remove auth, replay guards or budget restrictions to improve speech. No raw provider error bodies should be logged: use bounded/redacted structured type/code/status/requestID metadata. This branch does not change existing Core fallback or logging.

Read-only reconciliation of the exact retry window found only a function Boot event and Core HTTP200 execution9702ms, not provider HTTP status/error/usage. Final management version is36 because enabling/disabling approved test config increments function metadata; deployed source remains build34/hash196c4725… unchanged. Unknown settlement stays unknown. No new key/grant or request was made to recover diagnostics.

## Independent local verdict

Independent review approves this as a dormant LOCAL prototype only, not server wiring, release or paid testing. Focused19/19 and full88total/79pass/9existingTODO verified. Production composition must pin the reviewed text adapter: its exported pre-submission error must never be trusted from arbitrary injected models. Dispatch capacity is conservatively consumed before adapter preflight; zero-transport validation releases money safely but is not an exact attempted-provider counter. The durable backend, grounding, transport, prompt identity and context contracts above remain activation blockers.

## One acceptance sheet — proposal only

Ten scenarios below are ten checkpoints, not authorization for ten paid calls. Start offline; any model/phone phase needs a new exact scoped approval. Prefer the existing owner-isolated +14243041032 only after account eligibility is verified. No new number, purchase or routing switch is authorized.

| Scenario | Required pass evidence |
| --- | --- |
| Greeting | Ask the caller's goal before any mortgage questionnaire; one concise greeting, no reset. |
| Name | Retain the caller's stated name across three later turns; do not infer a name from “I'm looking.” |
| Purpose | Retain refinance/compare intent after a digression; next reply addresses that goal. |
| Corrected facts | Supersede rate/income/repair amount with provenance; hypothetical and third-party facts never overwrite caller facts. |
| Financial grounding | Every computed or current financial claim has an authoritative receipt; unsupported qualification/rate claims are withheld. Server-owned hours/callback facts can be answered. |
| Transfer request | Confirm transfer only after an authorized committed tool transition; no transfer purchase in an unapproved suite. |
| Interruptions | Interrupt both generation and playback; zero stale output after fencing, actual usage settled once. |
| Tool timeout and duplication | Timeout is explained; duplicate event/reconnect produces no repeat purchase or tool action. Intentional repeated “yes” remains a valid new turn once event identity is implemented. |
| Goodbye | Stop generation/playback and close admission; no request or output after goodbye/deadline. |
| Provider outage | Known pre-submission failure releases; ambiguous submission holds and stops; no blind retries or invented answer. |

Proposed measured latency targets: final transcript to first submitted text p95<=1500ms over accepted ordinary turns; interrupt to local output cancellation<=200ms; no output submitted after epoch cancellation. These measure server transport, not proof of audio heard. Report actual phone first-audio latency separately from Twilio timestamps; target p95<=2000ms. No latency pass may override grounding, budget or durability failure.

Stop immediately on any wrong caller/session binding, stale reply, unsupported financial claim, duplicate purchase, unknown usage/outcome, unresolved settlement, fee uncertainty, cap breach, provider error or deadline. Close gates and preserve receipts/holds. Never repeat a failed purchase to collect diagnostics.

Cost-cap proposal: one owner call, <=120seconds, <=6ordinary requests, 48kinput/2.4kgenerated tokens/4000TTScharacters, no retries. Published subtotal is $0.20 (Relay $0.14 + Haiku $0.06), before Voice, taxes/fees/rounding and prior liabilities. **No exact account fee quote is currently available, so no defensible all-in dollar cap can yet be proposed for approval.** Obtain the authenticated account tariff/eligibility readback and final liability reconciliation, then calculate and request a separate exact ceiling with explicit reserve. A ten-call campaign would require its own quote, aggregate envelope and approval; the closed $4 campaign provides no authority for it.
