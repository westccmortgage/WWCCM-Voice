import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayAnswerBridge } from '../src/relay-answer-bridge.mjs';

const callSid = 'CA' + 'a'.repeat(32), caller = '+15555550123';
test('accepted incoming call answers first; only in-progress redirect installs duration before Connect', async () => {
  let time = 1000, status = 'accepted', attempts = 0;
  const bridge = createRelayAnswerBridge({ now: () => time, limit: async (args) => {
    attempts++;
    if (status !== 'in-progress') throw Error('21220: Call is not in-progress. Cannot update.');
    assert.ok(args.maximumSeconds <= 105);
    assert.equal(args.maximumSeconds, 97); // 3s bootstrap + 5s API deadline deducted.
  } });
  const bootstrap = bridge.begin({ callSid, caller, session: 'offline-session', deadline: 106000, repeated: false, opening: 'Company recording AI non-licensed disclosures.' });
  assert.match(bootstrap, /<Say language="en-US">Company recording AI non-licensed disclosures\.<\/Say>.*<Redirect/);
  assert.doesNotMatch(bootstrap, /Connect>|ConversationRelay|session|CallSid/);
  assert.equal(attempts, 0); // Original pre-answer Call Update would fail 21220.
  const ticket = bootstrap.match(/ticket=([^<]+)/)[1];
  status = 'in-progress'; time = 4000;
  const session = await bridge.connect({ ticket, callSid, caller, callStatus: status });
  assert.equal(session, 'offline-session'); assert.equal(attempts, 1);
  await assert.rejects(bridge.connect({ ticket, callSid, caller, callStatus: status }));
  assert.equal(attempts, 1);
});

test('wrong status, expiration, restart, repeated admission and unknown update never permit another dispatch', async () => {
  let time = 1000, attempts = 0;
  const options = { now: () => time, limit: async () => { attempts++; throw Error('unknown'); } };
  const make = (bridge) => bridge.begin({ callSid, caller, session: 'offline-session', deadline: 106000, repeated: false, opening: 'Company recording AI non-licensed disclosures.' }).match(/ticket=([^<]+)/)[1];
  const bridge = createRelayAnswerBridge(options);
  let ticket = make(bridge);
  await assert.rejects(bridge.connect({ ticket, callSid, caller, callStatus: 'accepted' }));
  await assert.rejects(bridge.connect({ ticket, callSid, caller, callStatus: 'in-progress' }));
  assert.equal(attempts, 0);
  ticket = make(bridge); time = 47000;
  await assert.rejects(bridge.connect({ ticket, callSid, caller, callStatus: 'in-progress' }));
  assert.equal(attempts, 0);
  time = 1000; ticket = make(bridge);
  await assert.rejects(createRelayAnswerBridge(options).connect({ ticket, callSid, caller, callStatus: 'in-progress' }));
  assert.throws(() => bridge.begin({ callSid, caller, session: 'offline-session', deadline: 106000, repeated: true, opening: 'Company recording AI non-licensed disclosures.' }));
  await assert.rejects(bridge.connect({ ticket, callSid, caller, callStatus: 'in-progress' }));
  await assert.rejects(bridge.connect({ ticket, callSid, caller, callStatus: 'in-progress' }));
  assert.equal(attempts, 1);
});
