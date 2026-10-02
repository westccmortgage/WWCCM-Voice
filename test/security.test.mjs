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
