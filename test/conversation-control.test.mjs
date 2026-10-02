import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendAssistantHistory,
  beginEnding,
  bindAssistantMark,
  bindAssistantPlayback,
  boundedHistory,
  canAcceptCallerInput,
  classifyConversationControl,
  conversationControlReply,
  isTurnSuperseded,
  isDuplicateFinal,
  markActiveAssistantInterrupted,
  markAssistantDelivered,
  markAssistantUndelivered,
  queueUtterance,
  takeNextUtterance,
} from '../src/conversation-control.mjs';
import {
  acknowledgePlaybackMark,
  beginPlayback,
  finishPlaybackGeneration,
  invalidatePlayback,
} from '../src/playback.mjs';

function state() {
  return {
    history: [],
    utteranceQueue: [],
    turnRevision: 0,
    activeAssistantHistoryIndex: null,
    assistantMarkHistory: new Map(),
    playbackGeneration: 0,
    activePlaybackGeneration: null,
    playbackMark: null,
    speaking: false,
    ttsAbort: null,
  };
}

test('hearing check gets a direct natural answer without resuming an intake question', () => {
  const intent = classifyConversationControl('Emma, are you hearing me?');
  assert.equal(intent, 'hearing_check');
  const reply = conversationControlReply('en', intent);
  assert.match(reply, /Yes, I can hear you/);
  assert.match(reply, /what would you like to ask/i);
  assert.doesNotMatch(reply, /purchase price|down payment|application/i);
});

test('pause and resume keep the application optional', () => {
  assert.equal(classifyConversationControl('Wait.'), 'pause');
  assert.equal(conversationControlReply('en', 'pause'), "Of course. I'll pause.");
  const resume = conversationControlReply('en', classifyConversationControl("Okay, I'm ready."));
  assert.match(resume, /another question, or continue with your application/);
});

test('Russian, Spanish, and Chinese human controls are recognized locally', () => {
  assert.equal(classifyConversationControl('Вы меня слышите?'), 'hearing_check');
  assert.equal(classifyConversationControl('Подождите.'), 'pause');
  assert.equal(classifyConversationControl('Продолжайте.'), 'resume');
  assert.equal(classifyConversationControl('¿Me escucha?'), 'hearing_check');
  assert.equal(classifyConversationControl('Un momento.'), 'pause');
  assert.equal(classifyConversationControl('Adelante.'), 'resume');
  assert.equal(classifyConversationControl('听得到吗？'), 'hearing_check');
  assert.equal(classifyConversationControl('暂停。'), 'pause');
  assert.equal(classifyConversationControl('继续。'), 'resume');
});

test('clear followed by Twilio late mark never records discarded speech as delivered', () => {
  const s = state();
  const oldIndex = appendAssistantHistory(s, 'Stale questionnaire prompt', 1);
  const oldGeneration = beginPlayback(s, new AbortController());
  bindAssistantPlayback(s, oldIndex, oldGeneration);
  finishPlaybackGeneration(s, oldGeneration, 'eos-1');
  bindAssistantMark(s, oldIndex, 'eos-1');

  assert.equal(markActiveAssistantInterrupted(s), true);
  invalidatePlayback(s); // server now sends Twilio clear

  const newIndex = appendAssistantHistory(s, 'Yes, I can hear you.', 2);
  const newGeneration = beginPlayback(s, new AbortController());
  bindAssistantPlayback(s, newIndex, newGeneration);
  finishPlaybackGeneration(s, newGeneration, 'eos-2');
  bindAssistantMark(s, newIndex, 'eos-2');

  // Twilio documents that clear emits marks for discarded buffered audio.
  assert.equal(acknowledgePlaybackMark(s, 'eos-1'), false);
  assert.equal(markAssistantDelivered(s, 'eos-1'), false);
  assert.equal(s.history[oldIndex].delivery, 'interrupted');

  assert.equal(acknowledgePlaybackMark(s, 'eos-2'), true);
  assert.equal(markAssistantDelivered(s, 'eos-2'), true);
  assert.equal(s.history[newIndex].delivery, 'delivered');
});

test('turn revisions supersede late brain results and preserve queued utterances', () => {
  const s = state();
  const firstRevision = queueUtterance(s, 'The home is five hundred thousand');
  assert.deepEqual(takeNextUtterance(s), {
    text: 'The home is five hundred thousand',
    revision: firstRevision,
    intent: null,
    priority: false,
  });
  assert.equal(isTurnSuperseded(s, firstRevision), false);

  queueUtterance(s, 'Actually, make that six hundred thousand');
  assert.equal(isTurnSuperseded(s, firstRevision), true);
  assert.equal(takeNextUtterance(s).text, 'Actually, make that six hundred thousand');
});

test('priority human controls survive a full queue and drain before ordinary speech', () => {
  const s = state();
  for (const text of ['one', 'two', 'three', 'four']) queueUtterance(s, text);
  queueUtterance(s, 'Wait', 4, { intent: 'pause', priority: true });
  assert.equal(s.utteranceQueue.length, 4);
  assert.equal(takeNextUtterance(s).intent, 'pause');
  assert.deepEqual(s.utteranceQueue.map((entry) => entry.text), ['two', 'three', 'four']);
});

test('paused draining can select resume without consuming ordinary queued speech', () => {
  const s = state();
  queueUtterance(s, 'question while paused');
  queueUtterance(s, 'continue', 4, { intent: 'resume', priority: true });
  assert.equal(takeNextUtterance(s, { controlsOnly: true }).intent, 'resume');
  assert.equal(takeNextUtterance(s).text, 'question while paused');
});

test('a latest priority control is not stale merely because older speech remains queued', () => {
  const s = state();
  queueUtterance(s, 'older ordinary speech');
  const resumeRevision = queueUtterance(s, 'continue', 4, {
    intent: 'resume',
    priority: true,
  });
  const resume = takeNextUtterance(s, { controlsOnly: true });
  assert.equal(resume.revision, resumeRevision);
  assert.equal(isTurnSuperseded(s, resumeRevision), false);
});

test('latest pause-state decision coalesces pause and resume without deadlock', () => {
  const s = state();
  queueUtterance(s, 'wait', 4, { intent: 'pause', priority: true });
  const resumeRevision = queueUtterance(s, 'continue', 4, {
    intent: 'resume',
    priority: true,
  });
  assert.deepEqual(s.utteranceQueue.map((entry) => entry.intent), ['resume']);
  assert.equal(takeNextUtterance(s, { controlsOnly: true }).revision, resumeRevision);
});

test('priority-control flooding remains absolutely bounded and coalesced', () => {
  const s = state();
  for (let index = 0; index < 100; index += 1) {
    queueUtterance(s, `Emma, are you there? ${index}`, 4, {
      intent: 'hearing_check',
      priority: true,
    });
  }
  assert.equal(s.utteranceQueue.length, 1);
  assert.equal(s.utteranceQueue[0].text, 'Emma, are you there? 99');
});

test('goodbye has terminal queue precedence and cannot be displaced', () => {
  const s = state();
  queueUtterance(s, 'ordinary question');
  const goodbyeRevision = queueUtterance(s, 'goodbye', 4, {
    intent: 'goodbye',
    priority: true,
  });
  queueUtterance(s, 'another late final');
  assert.equal(s.utteranceQueue.length, 1);
  assert.equal(s.utteranceQueue[0].intent, 'goodbye');
  assert.equal(s.utteranceQueue[0].revision, goodbyeRevision);
});

test('accepted goodbye remains terminal after it leaves the queue for playback', () => {
  const s = state();
  s.ended = false;
  s.ending = false;
  assert.equal(beginEnding(s), true);
  assert.equal(canAcceptCallerInput(s), false);
  s.utteranceQueue.length = 0; // goodbye was dequeued for farewell playback
  assert.equal(canAcceptCallerInput(s), false);
  assert.equal(beginEnding(s), false);
});

test('failed playback cannot remain pending in delivery-aware history', () => {
  const s = state();
  const index = appendAssistantHistory(s, 'Could not be spoken', 1);
  bindAssistantPlayback(s, index, 1);
  assert.equal(markAssistantUndelivered(s, index), true);
  assert.equal(s.history[index].delivery, 'failed');
  assert.equal(s.activeAssistantHistoryIndex, null);
});

test('conversation history carries delivery state but excludes playback internals', () => {
  const s = state();
  s.history.push({ role: 'user', text: 'Can you hear me?', turnRevision: 1 });
  appendAssistantHistory(s, 'Local pause response.', 7);
  const index = appendAssistantHistory(s, 'Yes.', 1, 'core-v2-voice');
  bindAssistantPlayback(s, index, 9);
  const result = boundedHistory(s.history);
  assert.deepEqual(result, [
    { role: 'assistant', text: 'Yes.', delivery: 'pending', turnRevision: 1 },
  ]);
});

test('duplicate ASR finals inside the bounded replay window do not create another turn', () => {
  const s = state();
  assert.equal(isDuplicateFinal(s, 'Purchase price is 800 thousand', 1_000), false);
  assert.equal(isDuplicateFinal(s, '  purchase   price is 800 thousand  ', 2_000), true);
  assert.equal(isDuplicateFinal(s, 'Purchase price is 800 thousand', 3_000), false);
});
