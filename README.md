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
| `VOICE_TURN_URL` | Brain endpoint: `https://walletwccm.com/api/voice-advisor-turn` |
| `VOICE_SHARED_SECRET` | Must equal `VOICE_SHARED_SECRET` on the Netlify site |
| `AGENT_LANGUAGE` | `en` \| `ru` \| `es` \| `zh` |
| `DEEPGRAM_API_KEY` / `DEEPGRAM_MODEL` / `DEEPGRAM_LANGUAGE` | Speech-to-text |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL_ID` | Text-to-speech |
| `TWILIO_AUTH_TOKEN` | Required — verifies `/voice`, `/media`, and binds each media stream to its signed call |

### Which AI model speaks?

The production phone path uses deterministic engine copy by default. Optional AI
rephrasing is disabled unless `VOICE_ALLOW_AI_PHRASING=true` is explicitly set on
the Wallet WCCM site. If enabled, its provider is decided **in the brain**:

- `WWCCM_MODEL` — model id (default `claude-haiku-4-5`; e.g. `claude-sonnet-5-5`).
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

## Files

| File | Role |
| --- | --- |
| `src/server.mjs` | Express webhook + Media Stream WebSocket, call orchestration |
| `src/deepgram.mjs` | Deepgram live STT socket |
| `src/elevenlabs.mjs` | ElevenLabs streaming TTS (`ulaw_8000`) |
| `src/brain.mjs` | Client for the advisor brain (`/api/voice-advisor-turn`) |
| `src/config.mjs` | Env config + multilingual disclosures/greeting |
| `render.yaml` | Render Blueprint (always-on Web Service) |
