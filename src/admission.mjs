const CALL_SID = /^CA[a-f0-9]{32}$/i;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const SUITE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const TIMEOUT_MS = 10_000;
const ADMISSION_URL = 'https://walletwccm.com/api/voice-admission';

export function createCallAdmission(settings = {}, { fetchImpl = fetch } = {}) {
  const request = async (payload) => {
    if (!settings.url || !settings.sharedSecret) throw new Error('admission_not_configured');
    const target = new URL(settings.url);
    if (target.href !== ADMISSION_URL) {
      throw new Error('admission_insecure_url');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(target, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-voice-secret': settings.sharedSecret },
        body: JSON.stringify(payload) });
      if (!response.ok) throw new Error(`admission_http_${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > 8_192) throw new Error('admission_response_too_large');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 8_192) throw new Error('admission_response_too_large');
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally { clearTimeout(timer); }
  };

  return Object.freeze({
    async admitVoiceWebhook({ callSid, from }) {
      if (settings.mode !== 'test' || from !== settings.allowedCaller
        || !CALL_SID.test(callSid || '') || !E164.test(from || '')) return null;
      const lease = await request({ action: 'admit', callIdentity: callSid, caller: from });
      return validLease(lease) ? Object.freeze({ ...lease, caller: from }) : null;
    },

    async claimStream({ callSid, caller, suiteId }) {
      if (settings.mode !== 'test' || caller !== settings.allowedCaller
        || !CALL_SID.test(callSid || '') || !E164.test(caller || '') || !SUITE_ID.test(suiteId || '')) return false;
      const claim = await request({ action: 'claim_stream', callIdentity: callSid, caller, suiteId });
      return claim?.protocol === 'core-v2.voice-admission-stream.1'
        && claim.suiteId === suiteId && claim.claimed === true;
    },
  });
}

function validLease(value) {
  return value?.protocol === 'core-v2.voice-admission.1'
    && SUITE_ID.test(value.suiteId || '') && /^[a-f0-9]{64}$/.test(value.callIdentityDigest || '')
    && Number.isSafeInteger(value.answeredAtMs) && Number.isSafeInteger(value.deadlineMs)
    && value.deadlineMs > value.answeredAtMs && value.deadlineMs > Date.now()
    && Number.isInteger(value.maximumTurns) && value.maximumTurns >= 1 && value.maximumTurns <= 60
    && Number.isInteger(value.maximumBrainRequests) && value.maximumBrainRequests >= 1 && value.maximumBrainRequests <= 100
    && Number.isInteger(value.maximumTtsCharacters) && value.maximumTtsCharacters >= 500 && value.maximumTtsCharacters <= 100000
    && typeof value.repeated === 'boolean';
}
