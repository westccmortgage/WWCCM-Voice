// Twilio Call resource Update TimeLimit: a total call limit, independent of
// WebSocket setup. Uses the existing runtime account/token, never new keys.
// https://www.twilio.com/docs/voice/api/call-resource#update-a-call-resource
const MAX_BYTES = 16384;
class CallLimitError extends Error {
  constructor(diagnostic) {
    super('call_limit_unconfirmed');
    this.diagnostic = Object.freeze(diagnostic);
  }
}

// Only code-owned classifications and narrowly validated provider metadata.
// Never serialize the exception, response body, URL, credentials or phone data.
export function callLimitDiagnostic(error) {
  return error instanceof CallLimitError ? error.diagnostic : { stage: 'internal', errorType: 'other' };
}

const errorType = (error) => {
  switch (error?.name) {
    case 'TimeoutError': return 'timeout';
    case 'AbortError': return 'aborted';
    case 'TypeError': return 'transport';
    case 'SyntaxError': return 'invalid_json';
    default: return 'other';
  }
};

async function boundedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      size += value.byteLength;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new CallLimitError({ stage: 'readback', reason: 'body_too_large' });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
}

export async function limitRelayCall({ callSid, accountSid, webhookAccountSid, authToken,
  maximumSeconds, fetchImpl = fetch }) {
  if (!/^CA[a-f0-9]{32}$/i.test(callSid || '') || !/^AC[a-f0-9]{32}$/i.test(accountSid || '')
    || webhookAccountSid !== accountSid || !authToken || !Number.isInteger(maximumSeconds)
    || maximumSeconds < 30 || maximumSeconds > 105) {
    throw new CallLimitError({ stage: 'binding', reason: webhookAccountSid !== accountSid
      ? 'account_mismatch' : 'invalid_configuration' });
  }
  let response;
  try { response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ TimeLimit: String(maximumSeconds) }).toString(),
  }); } catch (error) {
    throw new CallLimitError({ stage: 'transport', errorType: errorType(error) });
  } // Exactly one attempt; never retry an ambiguous response.
  const metadata = {};
  if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) metadata.httpStatus = response.status;
  const requestId = response.headers?.get('twilio-request-id');
  if (/^RQ[a-f0-9]{32}$/i.test(requestId || '')) metadata.requestId = requestId;
  let call;
  try { call = JSON.parse(await boundedBody(response)); } catch (error) {
    throw new CallLimitError({ ...metadata, stage: response.ok ? 'readback' : 'http',
      reason: error instanceof CallLimitError ? error.diagnostic.reason : 'body_unreadable', errorType: errorType(error) });
  }
  if (!response.ok) {
    const apiCode = Number.isInteger(call?.code) && call.code >= 10000 && call.code <= 99999 ? call.code : undefined;
    throw new CallLimitError({ ...metadata, stage: 'http', reason: 'rejected', ...(apiCode ? { apiCode } : {}) });
  }
  if (call?.sid !== callSid || call?.account_sid !== accountSid) {
    throw new CallLimitError({ ...metadata, stage: 'readback', reason: 'identity_mismatch' });
  }
}
