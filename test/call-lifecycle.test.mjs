import test from 'node:test';
import assert from 'node:assert/strict';
import { beginBrainRequest, cancelBrainRequest, endCall, finishBrainRequest } from '../src/call-lifecycle.mjs';

test('closing during a brain request aborts it and blocks post-await work', () => {
  const state = { ended: false, brainAbort: null };
  const controller = beginBrainRequest(state);
  assert.ok(controller);
  assert.equal(controller.signal.aborted, false);

  const pending = endCall(state);
  pending.abort();

  assert.equal(controller.signal.aborted, true);
  assert.equal(finishBrainRequest(state, controller), false);
  assert.equal(beginBrainRequest(state), null);
});

test('ending a call is terminal and idempotent', () => {
  const state = { ended: false, brainAbort: null };
  assert.equal(endCall(state), null);
  assert.equal(state.ended, true);
  assert.equal(endCall(state), null);
});

test('a newer caller turn cancels the in-flight brain result as stale', () => {
  const state = { ended: false, brainAbort: null };
  const controller = beginBrainRequest(state);
  assert.equal(cancelBrainRequest(state), controller);
  assert.equal(controller.signal.aborted, true);
  assert.equal(finishBrainRequest(state, controller), false);
});
