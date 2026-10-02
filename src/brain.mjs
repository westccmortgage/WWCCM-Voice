// WWCCM-Voice — client for the advisor "brain".
//
// The brain is the Wallet WCCM site's /api/voice-advisor-turn route (image repo).
// It reuses the SAME deterministic engine + intake order + calculators as the web
// chat, and (optionally) phrases the reply via the provider-agnostic AI layer
// (Anthropic direct or the Measured Decision V2 gateway). We send the caller's
// transcript + the running profile; we get back a short spoken reply + updated
// state. This server never computes a mortgage number itself.

import { config } from './config.mjs';
import { boundedHistory } from './conversation-control.mjs';

const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const EXPECTED_ORIGIN = 'https://walletwccm.com';
const EXPECTED_PATH = '/api/voice-advisor-turn';

/**
 * Run one advisor turn.
 * @param {object} args
 * @param {string} args.text            caller's latest utterance (from STT)
 * @param {object} args.profile         running profile for this call
 * @param {string|null} args.pendingField the field we last asked about
 * @param {string} args.language        en|ru|es|zh
 * @param {boolean} args.isFirst        first caller utterance of the call
 * @param {{role:string,text:string}[]} args.history recent turns
 * @param {string} args.callIdentity    signed call identity bound by the phone service
 * @param {string} args.turnId          idempotent turn identity
 * @param {number} args.expectedStateRevision Core dialogue revision
 * @param {AbortSignal} [args.signal]    call-lifecycle cancellation
 * @returns {Promise<{reply:string, profile:object, pendingField:string|null, numbers:object, readyForOptions:boolean, source:string}|null>}
 */
export async function advisorTurn({ text, profile, pendingField, language, isFirst, history,
  callIdentity, turnId, expectedStateRevision, signal }) {
  if (!config.voiceTurnUrl || !config.voiceSharedSecret) {
    console.error('[brain] VOICE_TURN_URL / VOICE_SHARED_SECRET not configured');
    return null;
  }
  let endpoint;
  try {
    endpoint = new URL(config.voiceTurnUrl);
  } catch {
    return null;
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
    || endpoint.origin !== EXPECTED_ORIGIN || endpoint.pathname !== EXPECTED_PATH
    || endpoint.search || endpoint.hash) return null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) return null;
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {
      'content-type': 'application/json',
      'x-voice-secret': config.voiceSharedSecret,
    };
    const resp = await fetch(endpoint.href, {
      method: 'POST',
      redirect: 'error',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        contractVersion: 'wwccm.voice.v2',
        mode: 'conversation',
        text,
        profile: profile || {},
        pendingField: pendingField || null,
        language: language || 'en',
        isFirst: !!isFirst,
        historySummary: boundedHistory(
          history?.at(-1)?.role === 'user' && history.at(-1)?.text === text ? history.slice(0, -1) : history,
        ),
        dialoguePolicy: {
          applicationIsOptionalGoal: true,
          answerQuestionBeforeOfferingNextStep: true,
          neverResumeInterruptedSpeech: true,
        },
        // Regulated phone copy stays deterministic unless a separately reviewed
        // validation layer is introduced for model-rephrased output.
        phrase: false,
        callIdentity,
        requestId: `request:${turnId}`,
        turnId,
        expectedStateRevision,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('[brain] non-OK', resp.status, detail.slice(0, 300));
      return null;
    }
    const data = await readBoundedJson(resp);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (typeof data.reply !== 'string' || !data.reply.trim() || data.reply.length > 2_000) return null;
    if (data.profile != null && (typeof data.profile !== 'object' || Array.isArray(data.profile))) return null;
    if (data.pendingField != null && typeof data.pendingField !== 'string') return null;
    if (data.source !== 'core-v2-voice' || (
      data.requestId !== `request:${turnId}`
      || typeof data.sessionId !== 'string'
      || !/^voice_[a-f0-9]{32}$/.test(data.sessionId)
      || data.coreStateRevision !== expectedStateRevision + 1
    )) return null;
    return {
      ...data,
      reply: data.reply.trim(),
      profile: data.profile || {},
      pendingField: data.pendingField ?? null,
    };
  } catch (err) {
    console.error('[brain] request failed:', String(err).slice(0, 200));
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

async function readBoundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('brain_response_too_large');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('brain_response_too_large');
  return JSON.parse(new TextDecoder().decode(bytes));
}
