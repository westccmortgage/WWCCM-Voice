# Local bounded pilot guards — no release performed

Base claude/emma-relay6d991ef includes its existing zero-cost preflight; remote main3870b8e has no guard fixes. Only Voice changes; Core relayv3adb0db7 and video functions remain untouched.

First known provider failure closes the call immediately, reports the unavailable line, records close and ignores later prompts. No repeat request.

After Twilio signature and exact owner check, before Core admission/ConversationRelay TwiML, set the live call's TimeLimit to105seconds using Twilio Call resource Update API. It is a total call cap independent of WebSocket setup. Fixed official HTTPS origin/account/call path, no redirects, one attempt,5second timeout, bounded response and exact sid/account binding. Unsupported limit, transport ambiguity, invalid readback or missing credential returns Hangup; no Core admission/model purchase. Existing session timer remains a second fence.

Official source checked2026-10-06: https://www.twilio.com/docs/voice/api/call-resource#update-a-call-resource . Update accepts TimeLimit, described as maximum call duration subject to account constraints. No invented Connect/ConversationRelay attribute. No actual CallUpdate executed in this local tranche; tests mock it. Production must confirm the account accepts105 during the first authorized owner call; failure ends it and requires stop, never a retry.

Uses existing Render TWILIO_AUTH_TOKEN in runtime without printing it; TWILIO_ACCOUNT_SID must be securely present and match the signed webhook account. No new API key, login or persistent privilege. If AccountSID missing, enter the existing account identifier in Render; do not rotate token or create access.

Focused13/13; existing offline acceptance11/11 with mocked model,Core and CallUpdate; no paid requests. Offline measured p95717ms includes scripted700ms model delay and is not live phone latency proof.

Cost: percall model6x0.0115=0.069; conservatively independently rounded Relay2x0.07=0.14 and inbound2x0.0085=0.017, total0.226; three0.678, leaving0.322 fee/tax slack within approved1USDnewspend. Existing0.036unknownhold is separate. Still requires authenticated tariff/rounding/fee confirmation;105total seconds leaves15seconds before third minute. No transfer/outbound/newnumber/recording add-on. CallUpdate changes an existing call's limit, does not create another call or invoke model. Unconfirmed duration means no READY.

Release consequences for parent: remote release NOT authorized yet. Bundle includes readiness+serverguard+textflow+existingpreflight/mock adjustments. A Voice main merge would trigger existing Render automaticdeployment; retain disabled runtime untilexactsource/readiness/securebindings/tariffs verified. No Core deployment/migration/envchange required for this codepatch. Afterfirstfailureofanykind, operator closes paidgates forentiresuite, reconcilesanddoesnotcontinueothercalls. RollbackpreviousVoicemain3870b8e onlywithruntimeoff; neverunwindCoreorunknownhold.
