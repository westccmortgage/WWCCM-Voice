import test from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicateFinal } from '../src/conversation-control.mjs';

// These are explicit release gaps, not mocked passes. They require the missing
// authenticated V2 semantic orchestrator and grounded tool contract.
test.todo('off-topic question gets a direct answer, then an optional return to questions or application');
test.todo('HELOC follow-up retains topic and does not mutate the pending mortgage-balance field');
test.todo('correction supersedes the prior fact and invalidates dependent calculations');
test.todo('hypothetical scenario remains separate from actual application facts');
test.todo('compound out-of-order facts are captured with entity, units, scope, and provenance');
test.todo('ambiguous consequential STT value is clarified before any calculation');
test('duplicate final ASR event is idempotent before a second Core request is created', () => {
  const state = { lastFinalText: null, lastFinalAt: null };
  assert.equal(isDuplicateFinal(state, 'My balance is 400 thousand', 10_000), false);
  assert.equal(isDuplicateFinal(state, 'my balance is 400 thousand', 10_900), true);
});
test.todo('personalized HELOC versus cash-out comparison uses grounded same-horizon tools');
test.todo('current rate, approval, transfer, weather, and action claims fail closed without a tool');
test.todo('memory spans detours and resumes only with caller permission');
