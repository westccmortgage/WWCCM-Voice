import test from 'node:test';
import assert from 'node:assert/strict';

import { boundedInteger, reserveSpeechCharacters } from '../src/usage-limits.mjs';

test('numeric runtime limits reject missing, fractional, and out-of-range values', () => {
  const range = { min: 2, max: 60 };
  assert.equal(boundedInteger(undefined, 12, range), 12);
  assert.equal(boundedInteger('6', 12, range), 6);
  assert.equal(boundedInteger('6.5', 12, range), 12);
  assert.equal(boundedInteger('1', 12, range), 12);
  assert.equal(boundedInteger('61', 12, range), 12);
});

test('TTS reservation is atomic and rejects before crossing the per-call cap', () => {
  const state = { ttsCharacters: 0 };
  assert.equal(reserveSpeechCharacters(state, 'hello', 8), true);
  assert.equal(state.ttsCharacters, 5);
  assert.equal(reserveSpeechCharacters(state, 'four', 8), false);
  assert.equal(state.ttsCharacters, 5);
  assert.equal(reserveSpeechCharacters(state, 'bye', 8), true);
  assert.equal(state.ttsCharacters, 8);
});
