import test from 'node:test';
import assert from 'node:assert/strict';
import { limitRelayCall, callLimitDiagnostic } from '../src/twilio-call-limit.mjs';

test('total call limit is installed without WebSocket setup; unknown/rejected results never retry', async () => {
  const callSid = 'CA' + 'a'.repeat(32), accountSid = 'AC' + 'b'.repeat(32);
  const options = { callSid, accountSid, webhookAccountSid: accountSid,
    authToken: 'offline-only', maximumSeconds: 105 };
  let attempts = 0;
  await limitRelayCall({ ...options, fetchImpl: async (url, init) => {
    attempts++;
    assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`);
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(init.body, 'TimeLimit=105'); assert.ok(init.signal);
    return new Response(JSON.stringify({ sid: callSid, account_sid: accountSid }), { status: 200 });
  } });
  assert.equal(attempts, 1);
  for (const response of [() => { throw Error('unknown'); },
    () => new Response('{}', { status: 400 }), () => new Response('{'),
    () => new Response(JSON.stringify({ sid: 'CA' + 'c'.repeat(32), account_sid: accountSid }))]) {
    attempts = 0;
    await assert.rejects(limitRelayCall({ ...options, fetchImpl: async () => { attempts++; return response(); } }));
    assert.equal(attempts, 1);
  }
  attempts = 0;
  await assert.rejects(limitRelayCall({ ...options, webhookAccountSid: 'AC' + 'c'.repeat(32),
    fetchImpl: async () => { attempts++; } }));
  assert.equal(attempts, 0);
});

test('REST success without time_limit is accepted; bounded diagnostics never disclose response or exception text', async () => {
  const callSid = 'CA' + 'a'.repeat(32), accountSid = 'AC' + 'b'.repeat(32);
  const requestId = 'RQ' + 'c'.repeat(32);
  const options = { callSid, accountSid, webhookAccountSid: accountSid,
    authToken: 'offline-secret-never-log', maximumSeconds: 105 };
  // REST docs return account_sid/sid, not an echo of time_limit.
  await limitRelayCall({ ...options, fetchImpl: async () => new Response(JSON.stringify({
    sid: callSid, account_sid: accountSid, status: 'in-progress', to: '+15555550123' })) });
  const capture = async (fetchImpl, override = {}) => {
    let attempts = 0;
    let failure;
    try { await limitRelayCall({ ...options, ...override, fetchImpl: async (...args) => {
      attempts++; return fetchImpl(...args);
    } }); } catch (error) { failure = callLimitDiagnostic(error); }
    assert.ok(failure); assert.ok(attempts <= 1);
    assert.doesNotMatch(JSON.stringify(failure), /offline-secret|15555550123|raw-sensitive|authorization|account_sid/);
    return failure;
  };
  assert.deepEqual(await capture(async () => new Response(JSON.stringify({ code: 20003,
    message: 'raw-sensitive +15555550123 offline-secret-never-log' }),
    { status: 401, headers: { 'twilio-request-id': requestId } })),
  { httpStatus: 401, requestId, stage: 'http', reason: 'rejected', apiCode: 20003 });
  assert.deepEqual(await capture(async () => new Response(JSON.stringify({ code: 21220,
    message: 'Call is not in-progress. Cannot update.' }), { status: 400 })),
  { httpStatus: 400, stage: 'http', reason: 'rejected', apiCode: 21220 });
  assert.deepEqual(await capture(async () => { throw new DOMException('raw-sensitive', 'TimeoutError'); }),
    { stage: 'transport', errorType: 'timeout' });
  assert.deepEqual(await capture(async () => new Response('{', { headers: { 'twilio-request-id': 'raw-sensitive' } })),
    { httpStatus: 200, stage: 'readback', reason: 'body_unreadable', errorType: 'invalid_json' });
  assert.deepEqual(await capture(async () => new Response('{}')),
    { httpStatus: 200, stage: 'readback', reason: 'identity_mismatch' });
  assert.equal((await capture(async () => new Response('x'.repeat(16385)))).reason, 'body_too_large');
  assert.deepEqual(await capture(async () => { throw Error('should not dispatch'); },
    { webhookAccountSid: 'AC' + 'd'.repeat(32) }), { stage: 'binding', reason: 'account_mismatch' });
  assert.deepEqual(callLimitDiagnostic(Error('raw-sensitive')), { stage: 'internal', errorType: 'other' });
});
