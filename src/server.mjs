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
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, disclosuresFor } from './config.mjs';
import { openTranscription, synthesizeSpeech } from './speech.mjs';
import { advisorTurn } from './brain.mjs';
import { issueCallSession, validateStartIdentity, verifyTwilioRequest } from './security.mjs';
import { buildReadiness, canAcceptTraffic } from './readiness.mjs';
import { beginBrainRequest, endCall, finishBrainRequest } from './call-lifecycle.mjs';
import {
  acknowledgePlaybackMark,
  beginPlayback,
  failPlaybackGeneration,
  finishPlaybackGeneration,
  invalidatePlayback,
} from './playback.mjs';

const app = express();
app.use(express.urlencoded({ extended: false }));

function readiness() {
  return buildReadiness(config);
}

app.get('/health', (_req, res) => {
  const status = readiness();
  res.json({
    ok: true,
    service: 'wwccm-voice',
    configured: status.ready,
    ready: status.ready,
    missing: status.missing,
  });
});
app.get('/ready', (_req, res) => {
  const status = readiness();
  res.status(status.ready ? 200 : 503).json({
    ok: status.ready,
    service: 'wwccm-voice',
    configured: status.ready,
    ready: status.ready,
    missing: status.missing,
  });
});
app.get('/', (_req, res) => {
  const status = readiness();
  res.status(status.ready ? 200 : 503).json({ service: 'wwccm-voice', ...status });
});

// --- Twilio voice webhook: return TwiML that starts the media stream ---------
app.post('/voice', (req, res) => {
  if (!canAcceptTraffic(config)) {
    console.error('[voice] required configuration is missing; rejecting request');
    return res.status(503).send('Unavailable');
  }
  if (!verifyTwilioRequest(req, config.twilioAuthToken)) {
    console.warn('[voice] Twilio signature verification failed');
    return res.status(403).send('Forbidden');
  }
  const callSid = String(req.body?.CallSid || '');
  if (!/^CA[a-f0-9]{32}$/i.test(callSid)) return res.status(400).send('Bad Request');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(String(host || ''))) {
    return res.status(400).send('Bad Request');
  }
  const wsUrl = `wss://${host}/media`;
  const session = issueCallSession(callSid, config.twilioAuthToken);
  const lang = config.language;
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `<Stream url="${wsUrl}">` +
    `<Parameter name="lang" value="${lang}"/>` +
    `<Parameter name="callSid" value="${callSid}"/>` +
    `<Parameter name="session" value="${session}"/>` +
    `</Stream>` +
    `</Connect>` +
    `</Response>`;
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const reject = (status, reason) => {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (!canAcceptTraffic(config)) return reject(503, 'Service Unavailable');
  let pathname;
  try {
    pathname = new URL(req.url || '/', 'https://invalid.local').pathname;
  } catch {
    return reject(400, 'Bad Request');
  }
  if (pathname !== '/media') return reject(404, 'Not Found');
  if (!verifyTwilioRequest(req, config.twilioAuthToken, { websocket: true })) {
    return reject(403, 'Forbidden');
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

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
    playbackGeneration: 0,
    activePlaybackGeneration: null,
    playbackMark: null,
    processing: false,
    closeAfterMark: null,
    markSeq: 0,
    disclosureComplete: false,
    disclosureMark: null,
    audioBytes: 0,
    turnCount: 0,
    callTimer: null,
    ended: false,
    brainAbort: null,
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
        onMedia(ws, state, msg);
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
  if (state.streamSid) return ws.close(1008, 'duplicate start');
  const identity = validateStartIdentity(msg, config.twilioAuthToken);
  if (!identity) {
    console.warn('[media] rejected invalid call/session identity');
    return ws.close(1008, 'invalid identity');
  }
  state.streamSid = identity.streamSid;
  state.callSid = identity.callSid;
  state.callTimer = setTimeout(() => {
    console.warn('[media] maximum call duration reached');
    cleanup(state);
    ws.close(1000, 'call duration limit');
  }, 30 * 60_000);
  const paramLang = msg.start?.customParameters?.lang;
  if (paramLang) state.language = paramLang;

  // Speak the mandatory disclosures first. Caller audio is discarded and no
  // speech-recognition provider is opened until Twilio confirms playback.
  const d = disclosuresFor(state.language);
  const intro = `${d.recording} ${d.ai} ${d.greeting}`;
  say(ws, state, intro, 'intro');
}

function openSpeechRecognition(ws, state) {
  if (state.ended || state.dg || !state.disclosureComplete) return;
  state.dg = openTranscription({
    onFinal: (text) => {
      if (!state.ended) handleUtterance(ws, state, text);
    },
    onInterim: (text) => {
      if (!state.ended && state.speaking && text && text.length > 2) stopSpeaking(ws, state);
    },
    onError: (err) => console.error('[dg] error:', String(err).slice(0, 200)),
  });
}

function onMedia(ws, state, msg) {
  if (!state.disclosureComplete || !state.streamSid || msg.streamSid !== state.streamSid) return;
  const payload = msg.media?.payload;
  if (!payload || !state.dg) return;
  const audio = Buffer.from(payload, 'base64');
  state.audioBytes += audio.length;
  if (state.audioBytes > 32 * 1024 * 1024) {
    cleanup(state);
    return ws.close(1009, 'audio limit');
  }
  state.dg.sendAudio(audio);
}

async function handleUtterance(ws, state, text) {
  if (state.ended || !state.disclosureComplete || !text || text.length > 2_000) return;
  if (state.speaking) stopSpeaking(ws, state);
  if (state.processing) return; // one turn at a time
  state.turnCount += 1;
  if (state.turnCount > 60) {
    cleanup(state);
    return ws.close(1000, 'turn limit');
  }
  state.processing = true;

  state.history.push({ role: 'user', text });

  // Simple, language-agnostic goodbye handling.
  if (isGoodbye(text)) {
    const d = disclosuresFor(state.language);
    sayThenHangup(ws, state, d.goodbye);
    state.processing = false;
    return;
  }

  const brainController = beginBrainRequest(state);
  if (!brainController) {
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
    signal: brainController.signal,
  });
  if (!finishBrainRequest(state, brainController)) return;
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
function say(ws, state, text, mark = 'eos') {
  if (state.ended || !text) return;
  const controller = new AbortController();
  const generation = beginPlayback(state, controller);
  synthesizeSpeech({
    text,
    signal: controller.signal,
    onChunk: (chunk) => {
      if (state.activePlaybackGeneration === generation) sendAudio(ws, state, chunk);
    },
  })
    .then(() => {
      if (state.activePlaybackGeneration !== generation) return;
      const sent = sendMark(ws, state, mark);
      if (!finishPlaybackGeneration(state, generation, sent)) return;
      if (mark === 'intro') state.disclosureMark = sent;
    })
    .catch((err) => {
      if (failPlaybackGeneration(state, generation)) {
        console.error('[tts] failed:', String(err).slice(0, 200));
        if (mark === 'intro') ws.close(1011, 'disclosure unavailable');
      }
    });
}

function sayThenHangup(ws, state, text) {
  if (state.ended || !text) return;
  const controller = new AbortController();
  const generation = beginPlayback(state, controller);
  synthesizeSpeech({
    text,
    signal: controller.signal,
    onChunk: (chunk) => {
      if (state.activePlaybackGeneration === generation) sendAudio(ws, state, chunk);
    },
  })
    .then(() => {
      if (state.activePlaybackGeneration !== generation) return;
      const sent = sendMark(ws, state, 'bye');
      if (finishPlaybackGeneration(state, generation, sent)) {
        // Close the stream once this final audio has actually played out.
        state.closeAfterMark = sent;
      }
    })
    .catch(() => {
      if (failPlaybackGeneration(state, generation)) {
        try {
          ws.close(1011, 'goodbye unavailable');
        } catch {
          /* ignore */
        }
      }
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
  if (!state.streamSid || msg.streamSid !== state.streamSid) return;
  const name = msg.mark?.name;
  const completedPlayback = acknowledgePlaybackMark(state, name);
  if (name && state.disclosureMark && name === state.disclosureMark) {
    state.disclosureComplete = true;
    state.disclosureMark = null;
    openSpeechRecognition(ws, state);
  }
  if (completedPlayback && name && state.closeAfterMark && name === state.closeAfterMark) {
    state.closeAfterMark = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

function stopSpeaking(ws, state) {
  const controller = invalidatePlayback(state);
  if (controller) {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }
  state.closeAfterMark = null;
  // Flush any audio Twilio has buffered but not yet played.
  if (state.streamSid && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event: 'clear', streamSid: state.streamSid }));
  }
}

function cleanup(state) {
  const brainController = endCall(state);
  try {
    brainController?.abort();
  } catch {
    /* ignore */
  }
  if (state.callTimer) clearTimeout(state.callTimer);
  state.callTimer = null;
  const controller = invalidatePlayback(state);
  state.closeAfterMark = null;
  state.disclosureMark = null;
  try {
    controller?.abort();
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
 * @property {number} playbackGeneration
 * @property {number|null} activePlaybackGeneration
 * @property {string|null} playbackMark
 * @property {boolean} processing
 * @property {string|null} closeAfterMark
 * @property {number} markSeq
 * @property {boolean} disclosureComplete
 * @property {string|null} disclosureMark
 * @property {number} audioBytes
 * @property {number} turnCount
 * @property {ReturnType<typeof setTimeout>|null} callTimer
 * @property {boolean} ended
 * @property {AbortController|null} brainAbort
 */

server.listen(config.port, () => {
  console.log(`[wwccm-voice] listening on :${config.port}`);
  if (!config.voiceTurnUrl) console.warn('[wwccm-voice] WARNING: VOICE_TURN_URL not set — the brain is unreachable.');
  if (config.speech.provider === 'cloudflare-workers-ai') {
    if (!config.speech.cloudflare.accountId) console.warn('[wwccm-voice] WARNING: CLOUDFLARE_ACCOUNT_ID not set.');
    if (!config.speech.cloudflare.gatewayId) console.warn('[wwccm-voice] WARNING: CLOUDFLARE_AI_GATEWAY_ID not set.');
    if (!config.speech.cloudflare.gatewayToken) console.warn('[wwccm-voice] WARNING: CLOUDFLARE_AI_GATEWAY_TOKEN not set.');
  } else {
    if (!config.deepgram.apiKey) console.warn('[wwccm-voice] WARNING: DEEPGRAM_API_KEY not set.');
    if (!config.elevenlabs.apiKey) console.warn('[wwccm-voice] WARNING: ELEVENLABS_API_KEY not set.');
  }
  if (!config.twilioAuthToken) console.warn('[wwccm-voice] LOCKED: TWILIO_AUTH_TOKEN not set; voice and media endpoints reject all traffic.');
  if (!config.voiceSharedSecret) console.warn('[wwccm-voice] LOCKED: VOICE_SHARED_SECRET not set; brain requests are disabled.');
});
