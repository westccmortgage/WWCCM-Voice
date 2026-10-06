// Offline acceptance for Emma on ConversationRelay. Not a CI test: it needs a
// checkout of measured-decision-ai (CORE_REPO) and runs with
//   node --experimental-strip-types --no-warnings scripts/relay-offline-acceptance.mjs
//
// One process, no network, no paid provider:
//   simulated Twilio  ->  real server.mjs (/voice TwiML + /relay socket)
//                     ->  real Core relay handler + service + reply clearance
//                     ->  scripted model transport with a fixed delay.
// Only two URLs are intercepted: the admission endpoint and Core's relay
// door. The provider replies are scripted per scenario, so this proves the
// mechanics (facts, clearance, interruption, failure classes, duplicates,
// goodbye, money states) and measures this system's own overhead. It does
// NOT prove conversation quality or real phone latency.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const CORE_REPO = process.env.CORE_REPO;
if (!CORE_REPO) { console.log('CORE_REPO not set; skipping offline acceptance'); process.exit(0); }
const MODEL_DELAY_MS = Number(process.env.MODEL_DELAY_MS ?? 700);

const AUTH_TOKEN = 'offline-twilio-token';
const SHARED = 'offline-shared-secret';
const RELAY_SECRET = 'offline-relay-secret-0123456789abcdef0123';
const OWNER = '+13105550100';
const HOST = 'example.test';
const PORT = 18_000 + Math.floor(Math.random() * 1000);
const RELAY_URL = 'https://hbqlhplgqwuesrovbiye.supabase.co/functions/v1/core-v2-voice-relay';
const ADMISSION_URL = 'https://walletwccm.com/api/voice-admission';
Object.assign(process.env, {
  PORT: String(PORT), VOICE_RUNTIME_ENABLED: 'true', VOICE_ADMISSION_MODE: 'test', VOICE_TEST_ALLOWED_CALLER: OWNER,
  VOICE_ADMISSION_URL: ADMISSION_URL, VOICE_SHARED_SECRET: SHARED, TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  VOICE_TRANSPORT: 'relay', VOICE_RELAY_URL: RELAY_URL, VOICE_RELAY_KEY_ID: 'render-relay', VOICE_RELAY_HMAC_SECRET: RELAY_SECRET,
  VOICE_RELAY_TURN_TIMEOUT_MS: '4000',
});

const core = (path) => import(`${CORE_REPO}/${path}`);
const { createRelayHandler } = await core('supabase/functions/core-v2-voice-relay/handler.ts');
const { RelayService, RELAY_PROTOCOL } = await core('workers/core-v2-voice/relay-service.ts');
const { AnthropicRelayModel } = await core('workers/core-v2-voice/relay-provider.ts');
const { relayEnvironment } = await core('workers/core-v2-voice/relay-config.ts');
const { loadVoiceBudgetPolicy, loadVoiceRuntimeConfig } = await core('workers/core-v2-voice/runtime-assembly.ts');
const { BUSINESS, MemoryRelayRepository, relayEnv, textReply } = await core('workers/core-v2-voice/tests/relay-fixtures.mjs');
const { voiceRequestSignature } = await core('supabase/functions/_shared/core-v2/voice-auth.ts');
const { TransportFault } = await core('workers/core-v2-runtime/transport/transport.ts');
const { twilioSignature } = await import('../src/security.mjs');
const { RELAY_LINES } = await import('../src/conversation-relay.mjs');

// --- Core, in process -------------------------------------------------------
const env = relayEnv({ CORE_V2_RELAY_HMAC_SECRET: RELAY_SECRET });
const relayConfigured = loadVoiceRuntimeConfig(relayEnvironment(env), loadVoiceBudgetPolicy(relayEnvironment(env)));
const policy = loadVoiceBudgetPolicy(relayEnvironment(env));
let script = [];           // per scenario: functions (requestBody) -> reply | Error
const modelRequests = [];
const transport = { name: 'scripted', async send(request) {
  const body = JSON.parse(request.body);
  modelRequests.push(body);
  const step = script.shift();
  await new Promise((resolve) => setTimeout(resolve, step?.delayMs ?? MODEL_DELAY_MS));
  if (!step) throw new Error('unscripted model request');
  if (step.error) throw step.error;
  return step.reply;
} };
const repositories = [];
function newCore() {
  const repository = new MemoryRelayRepository();
  repositories.push(repository);
  const nonces = new Set();
  return { repository, handler: createRelayHandler({
    resolveCredential: async (keyId) => keyId === 'render-relay' ? { keyId, secret: RELAY_SECRET, callerApp: 'wallet-voice', tenantId: 'wccm' } : null,
    replayStore: { async claim(keyId, nonce) { const key = `${keyId}:${nonce}`; if (nonces.has(key)) return false; nonces.add(key); return true; } },
    service: new RelayService({ repository, model: new AnthropicRelayModel({ configuration: relayConfigured.configuration,
      runtime: relayConfigured.runtime, transport, environment: env }), authorizedMaximumUsd: policy.authorizedMaximumUsd,
      maximumPerTurnUsd: policy.maximumPerTurnUsd, businessFacts: BUSINESS, log: () => {} }),
  }) };
}
let current = newCore();
const coreBodies = [];

// --- Intercept exactly two URLs ----------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof URL ? input.href : input);
  if (url === ADMISSION_URL) {
    const body = JSON.parse(init.body);
    const now = Date.now();
    return new Response(JSON.stringify(body.action === 'admit' ? {
      protocol: 'core-v2.voice-admission.1', suiteId: 'offline-suite', callIdentityDigest: 'a'.repeat(64),
      answeredAtMs: now, deadlineMs: now + 120_000, maximumTurns: 12, maximumBrainRequests: 12, maximumTtsCharacters: 4000, repeated: false,
    } : { protocol: 'core-v2.voice-admission-stream.1', suiteId: body.suiteId, claimed: true }), { status: 200 });
  }
  if (url === RELAY_URL) {
    coreBodies.push(JSON.parse(init.body));
    // Behave like fetch: the caller's abort ends the wait (the server side,
    // like a real Edge invocation, keeps running and settles its own money).
    const handled = current.handler(new Request('http://runtime/core-v2-voice-relay', { method: 'POST', headers: init.headers, body: init.body }));
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      handled.then(resolve, reject);
    });
  }
  return realFetch(input, init);
};

const quiet = console.log;
const serverLogs = [];
console.log = (...args) => { const text = args.join(' '); if (text.startsWith('{')) serverLogs.push(JSON.parse(text)); };
await import('../src/server.mjs');
await new Promise((resolve) => setTimeout(resolve, 200));

// --- Simulated Twilio --------------------------------------------------------
async function placeCall() {
  const callSid = `CA${randomBytes(16).toString('hex')}`;
  const params = { CallSid: callSid, From: OWNER, To: '+14243041032' };
  const signature = twilioSignature(`https://${HOST}/voice`, params, AUTH_TOKEN);
  const response = await realFetch(`http://127.0.0.1:${PORT}/voice`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https', 'x-twilio-signature': signature },
    body: new URLSearchParams(params) });
  assert.equal(response.status, 200);
  const twiml = await response.text();
  const attribute = (name) => twiml.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  const session = twiml.match(/name="session" value="([^"]+)"/)[1];
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/relay`, { headers: { 'x-forwarded-host': HOST,
    'x-twilio-signature': twilioSignature(`wss://${HOST}/relay`, {}, AUTH_TOKEN) } });
  const inbox = [];
  let waiter = null;
  socket.on('message', (data) => { inbox.push({ at: performance.now(), message: JSON.parse(String(data)) }); waiter?.(); });
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject); });
  const send = (message) => socket.send(JSON.stringify(message));
  send({ type: 'setup', sessionId: 'VX1', accountSid: 'AC' + '0'.repeat(32), callSid, from: OWNER, to: '+14243041032',
    customParameters: { callSid, session } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  async function next(timeoutMs = 6_000) {
    const deadline = performance.now() + timeoutMs;
    while (!inbox.length) {
      if (performance.now() > deadline) return null;
      await new Promise((resolve) => { waiter = resolve; setTimeout(resolve, 25); });
    }
    return inbox.shift();
  }
  async function say(text) {
    const sentAt = performance.now();
    send({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true });
    const reply = await next();
    return { ...reply, latencyMs: reply ? reply.at - sentAt : null };
  }
  return { callSid, twiml, attribute, send, say, next, close: () => socket.close() };
}

const results = [];
const latencies = [];
async function scenario(name, fn) {
  current = newCore();
  modelRequests.length = 0;
  coreBodies.length = 0;
  try { await fn(); results.push([name, 'PASS']); }
  catch (error) { results.push([name, `FAIL: ${error.message}`]); }
}
const reply = (text, extra) => ({ reply: textReply(text, undefined, undefined), ...extra });

await scenario('1 greeting: disclosures first, not interruptible, recorded as the opening', async () => {
  script = [];
  const call = await placeCall();
  assert.match(call.attribute('welcomeGreeting'), /recorded for quality.*not a licensed loan officer.*How can I help you today\?/);
  assert.equal(call.attribute('welcomeGreetingInterruptible'), 'none');
  assert.equal(current.repository.state.history[0].role, 'assistant');
  assert.match(current.repository.state.history[0].text, /This call may be recorded/);
  call.close();
});

await scenario('2 name and goal: stored as caller facts and given to the model', async () => {
  script = [reply("Nice to meet you, Alex. What's prompting the refinance?")];
  const call = await placeCall();
  const answer = await call.say('Hi, my name is Alex and I want to refinance my house.');
  latencies.push(answer.latencyMs);
  assert.equal(answer.message.token, "Nice to meet you, Alex. What's prompting the refinance?");
  assert.equal(current.repository.state.facts.name, 'Alex');
  assert.equal(current.repository.state.facts.goalCategory, 'refinance');
  assert.match(modelRequests[0].system, /name: Alex/);
  call.close();
});

await scenario('3 facts saved and corrected; the caller\'s own figure may be repeated back', async () => {
  script = [reply('Got it.'), reply('Thanks, Alexis. So you are at 7.25 percent now.'), reply('Understood.')];
  const call = await placeCall();
  latencies.push((await call.say('My name is Alex.')).latencyMs);
  const second = await call.say('Actually my name is Alexis, and my current rate is 7.25 percent.');
  latencies.push(second.latencyMs);
  assert.equal(second.message.token, 'Thanks, Alexis. So you are at 7.25 percent now.');
  assert.equal(current.repository.state.facts.name, 'Alexis');
  assert.equal(current.repository.state.facts.currentRatePercent, 7.25);
  latencies.push((await call.say('What if my rate were 5 percent?')).latencyMs);
  assert.equal(current.repository.state.facts.currentRatePercent, 7.25, 'a hypothetical never overwrites the caller fact');
  call.close();
});

await scenario('4 rate question: no invented figure reaches speech', async () => {
  script = [reply('Rates today are around 6.1 percent, so you could save a lot.')];
  const call = await placeCall();
  const answer = await call.say('What are your rates today?');
  latencies.push(answer.latencyMs);
  assert.doesNotMatch(answer.message.token, /6\.1/);
  assert.match(answer.message.token, /exact quote/);
  call.close();
});

await scenario('5 broker request: talk about it freely, never claim it happened', async () => {
  script = [reply("I'm transferring you to a broker now."), reply('A licensed broker can help with that. Licensed brokers return calls within one business day, and the office is open Monday to Friday, 9 AM to 6 PM Pacific.')];
  const call = await placeCall();
  const first = await call.say('Can you transfer me to a broker?');
  latencies.push(first.latencyMs);
  assert.doesNotMatch(first.message.token, /transferring you/i);
  const second = await call.say('When can a broker call me?');
  latencies.push(second.latencyMs);
  assert.match(second.message.token, /within one business day/);
  call.close();
});

await scenario('6 interruption: the next turn records only the heard prefix', async () => {
  script = [reply('Thanks for calling. There are a few options we could look at together.'), reply('Sure, go ahead.')];
  const call = await placeCall();
  latencies.push((await call.say('Hi there.')).latencyMs);
  call.send({ type: 'interrupt', utteranceUntilInterrupt: 'Thanks for calling.', durationUntilInterruptMs: 900 });
  latencies.push((await call.say('Sorry, one question first.')).latencyMs);
  const previous = coreBodies.filter((body) => body.op === 'turn')[1].previous;
  assert.deepEqual(previous, { requestId: `${call.callSid}:relay:1`, delivery: 'interrupted', spokenPrefix: 'Thanks for calling.' });
  assert.equal(JSON.parse(JSON.stringify(modelRequests[1].messages[1])).content, 'Thanks for calling....');
  call.close();
});

await scenario('7 timeout: provider fault after submission is held, the caller is told, nothing is retried', async () => {
  script = [{ error: new Error('socket hang up'), delayMs: 300 }];
  const call = await placeCall();
  const answer = await call.say('Can you hear me?');
  assert.equal(answer.message.token, RELAY_LINES.unavailable);
  assert.equal(modelRequests.length, 1);
  assert.equal(current.repository.money.held > 0, true);
  assert.equal((await call.next(15_000)).message.type, 'end', 'end follows once the line has had time to play');
  call.close();
});

await scenario('7b timeout: Core slower than the phone turn deadline ends the call as unknown', async () => {
  script = [{ ...reply('Too late.'), delayMs: 4_600 }];
  const call = await placeCall();
  const answer = await call.say('Hello?');
  assert.equal(answer.message.token, RELAY_LINES.unavailable);
  call.close();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(current.repository.money.settled > 0, true, 'the late answer is still settled once by Core');
});

await scenario('8 duplicates: a redelivered turn never buys a second model request', async () => {
  script = [reply('Hello, how can I help?')];
  const call = await placeCall();
  latencies.push((await call.say('Hello.')).latencyMs);
  const original = coreBodies.find((body) => body.op === 'turn');
  const raw = JSON.stringify(original);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(18).toString('base64url');
  const signature = await voiceRequestSignature({ secret: RELAY_SECRET, method: 'POST', pathname: '/functions/v1/core-v2-voice-relay', timestamp, nonce, rawBody: raw });
  const replay = await current.handler(new Request('http://runtime/core-v2-voice-relay', { method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-core-voice-key-id': 'render-relay', 'x-core-voice-timestamp': String(timestamp), 'x-core-voice-nonce': nonce, 'x-core-voice-signature': signature } }));
  assert.equal((await replay.json()).status, 'repeated');
  assert.equal(modelRequests.length, 1);
  script = [reply('Yes, got it.'), reply('Yes, noted again.')];
  await call.say('Yes.');
  await call.say('Yes.');
  assert.equal(modelRequests.length, 3, 'the same words said twice are two real turns');
  call.close();
});

await scenario('9 goodbye: polite close, no model request, end after the line', async () => {
  script = [reply('Happy to help.')];
  const call = await placeCall();
  latencies.push((await call.say('Thanks for the info.')).latencyMs);
  const bye = await call.say('Okay, thanks, goodbye.');
  assert.equal(bye.message.token, RELAY_LINES.goodbye);
  assert.equal(modelRequests.length, 1);
  assert.equal(coreBodies.at(-1).op, 'close');
  assert.equal(coreBodies.at(-1).reason, 'caller_goodbye');
  assert.equal((await call.next(8_000)).message.type, 'end');
  call.close();
});

await scenario('10 provider refusal: a known 400 asks the caller to repeat and the call continues', async () => {
  script = [{ reply: { status: 400, headers: { 'request-id': 'req_offline400' }, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }) } },
    reply('Sure. What would you like to know?')];
  const call = await placeCall();
  const first = await call.say('Tell me about HELOCs.');
  assert.equal(first.message.token, RELAY_LINES.retry);
  assert.equal(current.repository.money.held, 0, 'a known refusal releases, it is not held');
  const second = await call.say('Tell me about HELOCs, please.');
  latencies.push(second.latencyMs);
  assert.equal(second.message.token, 'Sure. What would you like to know?');
  const failure = serverLogs.find((line) => line.event === 'relay_turn' && line.status === 'provider_failed');
  assert.deepEqual([failure.httpStatus, failure.errorType, failure.providerRequestId], [400, 'invalid_request_error', 'req_offline400']);
  call.close();
});

console.log = quiet;
const sorted = latencies.filter((value) => value !== null).sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
for (const [name, verdict] of results) console.log(`${verdict.startsWith('PASS') ? 'PASS' : 'FAIL'}  ${name}${verdict.startsWith('PASS') ? '' : ` — ${verdict.slice(6)}`}`);
console.log(JSON.stringify({ scriptedModelDelayMs: MODEL_DELAY_MS, measuredTurns: sorted.length,
  promptToTextP50Ms: Math.round(pct(50)), promptToTextP95Ms: Math.round(pct(95)), promptToTextMaxMs: Math.round(sorted.at(-1)),
  overheadP95Ms: Math.round(pct(95) - MODEL_DELAY_MS) }));
const leaked = serverLogs.some((line) => /Alex|refinance my house|7\.25/.test(JSON.stringify(line)));
console.log(leaked ? 'FAIL  logs contain caller speech' : 'PASS  logs contain no caller speech');
process.exit(results.every(([, verdict]) => verdict === 'PASS') && !leaked ? 0 : 1);
