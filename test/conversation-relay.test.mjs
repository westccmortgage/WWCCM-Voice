import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationRelay, RELAY_LINES } from '../src/conversation-relay.mjs';
import { createRelayCoreClient, RelayCoreError, relaySignature } from '../src/relay-core-client.mjs';
import { issueCallSession, twilioSignature } from '../src/security.mjs';

const callSid = 'CA' + 'a'.repeat(32), accountSid = 'AC' + 'b'.repeat(32), caller = '+13102801111', authToken = 'local-fixture-only';
const GREETING = "Hi, you've reached West Coast Capital Mortgage. My name is Emma. How can I help you today?";

function fixture({ turn } = {}) {
  let clock = 1_000;
  const signed = { answeredAt: 1_000, deadline: 121_000, suiteId: 'relay-fixture', caller, maximumTurns: 6, maximumBrainRequests: 12, maximumTtsCharacters: 4000 };
  const session = issueCallSession(callSid, authToken, signed);
  const request = { url: '/relay', headers: { host: 'example.test', 'x-twilio-signature': twilioSignature('wss://example.test/relay', {}, authToken) } };
  const calls = [], output = [], logs = [], timers = [];
  let revision = 0;
  const core = {
    async claimSession(input) { calls.push(['claim', input]); return { claimed: true, suiteId: input.suiteId }; },
    async turn(input) {
      calls.push(['turn', input]);
      if (turn) return turn(input, { advance: (ms) => { clock += ms; } });
      clock += 900;
      revision += 1;
      return { status: 'answered', revision, reply: { text: `Reply ${revision}.`, kind: 'model' },
        timings: { beginMs: 40, modelMs: 800, completeMs: 30, totalMs: 870 }, diagnostics: { stage: 'response', class: 'completed', code: 'completed' } };
    },
    async close(input) { calls.push(['close', input]); return { closed: true, providerRequests: revision, settledUsd: 0.002, heldUsd: 0, reservedUsd: 0 }; },
  };
  const relay = createConversationRelay({ request, authToken, accountSid, greeting: GREETING, coreFactory: () => core,
    send: (message) => output.push(message), now: () => clock, schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    unschedule: () => {}, log: (line) => logs.push(line) });
  const setup = () => relay.receive({ type: 'setup', accountSid, callSid, from: caller, customParameters: { session, callSid } });
  const say = (voicePrompt) => relay.receive({ type: 'prompt', voicePrompt, last: true, lang: 'en-US' });
  return { relay, setup, say, calls, output, logs, timers, request, session, advance: (ms) => { clock += ms; } };
}

const turns = (f) => f.calls.filter(([kind]) => kind === 'turn').map(([, input]) => input);

test('signed setup claims the call once; each final utterance is one signed Core turn; partials buy nothing', async () => {
  const f = fixture();
  await f.setup();
  assert.deepEqual(f.calls[0], ['claim', { suiteId: 'relay-fixture', greeting: GREETING }]);
  await f.relay.receive({ type: 'prompt', voicePrompt: 'My name is', last: false });
  assert.equal(turns(f).length, 0);
  await f.say('My name is Alex and I want to refinance.');
  assert.deepEqual(turns(f)[0], { requestId: `${callSid}:relay:1`, expectedRevision: 0, utterance: 'My name is Alex and I want to refinance.', previous: null });
  assert.deepEqual(f.output.at(-1), { type: 'text', token: 'Reply 1.', last: true, interruptible: true, preemptible: true });
  assert.equal(f.logs.find((line) => line.event === 'relay_turn').promptToTextMs, 900);
  assert.ok(f.logs.every((line) => !JSON.stringify(line).includes('Alex')), 'no caller speech in logs');
});

test('barge-in is reported with the heard prefix on the next turn; a submitted reply is reported once', async () => {
  const f = fixture();
  await f.setup();
  await f.say('Hi.');
  await f.relay.receive({ type: 'interrupt', utteranceUntilInterrupt: 'Reply', durationUntilInterruptMs: 400 });
  await f.say('Sorry, go on.');
  assert.deepEqual(turns(f)[1].previous, { requestId: `${callSid}:relay:1`, delivery: 'interrupted', spokenPrefix: 'Reply' });
  await f.say('Thanks.');
  assert.deepEqual(turns(f)[2].previous, { requestId: `${callSid}:relay:2`, delivery: 'submitted' });
  await f.say('And one more.');
  assert.deepEqual(turns(f)[3].previous, { requestId: `${callSid}:relay:3`, delivery: 'submitted' });
});

test('the same words said twice are two turns; there is no text-based dedupe', async () => {
  const f = fixture();
  await f.setup();
  await f.say('Yes.');
  await f.say('Yes.');
  assert.equal(turns(f).length, 2);
  assert.notEqual(turns(f)[0].requestId, turns(f)[1].requestId);
});

test('caller speaking while a reply is prepared: old reply discarded unheard, new words answered next, one request in flight', async () => {
  let release;
  const f = fixture({ turn: async (input) => {
    if (input.expectedRevision === 0) await new Promise((resolve) => { release = resolve; });
    return { status: 'answered', revision: input.expectedRevision + 1, reply: { text: `Answer to: ${input.utterance}`, kind: 'model' } };
  } });
  await f.setup();
  const first = f.say('I want to refinance');
  await new Promise((resolve) => setImmediate(resolve));
  await f.say('my condo in Irvine.');
  await f.say('It is a rental.');
  assert.equal(turns(f).length, 1, 'never two model requests in flight for one call');
  release();
  await first;
  assert.equal(turns(f).length, 2);
  assert.equal(turns(f)[1].utterance, 'my condo in Irvine. It is a rental.');
  assert.deepEqual(turns(f)[1].previous, { requestId: `${callSid}:relay:1`, delivery: 'discarded' });
  assert.deepEqual(f.output.map((message) => message.token), ['Answer to: my condo in Irvine. It is a rental.']);
});

test('a known provider refusal asks the caller to repeat once; a second ends the call', async () => {
  const f = fixture({ turn: async (input) => ({ status: 'provider_failed', revision: input.expectedRevision + 1, reply: null,
    diagnostics: { stage: 'provider', class: 'failed_known', code: 'provider_rejected', httpStatus: 400, errorType: 'invalid_request_error', providerRequestId: 'req_1' } }) });
  await f.setup();
  await f.say('Hello?');
  assert.equal(f.output.at(-1).token, RELAY_LINES.retry);
  assert.equal(f.relay.snapshot().ending, false);
  const failure = f.logs.find((line) => line.status === 'provider_failed');
  assert.deepEqual([failure.httpStatus, failure.errorType, failure.providerRequestId], [400, 'invalid_request_error', 'req_1']);
  await f.say('Hello again?');
  assert.equal(f.output.at(-1).token, RELAY_LINES.unavailable);
  assert.equal(f.relay.snapshot().ending, true);
  assert.equal(f.calls.at(-1)[1].reason, 'provider_failed_twice');
});

test('an outcome nobody knows ends the call at once, without a retry or an invented answer', async () => {
  for (const status of ['provider_unknown', 'accounting_unknown', 'repeated']) {
    const f = fixture({ turn: async (input) => ({ status, revision: input.expectedRevision + 1 }) });
    await f.setup();
    await f.say('What should I do?');
    await f.say('Hello?');
    assert.equal(turns(f).length, 1, `${status}: no further turn`);
    assert.equal(f.output.at(-1).token, RELAY_LINES.unavailable);
    assert.equal(f.calls.at(-1)[1].reason, 'provider_outcome_unknown');
  }
  const timeout = fixture({ turn: async () => { throw new RelayCoreError('unknown', { stage: 'core_transport', reason: 'timeout' }); } });
  await timeout.setup();
  await timeout.say('Anything?');
  assert.equal(timeout.output.at(-1).token, RELAY_LINES.unavailable);
  assert.equal(timeout.calls.at(-1)[1].reason, 'core_outcome_unknown');
});

test('limits end politely; goodbye ends without a model request', async () => {
  const limited = fixture({ turn: async () => ({ status: 'refused', code: 'turn_limit' }) });
  await limited.setup();
  await limited.say('One more question.');
  assert.equal(limited.output.at(-1).token, RELAY_LINES.limit);
  const bye = fixture();
  await bye.setup();
  await bye.say('Hi.');
  await bye.say('Okay, thanks, goodbye.');
  assert.equal(turns(bye).length, 1);
  assert.equal(bye.output.at(-1).token, RELAY_LINES.goodbye);
  assert.deepEqual(bye.calls.at(-1), ['close', { reason: 'caller_goodbye', previous: { requestId: `${callSid}:relay:1`, delivery: 'submitted' } }]);
  bye.timers.at(-1).fn();
  assert.equal(bye.output.at(-1).type, 'end', 'end is sent after the goodbye line has had time to play');
  assert.equal(turns(fixture()).length, 0);
});

test('handshake, lease and caller are verified before anything is claimed', async () => {
  const f = fixture();
  assert.throws(() => createConversationRelay({ request: { ...f.request, headers: { host: 'example.test', 'x-twilio-signature': 'bad' } },
    authToken, greeting: GREETING, coreFactory: () => ({}), send: () => {} }), /not_authorized/);
  await f.relay.receive({ type: 'setup', accountSid, callSid, from: '+14245550123', customParameters: { session: f.session, callSid } });
  assert.equal(f.calls.length, 0);
  const tampered = fixture();
  await tampered.relay.receive({ type: 'setup', accountSid, callSid, from: caller, customParameters: { session: tampered.session.replace(/.$/, 'x'), callSid } });
  assert.equal(tampered.calls.length, 0);
  const early = fixture();
  await early.relay.receive({ type: 'prompt', voicePrompt: 'Hello', last: true });
  assert.equal(early.calls.length, 0);
});

test('Core client signs exactly as Core verifies, pins the endpoint, and never retries', async () => {
  // Fixed vector produced by Core's voice-auth.ts voiceRequestSignature.
  assert.equal(relaySignature({ secret: 'fixed-vector-secret-0123456789abcdef', method: 'POST',
    pathname: '/functions/v1/core-v2-voice-relay', timestamp: 1791300000, nonce: 'nonce-fixed-vector-01', rawBody: '{"op":"turn"}' }),
    'm--qUWda1AEd25u-TnTs1o0MlGZb0QAAYxCECk46y_U');
  const base = { url: 'https://hbqlhplgqwuesrovbiye.supabase.co/functions/v1/core-v2-voice-relay', keyId: 'render-relay',
    secret: 'x'.repeat(40), callSid };
  assert.throws(() => createRelayCoreClient({ ...base, url: 'https://evil.example/functions/v1/core-v2-voice-relay' }), /url_invalid/);
  let attempts = 0;
  const failing = createRelayCoreClient({ ...base, fetchImpl: async () => { attempts += 1; throw new TypeError('fetch failed'); } });
  await assert.rejects(failing.turn({ requestId: `${callSid}:relay:1`, expectedRevision: 0, utterance: 'hi' }), (error) => error.kind === 'unknown');
  assert.equal(attempts, 1);
  const refusing = createRelayCoreClient({ ...base, fetchImpl: async () => new Response(JSON.stringify({ error: 'turn_in_progress' }), { status: 409 }) });
  await assert.rejects(refusing.turn({ requestId: `${callSid}:relay:1`, expectedRevision: 0, utterance: 'hi' }),
    (error) => error.kind === 'refused' && error.detail.code === 'turn_in_progress');
  let seen;
  const ok = createRelayCoreClient({ ...base, now: () => 1791300000_000, fetchImpl: async (url, init) => {
    seen = init;
    return new Response(JSON.stringify({ protocol: 'core-v2.voice-relay-result.1', op: 'turn', status: 'answered', revision: 1 }), { status: 200 });
  } });
  assert.equal((await ok.turn({ requestId: `${callSid}:relay:1`, expectedRevision: 0, utterance: 'hi' })).status, 'answered');
  assert.equal(seen.redirect, 'error');
  assert.equal(seen.headers['x-core-voice-signature'], relaySignature({ secret: base.secret, method: 'POST',
    pathname: '/functions/v1/core-v2-voice-relay', timestamp: 1791300000, nonce: seen.headers['x-core-voice-nonce'], rawBody: seen.body }));
  assert.deepEqual(JSON.parse(seen.body), { protocol: 'core-v2.voice-relay.1', callIdentity: callSid, op: 'turn',
    requestId: `${callSid}:relay:1`, expectedRevision: 0, utterance: 'hi', previous: null });
});
