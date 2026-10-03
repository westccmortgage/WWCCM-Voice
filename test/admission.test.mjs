import assert from 'node:assert/strict';
import test from 'node:test';

import { createCallAdmission } from '../src/admission.mjs';

const OWNER = '+14245550123';
const CALL = `CA${'a'.repeat(32)}`;
const SETTINGS = { mode: 'test', allowedCaller: OWNER,
  url: 'https://walletwccm.com/api/voice-admission', sharedSecret: 'fixture-secret' };

const lease = { protocol: 'core-v2.voice-admission.1', suiteId: 'owner-call-1',
  callIdentityDigest: 'a'.repeat(64), answeredAtMs: Date.now() - 100,
  deadlineMs: Date.now() + 120_000, maximumTurns: 6, maximumBrainRequests: 12,
  maximumTtsCharacters: 8000, repeated: false };

test('admission sends only a bounded owner call to the durable boundary', async () => {
  const fetchImpl = async (_url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-voice-secret'], SETTINGS.sharedSecret);
    assert.deepEqual(JSON.parse(init.body), { action: 'admit', callIdentity: CALL, caller: OWNER });
    return new Response(JSON.stringify(lease));
  };
  const admission = createCallAdmission(SETTINGS, { fetchImpl });
  assert.equal(await admission.admitVoiceWebhook({ callSid: CALL, from: '+14245550999' }), null);
  assert.deepEqual(await admission.admitVoiceWebhook({ callSid: CALL, from: OWNER }), { ...lease, caller: OWNER });
});

test('stream activation is a separate one-shot durable claim', async () => {
  const fetchImpl = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), {
      action: 'claim_stream', callIdentity: CALL, caller: OWNER, suiteId: lease.suiteId,
    });
    return new Response(JSON.stringify({ protocol: 'core-v2.voice-admission-stream.1',
      suiteId: lease.suiteId, callIdentityDigest: 'a'.repeat(64), claimed: true }));
  };
  const admission = createCallAdmission(SETTINGS, { fetchImpl });
  assert.equal(await admission.claimStream({ callSid: CALL, caller: OWNER, suiteId: lease.suiteId }), true);
});

test('disabled, malformed, insecure, and ambiguous admission fails closed without retry', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('unknown outcome'); };
  assert.equal(await createCallAdmission({ mode: 'disabled' }, { fetchImpl })
    .admitVoiceWebhook({ callSid: CALL, from: OWNER }), null);
  assert.equal(calls, 0);
  await assert.rejects(createCallAdmission(SETTINGS, { fetchImpl })
    .admitVoiceWebhook({ callSid: CALL, from: OWNER }), /unknown outcome/);
  assert.equal(calls, 1, 'unknown outcomes are never blindly retried');
  await assert.rejects(createCallAdmission({ ...SETTINGS, url: 'http://walletwccm.com/api/voice-admission' }, { fetchImpl })
    .admitVoiceWebhook({ callSid: CALL, from: OWNER }), /admission_insecure_url/);
  await assert.rejects(createCallAdmission({ ...SETTINGS, url: 'https://attacker.test/api/voice-admission' }, { fetchImpl })
    .admitVoiceWebhook({ callSid: CALL, from: OWNER }), /admission_insecure_url/);
});
