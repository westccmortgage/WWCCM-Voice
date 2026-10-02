// WWCCM-Voice — Twilio Programmable Voice ⇄ our server ⇄ Deepgram ⇄ brain ⇄ ElevenLabs.
//
// Flow of one call:
//   1. Twilio POSTs /voice → we return TwiML that opens a bidirectional Media
//      Stream to wss://<host>/media.
//   2. On "start" the agent speaks the required disclosures (CA two-party consent
//      + "you're speaking with an AI, not a licensed loan officer") then greets.
//   3. Caller audio (mu-law/8000) streams to Deepgram; on each final utterance we
//      call the advisor brain (/api/voice-advisor-turn), then speak its reply via
//      ElevenLabs (mu-law/8000) straight back to Twilio.
//   4. Barge-in: if the caller starts talking while the agent is speaking, we
//      abort TTS and clear Twilio's audio buffer.
//
// The brain owns all mortgage logic and numbers; this process only moves audio
// and text. No rates, approvals, or guarantees are ever spoken (enforced upstream).

import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, disclosuresFor } from './config.mjs';
import { openDeepgram } from './deepgram.mjs';
import { speak } from './elevenlabs.mjs';
import { advisorTurn } from './brain.mjs';

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'wwccm-voice' }));
app.get('/', (_req, res) => res.type('text').send('WWCCM-Voice is running.'));

// --- Twilio voice webhook: return TwiML that starts the media stream ---------
app.post('/voice', (req, res) => {
  if (!verifyTwilio(req)) {
    console.warn('[voice] Twilio signature verification failed');
    return res.status(403).send('Forbidden');
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const wsUrl = `wss://${host}/media`;
  const lang = config.language;
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `<Stream url="${wsUrl}">` +
    `<Parameter name="lang" value="${lang}"/>` +
    `</Stream>` +
    `</Connect>` +
    `</Response>`;
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (ws) => {
  /** @type {CallState} */
  const state = {
    streamSid: null,
    callSid: null,
    language: config.language,
    profile: {},
    pendingField: null,
    isFirst: true,
    history: [],
    dg: null,
    speaking: false,
    ttsAbort: null,
    processing: false,
    closeAfterMark: null,
    markSeq: 0,
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.event) {
      case 'start':
        onStart(ws, state, msg);
        break;
      case 'media':
        onMedia(state, msg);
        break;
      case 'mark':
        onMark(ws, state, msg);
        break;
      case 'stop':
        cleanup(state);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => cleanup(state));
  ws.on('error', () => cleanup(state));
});

function onStart(ws, state, msg) {
  state.streamSid = msg.start?.streamSid || msg.streamSid;
  state.callSid = msg.start?.callSid;
  const paramLang = msg.start?.customParameters?.lang;
  if (paramLang) state.language = paramLang;

  // Open STT for the whole call.
  state.dg = openDeepgram({
    onFinal: (text) => handleUtterance(ws, state, text),
    onInterim: (text) => {
      // Barge-in: if the agent is talking and the caller says something real,
      // stop the agent and flush buffered audio.
      if (state.speaking && text && text.length > 2) stopSpeaking(ws, state);
    },
    onError: (err) => console.error('[dg] error:', String(err).slice(0, 200)),
  });

  // Speak the required disclosures, then the greeting, as the very first thing.
  const d = disclosuresFor(state.language);
  const intro = `${d.recording} ${d.ai} ${d.greeting}`;
  say(ws, state, intro);
}

function onMedia(state, msg) {
  const payload = msg.media?.payload;
  if (!payload || !state.dg) return;
  state.dg.sendAudio(Buffer.from(payload, 'base64'));
}

async function handleUtterance(ws, state, text) {
  if (!text) return;
  // Ignore a stray final that arrives while we're still speaking the intro.
  if (state.speaking) stopSpeaking(ws, state);
  if (state.processing) return; // one turn at a time
  state.processing = true;

  state.history.push({ role: 'user', text });

  // Simple, language-agnostic goodbye handling.
  if (isGoodbye(text)) {
    const d = disclosuresFor(state.language);
    sayThenHangup(ws, state, d.goodbye);
    state.processing = false;
    return;
  }

  const result = await advisorTurn({
    text,
    profile: state.profile,
    pendingField: state.pendingField,
    language: state.language,
    isFirst: state.isFirst,
    history: state.history,
  });
  state.isFirst = false;

  let reply;
  if (result && result.reply) {
    state.profile = result.profile || state.profile;
    state.pendingField = result.pendingField ?? null;
    reply = result.reply;
  } else {
    reply = disclosuresFor(state.language).fallback;
  }
  state.history.push({ role: 'assistant', text: reply });
  state.processing = false;
  say(ws, state, reply);
}

// --- Speaking (TTS → Twilio) -------------------------------------------------
function say(ws, state, text) {
  if (!text) return;
  state.speaking = true;
  const controller = new AbortController();
  state.ttsAbort = controller;
  speak({
    text,
    signal: controller.signal,
    onChunk: (chunk) => sendAudio(ws, state, chunk),
  })
    .catch(() => {})
    .finally(() => {
      if (state.ttsAbort === controller) {
        state.speaking = false;
        state.ttsAbort = null;
      }
      // A mark lets us know when THIS utterance finished playing out.
      sendMark(ws, state, 'eos');
    });
}

function sayThenHangup(ws, state, text) {
  state.speaking = true;
  const controller = new AbortController();
  state.ttsAbort = controller;
  speak({ text, signal: controller.signal, onChunk: (chunk) => sendAudio(ws, state, chunk) })
    .catch(() => {})
    .finally(() => {
      state.speaking = false;
      state.ttsAbort = null;
      // Close the stream once this final audio has actually played out.
      state.closeAfterMark = sendMark(ws, state, 'bye');
    });
}

function sendAudio(ws, state, chunk) {
  if (!state.streamSid || ws.readyState !== ws.OPEN) return;
  // Re-frame to 160-byte (20ms @ mu-law/8000) frames for smooth playout.
  for (let i = 0; i < chunk.length; i += 160) {
    const frame = chunk.subarray(i, i + 160);
    ws.send(
      JSON.stringify({
        event: 'media',
        streamSid: state.streamSid,
        media: { payload: Buffer.from(frame).toString('base64') },
      }),
    );
  }
}

function sendMark(ws, state, name) {
  if (!state.streamSid || ws.readyState !== ws.OPEN) return null;
  const markName = `${name}-${++state.markSeq}`;
  ws.send(JSON.stringify({ event: 'mark', streamSid: state.streamSid, mark: { name: markName } }));
  return markName;
}

function onMark(ws, state, msg) {
  const name = msg.mark?.name;
  if (name && state.closeAfterMark && name === state.closeAfterMark) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

function stopSpeaking(ws, state) {
  if (state.ttsAbort) {
    try {
      state.ttsAbort.abort();
    } catch {
      /* ignore */
    }
    state.ttsAbort = null;
  }
  state.speaking = false;
  // Flush any audio Twilio has buffered but not yet played.
  if (state.streamSid && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event: 'clear', streamSid: state.streamSid }));
  }
}

function cleanup(state) {
  try {
    state.ttsAbort?.abort();
  } catch {
    /* ignore */
  }
  try {
    state.dg?.close();
  } catch {
    /* ignore */
  }
  state.dg = null;
}

// --- Helpers -----------------------------------------------------------------
const GOODBYE = /\b(good ?bye|bye bye|that'?s all|no that'?s it|hang up)\b|^(bye)\b|пока|до свидания|adi[oó]s|hasta luego|再见|拜拜/i;
function isGoodbye(text) {
  return GOODBYE.test(text.trim());
}

/** Validate Twilio's X-Twilio-Signature (only when TWILIO_AUTH_TOKEN is set). */
function verifyTwilio(req) {
  if (!config.twilioAuthToken) return true; // validation disabled
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}${req.originalUrl}`;
  const params = req.body || {};
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto
    .createHmac('sha1', config.twilioAuthToken)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} CallState
 * @property {string|null} streamSid
 * @property {string|null} callSid
 * @property {string} language
 * @property {object} profile
 * @property {string|null} pendingField
 * @property {boolean} isFirst
 * @property {{role:string,text:string}[]} history
 * @property {any} dg
 * @property {boolean} speaking
 * @property {AbortController|null} ttsAbort
 * @property {boolean} processing
 * @property {string|null} closeAfterMark
 * @property {number} markSeq
 */

server.listen(config.port, () => {
  console.log(`[wwccm-voice] listening on :${config.port}`);
  if (!config.voiceTurnUrl) console.warn('[wwccm-voice] WARNING: VOICE_TURN_URL not set — the brain is unreachable.');
  if (!config.deepgram.apiKey) console.warn('[wwccm-voice] WARNING: DEEPGRAM_API_KEY not set.');
  if (!config.elevenlabs.apiKey) console.warn('[wwccm-voice] WARNING: ELEVENLABS_API_KEY not set.');
});
