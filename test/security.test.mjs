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
import { buildReadiness, canAcceptTraffic } from '../src/readiness.mjs';

const TOKEN = 'test-auth-token';

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
  const session = issueCallSession(callSid, TOKEN, now);
  assert.equal(verifyCallSession(session, callSid, TOKEN, now + 1), true);
  assert.equal(verifyCallSession(session, `CA${'c'.repeat(32)}`, TOKEN, now + 1), false);
  assert.equal(verifyCallSession(`${session}x`, callSid, TOKEN, now + 1), false);
  assert.equal(verifyCallSession(session, callSid, TOKEN, now + 5 * 60_000 + 1), false);
});

test('start identity binds the signed session to both CallSid and StreamSid', () => {
  const now = 1_000_000;
  const callSid = `CA${'d'.repeat(32)}`;
  const streamSid = `MZ${'e'.repeat(32)}`;
  const session = issueCallSession(callSid, TOKEN, now);
  const msg = {
    event: 'start',
    start: { streamSid, callSid, customParameters: { callSid, session } },
  };
  assert.deepEqual(validateStartIdentity(msg, TOKEN, now + 1), { callSid, streamSid });
  msg.start.callSid = `CA${'f'.repeat(32)}`;
  assert.equal(validateStartIdentity(msg, TOKEN, now + 1), null);
});

test('liveness can remain healthy while readiness and traffic stay fail closed', () => {
  const status = buildReadiness({ deepgram: {}, elevenlabs: {} });
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, [
    'TWILIO_AUTH_TOKEN',
    'VOICE_TURN_URL',
    'VOICE_SHARED_SECRET',
    'DEEPGRAM_API_KEY',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_VOICE_ID',
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
  assert.equal(buildReadiness(whitespace).missing.length, 6);
  assert.equal(canAcceptTraffic(whitespace), false);
});
