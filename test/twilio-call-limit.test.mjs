import test from 'node:test';
import assert from 'node:assert/strict';
import { limitRelayCall } from '../src/twilio-call-limit.mjs';

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
