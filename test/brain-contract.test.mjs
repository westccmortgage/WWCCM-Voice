import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VOICE_TURN_URL = 'https://walletwccm.com/api/voice-advisor-turn';
process.env.VOICE_SHARED_SECRET = 'test-shared-secret';

const { advisorTurn } = await import('../src/brain.mjs?conversation-contract-test');

test('brain request uses authenticated V2 contract and excludes duplicate current utterance', async (t) => {
  let request;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(
      JSON.stringify({
        reply: 'Yes, I can help with that.',
        profile: {},
        pendingField: null,
        numbers: {},
        readyForOptions: false,
        source: 'core-v2-voice',
        requestId: 'request:CA0123456789abcdef0123456789abcdef:2',
        sessionId: 'voice_0123456789abcdef0123456789abcdef',
        coreStateRevision: 2,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await advisorTurn({
    text: 'What is a HELOC?',
    profile: {},
    pendingField: 'occupancy',
    language: 'en',
    isFirst: false,
    history: [
      { role: 'assistant', text: 'Will this be your primary home?', delivery: 'interrupted', turnRevision: 1, source: 'core-v2-voice' },
      { role: 'user', text: 'What is a HELOC?', turnRevision: 2 },
    ],
    callIdentity: 'CA0123456789abcdef0123456789abcdef',
    turnId: 'CA0123456789abcdef0123456789abcdef:2',
    expectedStateRevision: 1,
  });

  assert.equal(request.url, 'https://walletwccm.com/api/voice-advisor-turn');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers['x-voice-secret'], 'test-shared-secret');
  assert.equal(request.body.contractVersion, 'wwccm.voice.v2');
  assert.equal(request.body.mode, 'conversation');
  assert.deepEqual(request.body.historySummary, [
    {
      role: 'assistant',
      text: 'Will this be your primary home?',
      delivery: 'interrupted',
      turnRevision: 1,
    },
  ]);
  assert.equal(request.body.dialoguePolicy.applicationIsOptionalGoal, true);
  assert.equal(request.body.dialoguePolicy.answerQuestionBeforeOfferingNextStep, true);
  assert.equal(request.body.dialoguePolicy.neverResumeInterruptedSpeech, true);
  assert.equal(request.body.phrase, false, 'production remains deterministic until V2 is reviewed and enabled');
  assert.equal(request.body.callIdentity, 'CA0123456789abcdef0123456789abcdef');
  assert.equal(request.body.turnId, 'CA0123456789abcdef0123456789abcdef:2');
  assert.equal(request.body.requestId, 'request:CA0123456789abcdef0123456789abcdef:2');
  assert.equal(request.body.expectedStateRevision, 1);
});

test('brain rejects a Core response that is not bound to this request and next revision', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    source: 'core-v2-voice',
    requestId: 'request:another-call:9',
    sessionId: 'voice_0123456789abcdef0123456789abcdef',
    coreStateRevision: 999,
    reply: 'This response must not be spoken.',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await advisorTurn({
    text: 'Hello', profile: {}, pendingField: null, language: 'en', isFirst: true, history: [],
    callIdentity: 'CA0123456789abcdef0123456789abcdef',
    turnId: 'CA0123456789abcdef0123456789abcdef:1', expectedStateRevision: 0,
  });
  assert.equal(result, null);
});

test('brain rejects legacy responses and oversized response bodies', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const args = {
    text: 'Hello', profile: {}, pendingField: null, language: 'en', isFirst: true, history: [],
    callIdentity: 'CA0123456789abcdef0123456789abcdef',
    turnId: 'CA0123456789abcdef0123456789abcdef:1', expectedStateRevision: 0,
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    source: 'local', reply: 'Legacy questionnaire prompt', profile: {}, pendingField: null,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.equal(await advisorTurn(args), null);

  globalThis.fetch = async () => new Response('x'.repeat(65 * 1024), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  assert.equal(await advisorTurn(args), null);
});
