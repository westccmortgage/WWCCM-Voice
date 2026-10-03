# WWCCM-Voice

Phone agent for **Wallet WCCM** (walletwccm.com). It answers calls with the *same*
mortgage-strategy brain as the website chat — deterministic parsing, intake order,
and the verified cash-to-close calculators — so the numbers on the phone and on
the site always match.

```
Caller ──PSTN──▶ Twilio ──Media Stream (WS)──▶ WWCCM-Voice ──▶ Deepgram (STT)
                                                    │
                                                    ▼
                                      Wallet WCCM brain  (/api/voice-advisor-turn)
                                      parse → intake order → verified numbers
                                      → phrase (Anthropic OR Measured Decision V2 gateway)
                                                    │
                                                    ▼
Caller ◀──audio──  Twilio ◀──Media Stream (WS)──  ElevenLabs (TTS, mu-law/8000)
```

This process only moves **audio and text**. It never computes a mortgage number.
All figures, compliance language, and model/provider choices live in the brain
(the `image` repo). No rates, approvals, or guarantees are ever spoken.

## How it works

1. Twilio hits **`POST /voice`** → we return TwiML that opens a bidirectional
   Media Stream to **`wss://<host>/media`**.
2. On stream start the agent speaks the required disclosures — California is a
   **two-party consent** state for recording, and the caller is told they are
   speaking with an **AI assistant, not a licensed loan officer** — then greets.
3. Caller audio (mu-law/8000) streams to **Deepgram**; each final utterance goes
   to the brain at **`VOICE_TURN_URL`**; the reply is spoken back via
   **ElevenLabs** (requested directly as `ulaw_8000`, so no transcoding).
4. **Barge-in:** if the caller talks while the agent is speaking, TTS is aborted
   and Twilio's audio buffer is cleared.

## Why a standalone server (not a Netlify function)

Twilio Media Streams need a **persistent WebSocket**; serverless functions can't
hold one open. This runs as an always-on Node service (Render Web Service).

## Environment variables

See [`.env.example`](./.env.example). Secrets are set in the Render dashboard.

| Var | What |
| --- | --- |
| `VOICE_RUNTIME_ENABLED` | Master activation gate; must remain `false` until all release and budget gates pass |
| `VOICE_ADMISSION_MODE` | Independent `disabled` / bounded-owner-`test` / full-`production` admission gate |
| `VOICE_TEST_ALLOWED_CALLER` | Exact owner E.164 caller allowed in `test` mode |
| `VOICE_TEST_MAX_CALLS` / `VOICE_TEST_MAX_VOICE_WEBHOOKS` / `VOICE_TEST_MAX_BRAIN_REQUESTS` | Whole-suite limits required in `test` mode |
| `VOICE_TURN_URL` | Brain endpoint: `https://walletwccm.com/api/voice-advisor-turn` |
| `VOICE_SHARED_SECRET` | Must equal `VOICE_SHARED_SECRET` on the Netlify site |
| `AGENT_LANGUAGE` | `en` \| `ru` \| `es` \| `zh` |
| `DEEPGRAM_API_KEY` / `DEEPGRAM_MODEL` / `DEEPGRAM_LANGUAGE` | Speech-to-text |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL_ID` | Text-to-speech |
| `TWILIO_AUTH_TOKEN` | Required — verifies `/voice`, `/media`, and binds each media stream to its signed call |
| `MAX_CALL_SECONDS` / `MAX_CONVERSATION_TURNS` / `MAX_TTS_CHARACTERS` | Hard per-call provider-usage ceilings, checked before provider work |

### Local-only Cloudflare speech adapter

The code includes a disabled provider-neutral path for Cloudflare-hosted
`@cf/deepgram/nova-3` STT and `@cf/deepgram/aura-1` TTS through AI Gateway. The
deployed default remains `SPEECH_PROVIDER=legacy`; do not switch production until
Workers AI entitlement, gateway authentication, and expected billing are
explicitly verified.

To select it after approval, set `SPEECH_PROVIDER=cloudflare-workers-ai` plus
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, and
`CLOUDFLARE_AI_GATEWAY_TOKEN`. It requests raw, containerless G.711 mu-law at
8 kHz for direct Twilio playback. A prior text-model request through the same
gateway does not establish that the token is authorized for Workers AI speech.
The deterministic Wallet WCCM brain still owns every mortgage number and reply;
the speech adapter only transcribes and synthesizes audio.

Remaining rollout gates are external and intentionally untested here: the token
must authenticate the named AI Gateway, the same Cloudflare account must be
entitled to run the two Workers AI partner models, and billing/spend approval
must exist for their metered usage. Offline readiness validates only that the
three configuration fields are nonempty; it does not claim those permissions or
credits are valid.

### Which AI model speaks?

The legacy production phone path uses deterministic engine copy by default. The
new conversational Core path is dormant unless `CORE_V2_VOICE_ENABLED=true` is
explicitly set on the Wallet WCCM site after its service credential, durable
state, provider policy, and spend limits are installed. Core owns its model
allowlist and price snapshot; Render never receives that credential.

- `WWCCM_MODEL` — legacy phrasing model id only.
- `WWCCM_AI_PROVIDER` — `anthropic` (default, direct) or `cf-anthropic` /
  `cf-openai` / `cf-google` to route through the **Measured Decision V2**
  Cloudflare AI Gateway (`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_GATEWAY_ID` /
  `CLOUDFLARE_AI_GATEWAY_TOKEN`). The phone agent needs no change to switch.

## Deploy to Render

1. Push this repo to GitHub (`westccmortgage/wwccm-voice`).
2. In Render: **New → Web Service** (or **Blueprint** from `render.yaml`), pick
   this repo. Use the **Starter** plan (always-on) — *not Free*, which sleeps and
   would make callers wait 30–50s.
3. Set the `sync: false` env vars (secrets) in the dashboard.
4. Deploy. Render's process-liveness check is `GET /health`. Operational
   readiness is `GET /ready`; it returns 503 until every required credential is
   configured. `/voice` and `/media` also remain fail-closed while unready.

## Point Twilio at it

In the Twilio Console, on your phone number's **Voice** configuration:

- **A call comes in** → Webhook → `https://<your-render-host>/voice` → **HTTP POST**.

That's it — the TwiML we return opens the media stream automatically.

## Local development

```bash
cp .env.example .env   # fill in keys
npm install
npm run dev
```

Expose it to Twilio with a tunnel (e.g. `ngrok http 8080`) and use the tunnel's
`https` URL as the Twilio Voice webhook. The WebSocket URL is derived from the
request host automatically.

## Compliance notes

- Disclosures are spoken **before** any scenario questions (see `src/config.mjs`,
  `DISCLOSURES`). Keep the recording-consent and AI-disclosure lines.
- The agent presents **estimates only**, defers to a **licensed broker**, and
  never states a rate, approval, or guarantee — enforced in the brain.
- Never ask for SSN, full account numbers, or date of birth on the call.
- Keep the conversational runtime disabled until both the provider budget and
  production usage ceilings are approved. A bounded acceptance call also
  requires `VOICE_ADMISSION_MODE=test`, the owner's exact caller number, and
  separately approved call, webhook, Core-request, duration, turn, and TTS caps.

## Files

| File | Role |
| --- | --- |
| `src/server.mjs` | Express webhook + Media Stream WebSocket, call orchestration |
| `src/deepgram.mjs` | Deepgram live STT socket |
| `src/elevenlabs.mjs` | ElevenLabs streaming TTS (`ulaw_8000`) |
| `src/speech.mjs` | Provider-neutral STT/TTS selection seam |
| `src/cloudflare-speech.mjs` | Disabled Cloudflare Workers AI Nova-3/Aura adapter |
| `src/brain.mjs` | Client for the advisor brain (`/api/voice-advisor-turn`) |
| `src/config.mjs` | Env config + multilingual disclosures/greeting |
| `render.yaml` | Render Blueprint (always-on Web Service) |
