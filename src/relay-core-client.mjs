// Signed client for Core's core-v2-voice-relay door (Supabase Edge Function).
//
// Same timestamped HMAC as Core's voice-auth.ts: version, method, public
// path, timestamp, nonce and the SHA-256 of the exact body, keyed by a
// secret that only this service and that one function hold. No retries: a
// turn request may already have bought a model call, so a failure is
// reported to the caller as unknown and the call stops.
import crypto from 'node:crypto';

const AUTH_VERSION = 'core-v2-voice-hmac-v1';
const PROTOCOL = 'core-v2.voice-relay.1';
const RESULT_PROTOCOL = 'core-v2.voice-relay-result.1';
const MAX_RESPONSE_BYTES = 16 * 1024;
const PATH = '/functions/v1/core-v2-voice-relay';

const base64Url = (buffer) => Buffer.from(buffer).toString('base64url');

export function relaySignature({ secret, method, pathname, timestamp, nonce, rawBody }) {
  const bodyDigest = base64Url(crypto.createHash('sha256').update(rawBody, 'utf8').digest());
  const canonical = [AUTH_VERSION, method.toUpperCase(), pathname, String(timestamp), nonce, bodyDigest].join('\n');
  return base64Url(crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest());
}

export class RelayCoreError extends Error {
  constructor(kind, detail = {}) {
    super(kind);
    this.kind = kind; // 'refused' | 'unknown'
    this.detail = detail;
  }
}

export function createRelayCoreClient({ url, keyId, secret, callSid, fetchImpl = fetch, now = Date.now, turnTimeoutMs = 9_000 }) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new Error('relay_core_url_invalid'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== PATH || !/\.supabase\.co$/.test(endpoint.hostname)) throw new Error('relay_core_url_invalid');
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(keyId || '') || String(secret || '').length < 32) throw new Error('relay_core_credential_invalid');
  if (!/^CA[a-f0-9]{32}$/i.test(callSid || '')) throw new Error('relay_core_call_invalid');

  async function post(payload, timeoutMs) {
    const rawBody = JSON.stringify({ protocol: PROTOCOL, callIdentity: callSid, ...payload });
    const timestamp = Math.floor(now() / 1000);
    const nonce = crypto.randomBytes(18).toString('base64url');
    const headers = {
      'content-type': 'application/json',
      'x-core-voice-key-id': keyId,
      'x-core-voice-timestamp': String(timestamp),
      'x-core-voice-nonce': nonce,
      'x-core-voice-signature': relaySignature({ secret, method: 'POST', pathname: PATH, timestamp, nonce, rawBody }),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint.href, { method: 'POST', redirect: 'error', headers, body: rawBody, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      throw new RelayCoreError('unknown', { stage: 'core_transport', reason: controller.signal.aborted ? 'timeout' : (error?.name || 'Error') });
    }
    try {
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('too_large');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('too_large');
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (!response.ok) {
        const code = typeof body?.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : 'unknown_error';
        // 4xx is a refusal before anything was bought; 5xx may follow a purchase.
        throw new RelayCoreError(response.status < 500 ? 'refused' : 'unknown', { stage: 'core', httpStatus: response.status, code });
      }
      if (body?.protocol !== RESULT_PROTOCOL || body.op !== payload.op) {
        throw new RelayCoreError('unknown', { stage: 'core', httpStatus: response.status, code: 'readback_invalid' });
      }
      return body;
    } catch (error) {
      if (error instanceof RelayCoreError) throw error;
      throw new RelayCoreError('unknown', { stage: 'core_response', reason: controller.signal.aborted ? 'timeout' : 'unreadable' });
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    claimSession: ({ suiteId, greeting }) => post({ op: 'claim_session', suiteId, greeting }, 5_000),
    turn: ({ requestId, expectedRevision, utterance, previous }) =>
      post({ op: 'turn', requestId, expectedRevision, utterance, previous: previous ?? null }, turnTimeoutMs),
    close: ({ reason, previous }) => post({ op: 'close', reason, previous: previous ?? null }, 5_000),
  });
}
