# Dormant Emma ConversationRelay candidate

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
