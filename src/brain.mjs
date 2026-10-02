// WWCCM-Voice — client for the advisor "brain".
//
// The brain is the Wallet WCCM site's /api/voice-advisor-turn route (image repo).
// It reuses the SAME deterministic engine + intake order + calculators as the web
// chat, and (optionally) phrases the reply via the provider-agnostic AI layer
// (Anthropic direct or the Measured Decision V2 gateway). We send the caller's
// transcript + the running profile; we get back a short spoken reply + updated
// state. This server never computes a mortgage number itself.

import { config } from './config.mjs';

const TIMEOUT_MS = 12_000;

/**
 * Run one advisor turn.
 * @param {object} args
 * @param {string} args.text            caller's latest utterance (from STT)
 * @param {object} args.profile         running profile for this call
 * @param {string|null} args.pendingField the field we last asked about
 * @param {string} args.language        en|ru|es|zh
 * @param {boolean} args.isFirst        first caller utterance of the call
 * @param {{role:string,text:string}[]} args.history recent turns
 * @param {AbortSignal} [args.signal]    call-lifecycle cancellation
 * @returns {Promise<{reply:string, profile:object, pendingField:string|null, numbers:object, readyForOptions:boolean, source:string}|null>}
 */
export async function advisorTurn({ text, profile, pendingField, language, isFirst, history, signal }) {
  if (!config.voiceTurnUrl || !config.voiceSharedSecret) {
    console.error('[brain] VOICE_TURN_URL / VOICE_SHARED_SECRET not configured');
    return null;
  }
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
    const resp = await fetch(config.voiceTurnUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        text,
        profile: profile || {},
        pendingField: pendingField || null,
        language: language || 'en',
        isFirst: !!isFirst,
        historySummary: (history || []).slice(-6),
        // Regulated phone copy stays deterministic unless a separately reviewed
        // validation layer is introduced for model-rephrased output.
        phrase: false,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('[brain] non-OK', resp.status, detail.slice(0, 300));
      return null;
    }
    const data = await resp.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (typeof data.reply !== 'string' || !data.reply.trim() || data.reply.length > 2_000) return null;
    if (data.profile != null && (typeof data.profile !== 'object' || Array.isArray(data.profile))) return null;
    if (data.pendingField != null && typeof data.pendingField !== 'string') return null;
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
