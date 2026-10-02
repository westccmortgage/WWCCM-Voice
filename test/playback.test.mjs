import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgePlaybackMark,
  beginPlayback,
  finishPlaybackGeneration,
  invalidatePlayback,
} from '../src/playback.mjs';

function state() {
  return {
    speaking: false,
    ttsAbort: null,
    playbackGeneration: 0,
    activePlaybackGeneration: null,
    playbackMark: null,
  };
}

test('generation completion remains speaking until Twilio echoes its mark', () => {
  const s = state();
  const generation = beginPlayback(s, new AbortController());
  assert.equal(finishPlaybackGeneration(s, generation, 'eos-1'), true);
  assert.equal(s.ttsAbort, null);
  assert.equal(s.speaking, true);
  assert.equal(acknowledgePlaybackMark(s, 'eos-1'), true);
  assert.equal(s.speaking, false);
});

test('interrupt invalidates pending playback and returns controller to abort', () => {
  const s = state();
  const controller = new AbortController();
  beginPlayback(s, controller);
  assert.equal(invalidatePlayback(s), controller);
  assert.equal(s.speaking, false);
  assert.equal(s.playbackMark, null);
  assert.equal(invalidatePlayback(s), null);
});

test('stale mark after clear cannot finish a newer utterance', () => {
  const s = state();
  const first = beginPlayback(s, new AbortController());
  finishPlaybackGeneration(s, first, 'eos-1');
  invalidatePlayback(s);
  const second = beginPlayback(s, new AbortController());
  finishPlaybackGeneration(s, second, 'eos-2');
  assert.equal(acknowledgePlaybackMark(s, 'eos-1'), false);
  assert.equal(s.speaking, true);
  assert.equal(acknowledgePlaybackMark(s, 'eos-2'), true);
  assert.equal(s.speaking, false);
});

test('close during playback invalidates callbacks and remains idempotent', () => {
  const s = state();
  const controller = new AbortController();
  const generation = beginPlayback(s, controller);
  assert.equal(invalidatePlayback(s), controller);
  assert.equal(finishPlaybackGeneration(s, generation, 'eos-1'), false);
  assert.equal(acknowledgePlaybackMark(s, 'eos-1'), false);
  assert.equal(invalidatePlayback(s), null);
  assert.equal(s.speaking, false);
});
