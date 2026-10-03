import assert from 'node:assert/strict';
import test from 'node:test';
import {
  issueCallSession,
  publicRequestUrls,
  twilioSignature,
  validateStartIdentity,
  verifyCallSession,
  verifyTwilioRequest,
} from '../src/security.mjs';
import {
  buildReadiness,
  buildServiceStatus,
  buildSpeechDiagnostic,
  canAcceptTraffic,
} from '../src/readiness.mjs';

const TOKEN = 'test-auth-token';
const lease = (now, duration = 5 * 60_000) => ({
  answeredAt: now, deadline: now + duration, suiteId: 'owner-call-1', caller: '+14245550123',
  maximumTurns: 6, maximumBrainRequests: 12, maximumTtsCharacters: 8000,
});

test('Twilio verification fails closed when token or signature is missing', () => {
  const req = { headers: { host: 'voice.example.com' }, originalUrl: '/voice', body: { CallSid: 'CA1' } };
  assert.equal(verifyTwilioRequest(req, ''), false);
  assert.equal(verifyTwilioRequest(req, TOKEN), false);
});

test('validates signed HTTP webhook parameters and rejects tampering', () => {
  const req = {
    headers: { host: 'voice.example.com', 'x-forwarded-proto': 'https' },
    originalUrl: '/voice',
    body: { CallSid: `CA${'a'.repeat(32)}`, From: '+15551234567' },
  };
  req.headers['x-twilio-signature'] = twilioSignature(
    publicRequestUrls(req)[0],
    req.body,
    TOKEN,
  );
  assert.equal(verifyTwilioRequest(req, TOKEN), true);
  req.body.From = '+15550000000';
  assert.equal(verifyTwilioRequest(req, TOKEN), false);
});

test('validates signed WebSocket upgrade and rejects a changed path', () => {
  const req = { headers: { host: 'voice.example.com' }, url: '/media' };
  req.headers['x-twilio-signature'] = twilioSignature('wss://voice.example.com/media', {}, TOKEN);
  assert.equal(verifyTwilioRequest(req, TOKEN, { websocket: true }), true);
  req.url = '/media?attacker=1';
  assert.equal(verifyTwilioRequest(req, TOKEN, { websocket: true }), false);
});

test('call session is bound to CallSid, integrity protected, and expires', () => {
  const now = 1_000_000;
  const callSid = `CA${'b'.repeat(32)}`;
  const session = issueCallSession(callSid, TOKEN, lease(now));
  assert.equal(verifyCallSession(session, callSid, TOKEN, now + 1), true);
  assert.equal(verifyCallSession(session, `CA${'c'.repeat(32)}`, TOKEN, now + 1), false);
  assert.equal(verifyCallSession(`${session}x`, callSid, TOKEN, now + 1), false);
  assert.equal(verifyCallSession(session, callSid, TOKEN, now + 5 * 60_000 + 1), false);
});

test('start identity binds the signed session to both CallSid and StreamSid', () => {
  const now = 1_000_000;
  const callSid = `CA${'d'.repeat(32)}`;
  const streamSid = `MZ${'e'.repeat(32)}`;
  const session = issueCallSession(callSid, TOKEN, lease(now));
  const msg = {
    event: 'start',
    start: { streamSid, callSid, customParameters: { callSid, session } },
  };
  assert.deepEqual(validateStartIdentity(msg, TOKEN, now + 1), {
    callSid, streamSid, answeredAt: now, deadline: now + 5 * 60_000,
    suiteId: 'owner-call-1', caller: '+14245550123', maximumTurns: 6,
    maximumBrainRequests: 12, maximumTtsCharacters: 8000,
  });
  msg.start.callSid = `CA${'f'.repeat(32)}`;
  assert.equal(validateStartIdentity(msg, TOKEN, now + 1), null);
});

test('liveness can remain healthy while readiness and traffic stay fail closed', () => {
  const status = buildReadiness({ deepgram: {}, elevenlabs: {} });
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, [
    'VOICE_RUNTIME_ENABLED',
    'TWILIO_AUTH_TOKEN',
    'VOICE_TURN_URL',
    'VOICE_SHARED_SECRET',
    'VOICE_ADMISSION_MODE',
    'DEEPGRAM_API_KEY',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_VOICE_ID',
    'DEEPGRAM_MODEL',
    'ELEVENLABS_MODEL_ID',
  ]);
  assert.equal(canAcceptTraffic({ deepgram: {}, elevenlabs: {} }), false);
  assert.equal(verifyTwilioRequest({ headers: {}, body: {} }, ''), false);
});

test('whitespace-only configuration remains unready', () => {
  const whitespace = {
    twilioAuthToken: ' ',
    voiceTurnUrl: '\t',
    voiceSharedSecret: '\n',
    deepgram: { apiKey: '  ' },
    elevenlabs: { apiKey: '\r', voiceId: '   ' },
  };
  assert.equal(buildReadiness(whitespace).ready, false);
  assert.equal(buildReadiness(whitespace).missing.length, 10);
  assert.equal(canAcceptTraffic(whitespace), false);
});

test('Cloudflare speech readiness needs gateway coordinates and token, not separate speech accounts', () => {
  const base = {
    runtimeEnabled: true,
    twilioAuthToken: 'twilio',
    voiceTurnUrl: 'https://walletwccm.com/api/voice-advisor-turn',
    voiceSharedSecret: 'shared',
    admission: { mode: 'test', allowedCaller: '+14245550123', url: 'https://walletwccm.com/api/voice-admission' },
    speech: { provider: 'cloudflare-workers-ai', cloudflare: {
      sttModel: '@cf/deepgram/nova-3', ttsModel: '@cf/deepgram/aura-1',
    } },
    deepgram: {},
    elevenlabs: {},
  };
  assert.deepEqual(buildReadiness(base).missing, [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_AI_GATEWAY_ID',
    'CLOUDFLARE_AI_GATEWAY_TOKEN',
  ]);
  const configured = {
    ...base,
    speech: {
      provider: 'cloudflare-workers-ai',
      cloudflare: {
        accountId: 'account', gatewayId: 'gateway', gatewayToken: 'token',
        sttModel: '@cf/deepgram/nova-3', ttsModel: '@cf/deepgram/aura-1',
      },
    },
  };
  assert.deepEqual(buildReadiness(configured), { ready: true, missing: [] });
});

test('unknown speech provider fails closed', () => {
  const status = buildReadiness({
    runtimeEnabled: true,
    twilioAuthToken: 'twilio',
    voiceTurnUrl: 'url',
    voiceSharedSecret: 'shared',
    admission: { mode: 'test', allowedCaller: '+14245550123', url: 'https://walletwccm.com/api/voice-admission' },
    speech: { provider: 'unknown' },
  });
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, ['SPEECH_PROVIDER']);
});

test('speech diagnostic exposes only allowlisted provider and model identifiers', () => {
  assert.deepEqual(buildSpeechDiagnostic({
    speech: { provider: 'cloudflare-workers-ai', cloudflare: {
      sttModel: '@cf/deepgram/nova-3', ttsModel: '@cf/deepgram/aura-1',
      accountId: 'must-not-leak', gatewayId: 'must-not-leak', gatewayToken: 'must-not-leak',
    } },
    deepgram: { apiKey: 'must-not-leak' },
    elevenlabs: { apiKey: 'must-not-leak', voiceId: 'must-not-leak' },
    admission: { allowedCaller: '+14245550123' },
  }), {
    provider: 'cloudflare-workers-ai',
    stt: { provider: 'cloudflare-workers-ai', model: '@cf/deepgram/nova-3' },
    tts: { provider: 'cloudflare-workers-ai', model: '@cf/deepgram/aura-1' },
  });

  assert.deepEqual(buildSpeechDiagnostic({
    speech: { provider: 'legacy' },
    deepgram: { model: 'nova-2', apiKey: 'must-not-leak' },
    elevenlabs: { modelId: 'eleven_turbo_v2_5', apiKey: 'must-not-leak', voiceId: 'must-not-leak' },
  }), {
    provider: 'legacy',
    stt: { provider: 'deepgram', model: 'nova-2' },
    tts: { provider: 'elevenlabs', model: 'eleven_turbo_v2_5' },
  });
});

test('speech diagnostic never reflects unknown selectors or malformed model values', () => {
  assert.deepEqual(buildSpeechDiagnostic({ speech: { provider: 'https://secret.example/token' } }), {
    provider: 'invalid', stt: null, tts: null,
  });
  assert.deepEqual(buildSpeechDiagnostic({
    speech: { provider: 'cloudflare-workers-ai', cloudflare: {
      sttModel: 'https://secret.example/token?key=oops',
      ttsModel: 'model with spaces',
    } },
  }), {
    provider: 'cloudflare-workers-ai',
    stt: { provider: 'cloudflare-workers-ai', model: 'invalid' },
    tts: { provider: 'cloudflare-workers-ai', model: 'invalid' },
  });
  const secretLike = `nova-${'x'.repeat(100_000)}`;
  const legacy = {
    runtimeEnabled: true,
    twilioAuthToken: 'twilio',
    voiceTurnUrl: 'https://walletwccm.com/api/voice-advisor-turn',
    voiceSharedSecret: 'shared',
    admission: { mode: 'test', allowedCaller: '+14245550123', url: 'https://walletwccm.com/api/voice-admission' },
    speech: { provider: 'legacy' },
    deepgram: { apiKey: 'key', model: secretLike },
    elevenlabs: { apiKey: 'key', voiceId: 'voice', modelId: ' eleven_turbo_v2_5 ' },
  };
  assert.deepEqual(buildSpeechDiagnostic(legacy), {
    provider: 'legacy',
    stt: { provider: 'deepgram', model: 'invalid' },
    tts: { provider: 'elevenlabs', model: 'invalid' },
  });
  assert.deepEqual(buildReadiness(legacy).missing, ['DEEPGRAM_MODEL', 'ELEVENLABS_MODEL_ID']);
});

test('health and readiness status payloads stay dormant and exclude sensitive fields', () => {
  const config = {
    speech: { provider: 'cloudflare-workers-ai', cloudflare: {
      sttModel: '@cf/deepgram/aura-1',
      ttsModel: '@cf/deepgram/nova-3',
      accountId: 'account-canary', gatewayId: 'gateway-canary', gatewayToken: 'token-canary',
    } },
    twilioAuthToken: 'twilio-canary',
    voiceTurnUrl: 'https://credential-url-canary.example',
    voiceSharedSecret: 'shared-secret-canary',
    admission: { allowedCaller: '+14245550123' },
  };
  const health = buildServiceStatus(config, { liveness: true });
  const ready = buildServiceStatus(config);
  assert.equal(health.ok, true);
  assert.equal(health.ready, false);
  assert.equal(ready.ok, false);
  assert.deepEqual(ready.speech, {
    provider: 'cloudflare-workers-ai',
    stt: { provider: 'cloudflare-workers-ai', model: 'invalid' },
    tts: { provider: 'cloudflare-workers-ai', model: 'invalid' },
  });
  assert.ok(ready.missing.includes('CLOUDFLARE_STT_MODEL'));
  assert.ok(ready.missing.includes('CLOUDFLARE_TTS_MODEL'));
  const serialized = JSON.stringify({ health, ready });
  for (const canary of [
    'account-canary', 'gateway-canary', 'token-canary', 'twilio-canary',
    'credential-url-canary', 'shared-secret-canary', '+14245550123',
  ]) assert.doesNotMatch(serialized, new RegExp(canary.replace(/[+]/g, '\\+')));
});

test('test admission is unready without exact owner and durable admission URL', () => {
  const base = {
    runtimeEnabled: true,
    twilioAuthToken: 'twilio',
    voiceTurnUrl: 'https://walletwccm.com/api/voice-advisor-turn',
    voiceSharedSecret: 'shared',
    admission: { mode: 'test', allowedCaller: '', url: '' },
    speech: { provider: 'cloudflare-workers-ai', cloudflare: {
      accountId: 'account', gatewayId: 'gateway', gatewayToken: 'token',
      sttModel: '@cf/deepgram/nova-3', ttsModel: '@cf/deepgram/aura-1',
    } },
  };
  assert.deepEqual(buildReadiness(base).missing, [
    'VOICE_TEST_ALLOWED_CALLER', 'VOICE_ADMISSION_URL',
  ]);
});

test('call session deadline is anchored when Twilio answers, not when media starts', () => {
  const now = 2_000_000;
  const callSid = `CA${'1'.repeat(32)}`;
  const streamSid = `MZ${'2'.repeat(32)}`;
  const session = issueCallSession(callSid, TOKEN, lease(now, 120_000));
  const msg = { event: 'start', start: { streamSid, callSid, customParameters: { callSid, session } } };
  assert.equal(validateStartIdentity(msg, TOKEN, now + 119_999)?.deadline, now + 120_000);
  assert.equal(validateStartIdentity(msg, TOKEN, now + 120_001), null);
});
