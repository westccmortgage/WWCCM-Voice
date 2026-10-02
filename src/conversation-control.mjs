const HEARING_CHECK =
  /\b(?:can|do) you (?:hear|understand) me\b|\bare you (?:there|hearing|listening)\b|\bemma[,. ]+(?:can you hear|are you there|are you listening)\b|(?:вы меня слышите|ты меня слышишь|вы здесь)|(?:me escucha|me oye|est[aá] ah[ií])|(?:听得到吗|听见我吗|在吗)/i;
const PAUSE =
  /^\s*(?:wait|hold on|stop(?: talking)?|pause|one (?:second|moment)|give me a (?:second|moment)|подождите|стоп|пауза|секунду|espere|un momento|pausa|det[eé]ngase|等一下|停一下|暂停)\s*[.!?。！]*\s*$/i;
const RESUME =
  /^\s*(?:ok(?:ay)?(?:,?\s+i(?:'m| am) ready)?|go ahead|continue|i(?:'m| am) ready|продолжайте|я готов(?:а)?|contin[uú]e|adelante|estoy list[oa]|继续|我准备好了)\s*[.!?。！]*\s*$/i;

export function classifyConversationControl(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (HEARING_CHECK.test(value)) return 'hearing_check';
  if (PAUSE.test(value)) return 'pause';
  if (RESUME.test(value)) return 'resume';
  return null;
}

const REPLIES = {
  en: {
    hearing_check: "Yes, I can hear you. I'm listening — what would you like to ask?",
    pause: "Of course. I'll pause.",
    resume: "I'm listening. Would you like to ask another question, or continue with your application?",
  },
  ru: {
    hearing_check: 'Да, я вас слышу. Я слушаю — что вы хотели спросить?',
    pause: 'Конечно. Я подожду.',
    resume: 'Я слушаю. Хотите задать ещё вопрос или продолжить заявку?',
  },
  es: {
    hearing_check: 'Sí, le escucho. Estoy atenta. ¿Qué desea preguntar?',
    pause: 'Por supuesto. Haré una pausa.',
    resume: 'Le escucho. ¿Desea hacer otra pregunta o continuar con su solicitud?',
  },
  zh: {
    hearing_check: '是的，我听得到。我在听，请问您想问什么？',
    pause: '当然，我先暂停。',
    resume: '我在听。您想继续提问，还是继续申请流程？',
  },
};

export function conversationControlReply(language, intent) {
  return (REPLIES[language] || REPLIES.en)[intent] || null;
}

export function canAcceptCallerInput(state) {
  return !state.ended && !state.ending;
}

export function beginEnding(state) {
  if (!canAcceptCallerInput(state)) return false;
  state.ending = true;
  return true;
}

export function queueUtterance(state, text, maxQueued = 4, options = {}) {
  const intent = options.intent || null;
  const queuedGoodbye = state.utteranceQueue.find((entry) => entry.intent === 'goodbye');
  if (queuedGoodbye) return queuedGoodbye.revision;
  state.turnRevision = (state.turnRevision || 0) + 1;
  const entry = {
    text,
    revision: state.turnRevision,
    intent,
    priority: Boolean(options.priority),
  };
  if (intent === 'goodbye') {
    state.utteranceQueue.splice(0, state.utteranceQueue.length, entry);
    return state.turnRevision;
  }
  if (intent === 'pause' || intent === 'resume') {
    // Only the caller's latest pending pause-state decision matters.
    state.utteranceQueue = state.utteranceQueue.filter(
      (queued) => queued.intent !== 'pause' && queued.intent !== 'resume',
    );
  } else if (intent === 'hearing_check') {
    // Repeated "are you there?" finals are one control, not unbounded work.
    state.utteranceQueue = state.utteranceQueue.filter(
      (queued) => queued.intent !== 'hearing_check',
    );
  }
  if (entry.priority) {
    const firstNormal = state.utteranceQueue.findIndex((queued) => !queued.priority);
    if (firstNormal === -1) state.utteranceQueue.push(entry);
    else state.utteranceQueue.splice(firstNormal, 0, entry);
  } else {
    state.utteranceQueue.push(entry);
  }
  if (state.utteranceQueue.length > maxQueued) {
    // The queue is absolutely bounded. Controls are coalesced above, so an
    // ordinary utterance is discarded first; if none exists, discard the
    // oldest lower-precedence control. Goodbye already returned above and is
    // never displaced.
    while (state.utteranceQueue.length > maxQueued) {
      const oldestNormal = state.utteranceQueue.findIndex((queued) => !queued.priority);
      state.utteranceQueue.splice(oldestNormal === -1 ? 0 : oldestNormal, 1);
    }
  }
  return state.turnRevision;
}

export function takeNextUtterance(state, { controlsOnly = false } = {}) {
  if (!controlsOnly) return state.utteranceQueue.shift() || null;
  const index = state.utteranceQueue.findIndex((entry) => entry.priority);
  if (index === -1) return null;
  return state.utteranceQueue.splice(index, 1)[0];
}

export function isTurnSuperseded(state, revision) {
  return revision !== state.turnRevision;
}

export function appendAssistantHistory(state, text, turnRevision, source = null) {
  const entry = {
    role: 'assistant',
    text,
    turnRevision,
    delivery: 'pending',
    playbackGeneration: null,
    markName: null,
    source,
  };
  state.history.push(entry);
  return state.history.length - 1;
}

export function bindAssistantPlayback(state, historyIndex, generation) {
  const entry = state.history[historyIndex];
  if (!entry || entry.role !== 'assistant') return false;
  entry.playbackGeneration = generation;
  state.activeAssistantHistoryIndex = historyIndex;
  return true;
}

export function bindAssistantMark(state, historyIndex, markName) {
  const entry = state.history[historyIndex];
  if (!entry || entry.role !== 'assistant' || !markName) return false;
  entry.markName = markName;
  state.assistantMarkHistory.set(markName, historyIndex);
  return true;
}

export function markActiveAssistantInterrupted(state) {
  const index = state.activeAssistantHistoryIndex;
  const entry = index == null ? null : state.history[index];
  if (!entry || entry.role !== 'assistant' || entry.delivery !== 'pending') return false;
  entry.delivery = 'interrupted';
  if (entry.markName) state.assistantMarkHistory.delete(entry.markName);
  state.activeAssistantHistoryIndex = null;
  return true;
}

export function markAssistantDelivered(state, markName) {
  const index = state.assistantMarkHistory.get(markName);
  if (index == null) return false;
  state.assistantMarkHistory.delete(markName);
  const entry = state.history[index];
  if (!entry || entry.role !== 'assistant' || entry.delivery !== 'pending') return false;
  entry.delivery = 'delivered';
  state.activeAssistantHistoryIndex = null;
  return true;
}

export function markAssistantUndelivered(state, historyIndex, reason = 'failed') {
  const entry = state.history[historyIndex];
  if (!entry || entry.role !== 'assistant' || entry.delivery !== 'pending') return false;
  if (entry.markName) state.assistantMarkHistory.delete(entry.markName);
  entry.delivery = reason;
  if (state.activeAssistantHistoryIndex === historyIndex) {
    state.activeAssistantHistoryIndex = null;
  }
  return true;
}

export function boundedHistory(history, limit = 12) {
  return (history || [])
    .filter((entry) => entry.role === 'assistant' && entry.source === 'core-v2-voice'
      && Number.isInteger(entry.turnRevision))
    .slice(-limit)
    .map(({ role, text, delivery, turnRevision }) => ({
      role,
      text,
      delivery: delivery || 'unknown',
      turnRevision,
    }));
}

export function isDuplicateFinal(state, text, nowMs = Date.now(), windowMs = 1_500) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return true;
  const duplicate = normalized === state.lastFinalText
    && Number.isFinite(state.lastFinalAt)
    && nowMs - state.lastFinalAt >= 0
    && nowMs - state.lastFinalAt <= windowMs;
  if (!duplicate) {
    state.lastFinalText = normalized;
    state.lastFinalAt = nowMs;
  }
  return duplicate;
}
