import assert from 'node:assert/strict';
import test from 'node:test';

import { createCallAdmission } from '../src/admission.mjs';

const OWNER = '+14245550123';
const CALL_A = `CA${'a'.repeat(32)}`;
const CALL_B = `CA${'b'.repeat(32)}`;

test('test admission permits only the exact owner and a bounded single call', () => {
  const admission = createCallAdmission({
    mode: 'test', allowedCaller: OWNER, maxCalls: 1, maxVoiceWebhooks: 2, maxBrainRequests: 2,
  });
  assert.equal(admission.admitVoiceWebhook({ callSid: CALL_A, from: '+14245550999' }), null);
  assert.deepEqual(admission.admitVoiceWebhook({ callSid: CALL_A, from: OWNER, now: 100 }), { answeredAt: 100 });
  assert.deepEqual(admission.admitVoiceWebhook({ callSid: CALL_A, from: OWNER, now: 999 }),
    { answeredAt: 100 }, 'a Twilio retry cannot reset the answer-time deadline');
  assert.equal(admission.admitVoiceWebhook({ callSid: CALL_A, from: OWNER }), null, 'suite webhook cap');
  assert.equal(admission.admitVoiceWebhook({ callSid: CALL_B, from: OWNER }), null, 'suite call cap');
});

test('test admission bounds total Core requests across the suite', () => {
  const admission = createCallAdmission({
    mode: 'test', allowedCaller: OWNER, maxCalls: 1, maxVoiceWebhooks: 1, maxBrainRequests: 2,
  });
  assert.equal(admission.reserveBrainRequest(CALL_A), false, 'call must first be admitted');
  assert.ok(admission.admitVoiceWebhook({ callSid: CALL_A, from: OWNER }));
  assert.equal(admission.reserveBrainRequest(CALL_A), true);
  assert.equal(admission.reserveBrainRequest(CALL_A), true);
  assert.equal(admission.reserveBrainRequest(CALL_A), false);
  assert.deepEqual(admission.snapshot(), { calls: 1, voiceWebhooks: 1, brainRequests: 2 });
});

test('disabled admission rejects all calls', () => {
  assert.equal(createCallAdmission({ mode: 'disabled' })
    .admitVoiceWebhook({ callSid: CALL_A, from: OWNER }), null);
});
