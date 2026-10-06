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
import { buildServiceStatus, canAcceptTraffic } from './readiness.mjs';
import { beginBrainRequest, endCall, finishBrainRequest } from './call-lifecycle.mjs';
import { reserveSpeechCharacters } from './usage-limits.mjs';
import { createCallAdmission, validLease } from './admission.mjs';
import { createConversationRelay } from './conversation-relay.mjs';
import { createRelayCoreClient } from './relay-core-client.mjs';
import {
  appendAssistantHistory,
  beginEnding,
  bindAssistantMark,
  bindAssistantPlayback,
  canAcceptCallerInput,
  classifyConversationControl,
  conversationControlReply,
  isTurnSuperseded,
  isDuplicateFinal,
  markActiveAssistantInterrupted,
  markAssistantDelivered,
  markAssistantUndelivered,
  queueUtterance,
  takeNextUtterance,
} from './conversation-control.mjs';
import {
  acknowledgePlaybackMark,
  beginPlayback,
  failPlaybackGeneration,
  finishPlaybackGeneration,
  invalidatePlayback,
} from './playback.mjs';

const app = express();
app.use(express.urlencoded({ extended: false }));
const admission = createCallAdmission(config.admission);

function readiness() {
  return buildServiceStatus(config);
}

app.get('/health', (_req, res) => {
  res.json(buildServiceStatus(config, { liveness: true }));
});
app.get('/ready', (_req, res) => {
  const status = readiness();
  res.status(status.ready ? 200 : 503).json(status);
});
app.get('/', (_req, res) => {
  const status = readiness();
  res.status(status.ready ? 200 : 503).json({ service: 'wwccm-voice', ...status });
});

// --- Twilio voice webhook: return TwiML that starts the media stream ---------
app.post('/voice', async (req, res) => {
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
  let admitted;
  try {
    admitted = config.transport === 'relay'
      ? await admitThroughRelay(callSid, String(req.body?.From || ''))
      : await admission.admitVoiceWebhook({ callSid, from: String(req.body?.From || '') });
  } catch {
    console.error('[voice] durable admission outcome unavailable; failing closed');
    return res.status(503).send('Unavailable');
  }
  if (!admitted) {
    console.warn('[voice] call refused by release admission policy');
    return res.status(403).send('Forbidden');
  }
  const wsUrl = `wss://${host}/media`;
  const answeredAt = admitted.answeredAtMs;
  const deadline = Math.min(admitted.deadlineMs, answeredAt + config.limits.maxCallSeconds * 1_000);
  const session = issueCallSession(callSid, config.twilioAuthToken, {
    answeredAt, deadline, suiteId: admitted.suiteId, caller: admitted.caller,
    maximumTurns: Math.min(admitted.maximumTurns, config.limits.maxTurns),
    maximumBrainRequests: admitted.maximumBrainRequests,
    maximumTtsCharacters: Math.min(admitted.maximumTtsCharacters, config.limits.maxTtsCharacters),
  });
  if (!session) return res.status(503).send('Unavailable');
  if (config.transport === 'relay') {
    res.type('text/xml').send(relayTwiml(host, callSid, session));
    return;
  }
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

// Relay mode admits through Core's relay door with the relay credential, so
// the pilot never needs the Netlify brain or core-v2-voice-turn armed.
async function admitThroughRelay(callSid, from) {
  if (config.admission.mode !== 'test' || from !== config.admission.allowedCaller) return null;
  const lease = await createRelayCoreClient({ url: config.relay.url, keyId: config.relay.keyId,
    secret: config.relay.secret, callSid }).admit({ caller: from }).catch((error) => {
    if (error?.kind === 'refused') return null; // e.g. suite call limit reached
    throw error;
  });
  return validLease(lease) ? Object.freeze({ ...lease, caller: from }) : null;
}

const escapeXml = (value) => String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

// The opening disclosures are Twilio's welcome greeting: spoken at once, not
// interruptible, and recorded by Core as Emma's opening line.
function relayGreeting() {
  const d = disclosuresFor('en');
  return `${d.recording} ${d.ai} ${d.greeting}`;
}

function relayTwiml(host, callSid, session) {
  const attributes = [
    ['url', `wss://${host}/relay`],
    ['welcomeGreeting', relayGreeting()],
    ['welcomeGreetingInterruptible', 'none'],
    ['language', 'en-US'],
    ['interruptible', 'speech'],
    ['ignoreBackchannel', 'true'],
    ...(config.relay.ttsProvider ? [['ttsProvider', config.relay.ttsProvider]] : []),
    ...(config.relay.voice ? [['voice', config.relay.voice]] : []),
  ].map(([name, value]) => `${name}="${escapeXml(value)}"`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay ${attributes}>`
    + `<Parameter name="callSid" value="${escapeXml(callSid)}"/>`
    + `<Parameter name="session" value="${escapeXml(session)}"/>`
    + `</ConversationRelay></Connect></Response>`;
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const relayWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

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
  const expected = config.transport === 'relay' ? '/relay' : '/media';
  if (pathname !== expected) return reject(404, 'Not Found');
  if (!verifyTwilioRequest(req, config.twilioAuthToken, { websocket: true })) {
    return reject(403, 'Forbidden');
  }
  const target = config.transport === 'relay' ? relayWss : wss;
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

relayWss.on('connection', (ws, req) => {
  let relay;
  try {
    relay = createConversationRelay({
      request: req,
      authToken: config.twilioAuthToken,
      accountSid: config.relay.accountSid || null,
      greeting: relayGreeting(),
      coreFactory: (callSid) => createRelayCoreClient({ url: config.relay.url, keyId: config.relay.keyId,
        secret: config.relay.secret, callSid, turnTimeoutMs: config.relay.turnTimeoutMs }),
      send: (message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); },
    });
  } catch {
    ws.close(1008, 'unauthorized');
    return;
  }
  ws.on('message', (data) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    relay.receive(message).catch((error) => {
      console.error(JSON.stringify({ event: 'relay_error', reason: error?.name ?? 'Error' }));
      ws.close(1011, 'relay_error');
    });
  });
  ws.on('close', () => relay.socketClosed());
  ws.on('error', () => relay.socketClosed());
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
    paused: false,
    utteranceQueue: [],
    turnRevision: 0,
    coreStateRevision: 0,
    activeAssistantHistoryIndex: null,
    assistantMarkHistory: new Map(),
    closeAfterMark: null,
    markSeq: 0,
    disclosureComplete: false,
    disclosureMark: null,
    audioBytes: 0,
    ttsCharacters: 0,
    turnCount: 0,
    callTimer: null,
    ended: false,
    ending: false,
    lastFinalText: null,
    lastFinalAt: null,
    brainAbort: null,
    brainRequests: 0,
    maximumTurns: 0,
    maximumBrainRequests: 0,
    maximumTtsCharacters: 0,
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
        void onStart(ws, state, msg);
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

async function onStart(ws, state, msg) {
  if (state.streamSid) return ws.close(1008, 'duplicate start');
  const identity = validateStartIdentity(msg, config.twilioAuthToken);
  if (!identity) {
    console.warn('[media] rejected invalid call/session identity');
    return ws.close(1008, 'invalid identity');
  }
  let claimed = false;
  try {
    claimed = await admission.claimStream({ callSid: identity.callSid, caller: identity.caller, suiteId: identity.suiteId });
  } catch { /* an ambiguous claim must never be retried */ }
  if (!claimed || state.streamSid || state.ended) return ws.close(1008, 'admission unavailable');
  state.streamSid = identity.streamSid;
  state.callSid = identity.callSid;
  state.maximumTurns = identity.maximumTurns;
  state.maximumBrainRequests = identity.maximumBrainRequests;
  state.maximumTtsCharacters = identity.maximumTtsCharacters;
  const remainingCallMs = identity.deadline - Date.now();
  if (remainingCallMs <= 0) return ws.close(1008, 'call duration limit');
  state.callTimer = setTimeout(() => {
    console.warn('[media] maximum call duration reached');
    cleanup(state);
    ws.close(1000, 'call duration limit');
  }, remainingCallMs);
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
      if (canAcceptCallerInput(state)) enqueueUtterance(ws, state, text);
    },
    onInterim: (text) => {
      if (canAcceptCallerInput(state) && state.speaking && text && text.length > 2) stopSpeaking(ws, state);
    },
    onError: (err) => console.error('[dg] error:', String(err).slice(0, 200)),
  });
}

function onMedia(ws, state, msg) {
  if (!canAcceptCallerInput(state) || !state.disclosureComplete || !state.streamSid || msg.streamSid !== state.streamSid) return;
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

function enqueueUtterance(ws, state, text) {
  if (!canAcceptCallerInput(state) || !state.disclosureComplete || !text || text.length > 2_000) return;
  if (isDuplicateFinal(state, text)) return;
  const control = classifyConversationControl(text);
  const goodbye = isGoodbye(text);
  // Clear the current response once, then make ending terminal before this
  // utterance can await brain cancellation or farewell synthesis. Later STT,
  // media, and barge-in callbacks cannot cancel the requested hangup.
  if (state.speaking) stopSpeaking(ws, state);
  if (goodbye) beginEnding(state);
  queueUtterance(state, text, 4, {
    intent: goodbye ? 'goodbye' : control,
    priority: goodbye || Boolean(control),
  });
  if (state.processing) {
    // Do not abort a durable Core turn after dispatch: the remote side may
    // commit even if the HTTP client disconnects. Let it finish, advance the
    // authoritative revision, and discard only its superseded speech.
    return;
  }
  void drainUtterances(ws, state);
}

async function drainUtterances(ws, state) {
  if (state.processing || state.ended) return;
  state.processing = true;
  try {
    while (!state.ended && state.utteranceQueue.length) {
      const turn = takeNextUtterance(state, { controlsOnly: state.paused });
      if (!turn) break;
      const responseStarted = await processUtterance(ws, state, turn);
      // Never start another response while this one is still being synthesized
      // or buffered by Twilio. A mark/failure/new barge-in resumes draining.
      if (responseStarted) break;
    }
  } finally {
    state.processing = false;
  }
}

async function processUtterance(ws, state, turn) {
  const { text, revision, intent: queuedIntent } = turn;
  state.turnCount += 1;
  if (state.turnCount > state.maximumTurns) {
    cleanup(state);
    return ws.close(1000, 'turn limit');
  }

  state.history.push({ role: 'user', text, turnRevision: revision });

  // Simple, language-agnostic goodbye handling.
  if (isGoodbye(text)) {
    const d = disclosuresFor(state.language);
    sayThenHangup(ws, state, d.goodbye);
    return true;
  }

  const control = queuedIntent || classifyConversationControl(text);
  if (control) {
    // Hearing/resume replies are disposable if a newer caller turn is already
    // waiting. Pause and goodbye are priority human controls and are never
    // silently superseded.
    if (control === 'hearing_check' && isTurnSuperseded(state, revision)) return false;
    if (control === 'pause') state.paused = true;
    if (control === 'resume') state.paused = false;
    const reply = conversationControlReply(state.language, control);
    const historyIndex = appendAssistantHistory(state, reply, revision);
    say(ws, state, reply, 'eos', historyIndex);
    return true;
  }

  const brainController = beginBrainRequest(state);
  if (!brainController) return false;
  if (state.brainRequests >= state.maximumBrainRequests) {
    finishBrainRequest(state, brainController);
    beginEnding(state);
    sayThenHangup(ws, state, disclosuresFor(state.language).unavailable);
    return true;
  }
  state.brainRequests += 1;
  const result = await advisorTurn({
    text,
    profile: state.profile,
    pendingField: state.pendingField,
    language: state.language,
    isFirst: state.isFirst,
    history: state.history,
    callIdentity: state.callSid,
    turnId: `${state.callSid}:${revision}`,
    expectedStateRevision: state.coreStateRevision,
    signal: brainController.signal,
  });
  if (!finishBrainRequest(state, brainController)) return false;
  state.isFirst = false;

  let reply;
  if (result && result.reply) {
    if (result.source === 'core-v2-voice'
      && Number.isInteger(result.coreStateRevision)
      && result.coreStateRevision === state.coreStateRevision + 1) {
      state.coreStateRevision = result.coreStateRevision;
    }
    // Persist delivery truth for a committed Core answer that was superseded
    // before playback, while still advancing the authoritative Core revision.
    if (isTurnSuperseded(state, revision)) {
      const staleIndex = appendAssistantHistory(
        state, result.reply, result.coreStateRevision, result.source,
      );
      markAssistantUndelivered(state, staleIndex, 'interrupted');
      return false;
    }
    state.profile = result.profile || state.profile;
    state.pendingField = result.pendingField ?? null;
    reply = result.reply;
  } else {
    // The remote turn may have committed even when its response was lost. Do
    // not issue a new request with a guessed revision or continue a split-
    // brain call. End this CallSid; a new call starts a new durable session.
    beginEnding(state);
    sayThenHangup(ws, state, disclosuresFor(state.language).unavailable);
    return true;
  }
  const historyIndex = appendAssistantHistory(
    state, reply, result?.coreStateRevision ?? revision, result?.source ?? null,
  );
  if (result?.disposition === 'pause') state.paused = true;
  if (result?.disposition === 'resume') state.paused = false;
  if (result?.disposition === 'end' || result?.disposition === 'human_handoff') {
    beginEnding(state);
    sayThenHangup(ws, state, reply, historyIndex);
    return true;
  }
  say(ws, state, reply, 'eos', historyIndex);
  return true;
}

// --- Speaking (TTS → Twilio) -------------------------------------------------
function say(ws, state, text, mark = 'eos', historyIndex = null) {
  if (state.ended || !text) return;
  if (!reserveSpeechCharacters(state, text, state.maximumTtsCharacters)) {
    console.warn('[tts] per-call character limit reached');
    cleanup(state);
    ws.close(1009, 'speech limit');
    return;
  }
  if (state.speaking) stopSpeaking(ws, state);
  const controller = new AbortController();
  const generation = beginPlayback(state, controller);
  if (historyIndex != null) bindAssistantPlayback(state, historyIndex, generation);
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
      if (!finishPlaybackGeneration(state, generation, sent)) {
        if (historyIndex != null) markAssistantUndelivered(state, historyIndex);
        void drainUtterances(ws, state);
        return;
      }
      if (historyIndex != null) bindAssistantMark(state, historyIndex, sent);
      if (mark === 'intro') state.disclosureMark = sent;
    })
    .catch((err) => {
      if (failPlaybackGeneration(state, generation)) {
        if (historyIndex != null) markAssistantUndelivered(state, historyIndex);
        console.error('[tts] failed:', String(err).slice(0, 200));
        if (mark === 'intro') ws.close(1011, 'disclosure unavailable');
        else void drainUtterances(ws, state);
      }
    });
}

function sayThenHangup(ws, state, text, historyIndex = null) {
  if (state.ended || !text) return;
  if (!reserveSpeechCharacters(state, text, state.maximumTtsCharacters)) {
    console.warn('[tts] per-call character limit reached');
    cleanup(state);
    ws.close(1009, 'speech limit');
    return;
  }
  const controller = new AbortController();
  const generation = beginPlayback(state, controller);
  if (historyIndex != null) bindAssistantPlayback(state, historyIndex, generation);
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
        if (historyIndex != null) bindAssistantMark(state, historyIndex, sent);
        // Close the stream once this final audio has actually played out.
        state.closeAfterMark = sent;
      }
    })
    .catch(() => {
      if (failPlaybackGeneration(state, generation)) {
        if (historyIndex != null) markAssistantUndelivered(state, historyIndex);
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
  if (completedPlayback) markAssistantDelivered(state, name);
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
    return;
  }
  // Even while paused, drainUtterances can select a queued human control
  // (not ordinary speech), including the resume that releases the pause.
  if (completedPlayback && !state.ended) void drainUtterances(ws, state);
}

function stopSpeaking(ws, state) {
  // Twilio sends pending marks after a clear, even for discarded audio. Mark
  // the dialogue turn interrupted before clearing so a late mark cannot be
  // mistaken for proof that the caller heard the response.
  markActiveAssistantInterrupted(state);
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
  markActiveAssistantInterrupted(state);
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
 * @property {boolean} paused
 * @property {{text:string,revision:number}[]} utteranceQueue
 * @property {number} turnRevision
 * @property {number} coreStateRevision
 * @property {number|null} activeAssistantHistoryIndex
 * @property {Map<string,number>} assistantMarkHistory
 * @property {string|null} closeAfterMark
 * @property {number} markSeq
 * @property {boolean} disclosureComplete
 * @property {string|null} disclosureMark
 * @property {number} audioBytes
 * @property {number} ttsCharacters
 * @property {number} turnCount
 * @property {ReturnType<typeof setTimeout>|null} callTimer
 * @property {boolean} ended
 * @property {boolean} ending
 * @property {string|null} lastFinalText
 * @property {number|null} lastFinalAt
 * @property {AbortController|null} brainAbort
 * @property {number} brainRequests
 * @property {number} maximumTurns
 * @property {number} maximumBrainRequests
 * @property {number} maximumTtsCharacters
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
