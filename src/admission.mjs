export function createCallAdmission(settings = {}) {
  const calls = new Map();
  let voiceWebhooks = 0;
  let brainRequests = 0;

  return Object.freeze({
    admitVoiceWebhook({ callSid, from, now = Date.now() }) {
      if (settings.mode === 'production') return { answeredAt: now };
      if (settings.mode !== 'test' || from !== settings.allowedCaller) return null;
      if (!/^CA[a-f0-9]{32}$/i.test(callSid || '')) return null;
      if (voiceWebhooks >= settings.maxVoiceWebhooks) return null;
      const existing = calls.get(callSid);
      if (!existing && calls.size >= settings.maxCalls) return null;
      if (existing && existing.from !== from) return null;
      voiceWebhooks += 1;
      if (!existing) calls.set(callSid, { from, answeredAt: now });
      return { answeredAt: (existing || calls.get(callSid)).answeredAt };
    },

    reserveBrainRequest(callSid) {
      if (settings.mode === 'production') return true;
      if (settings.mode !== 'test' || !calls.has(callSid)) return false;
      if (brainRequests >= settings.maxBrainRequests) return false;
      brainRequests += 1;
      return true;
    },

    snapshot() {
      return { calls: calls.size, voiceWebhooks, brainRequests };
    },
  });
}
