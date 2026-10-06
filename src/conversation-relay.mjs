// Emma on Twilio ConversationRelay: the phone side of one call.
//
// Twilio does speech recognition, speech synthesis and barge-in, and sends
// this socket text. For each final caller utterance this module makes ONE
// signed request to Core's relay door, which claims the turn, reserves the
// money, makes the model request, settles it and clears what may be said.
// This module only decides what to do with the answer on the phone:
//
//  - speak a cleared reply, and report on the next request whether it was
//    handed to Twilio, cut off by the caller (with the heard prefix), or
//    discarded because the caller had already moved on;
//  - if the caller speaks while a reply is being prepared, the old reply is
//    discarded unheard and the new words are answered next (never two model
//    requests in flight for one call; never a resend of the same turn);
//  - say something specific when a turn cannot be answered: a known provider
//    refusal asks the caller to repeat (once), a limit ends politely, and an
//    outcome nobody knows ends the call without guessing or retrying;
//  - goodbye is handled here, without a model request.
//
// "Submitted" never means "heard". Nothing here computes a mortgage figure.
import { verifyTwilioRequest, validateRelaySession } from './security.mjs';

export const RELAY_LINES = Object.freeze({
  retry: 'Sorry, I had trouble with that. Could you say it again?',
  unavailable: "I'm sorry, I'm having a technical problem and can't safely continue this call right now. Please call West Coast Capital Mortgage again shortly. Goodbye.",
  limit: "We've reached the time limit for this call. Thank you for calling West Coast Capital Mortgage. Goodbye.",
  goodbye: 'Thanks for calling West Coast Capital Mortgage. Goodbye.',
});

const GOODBYE = /^(?:(?:ok(?:ay)?|alright|great|thanks|thank you|no|nope)[,.!\s]+)*(?:good ?bye|bye(?: bye)?|that'?s all|that'?s it|i'?m (?:all )?done|hang up|have a (?:good|nice|great) (?:day|one|night))\b/i;
const LIMIT_CODES = new Set(['turn_limit', 'request_limit', 'budget_exhausted', 'relay_deadline', 'relay_closed', 'admission_expired']);

/* Rough spoken length, so "end" is sent after the last line, not over it. */
export const speechMs = (text) => 1_500 + text.length * 65;

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function createConversationRelay({ request, authToken, accountSid = null, greeting, coreFactory, send,
  now = Date.now, schedule = setTimeout, unschedule = clearTimeout, log = (line) => console.log(JSON.stringify(line)) }) {
  if (!verifyTwilioRequest(request, authToken, { websocket: true }) || typeof coreFactory !== 'function'
    || typeof send !== 'function' || typeof greeting !== 'string' || !greeting) throw Error('relay_not_authorized');

  let claims = null, core = null, ready = false, closed = false, ending = false;
  let revision = 0, providerFailures = 0;
  let inFlight = null;        // { requestId, superseded }
  let pending = null;         // { text, promptAt } — newest words while a turn is in flight
  let lastReply = null;       // { requestId, text, delivery, spokenPrefix }
  let reported = null;        // requestId whose delivery Core already knows
  let deadlineTimer = null, endTimer = null;
  const latencies = [];

  const emit = (message) => { if (!closed) send(message); };

  function previousDelivery() {
    if (!lastReply || reported === lastReply.requestId) return null;
    return { requestId: lastReply.requestId, delivery: lastReply.delivery,
      ...(lastReply.delivery === 'interrupted' && lastReply.spokenPrefix ? { spokenPrefix: lastReply.spokenPrefix } : {}) };
  }

  async function finish(reason, line = null) {
    if (ending || closed) return;
    ending = true;
    pending = null;
    if (deadlineTimer) unschedule(deadlineTimer);
    if (line) emit({ type: 'text', token: line, last: true, interruptible: false, preemptible: false });
    const previous = previousDelivery();
    if (core) {
      try {
        const result = await core.close({ reason, previous });
        if (previous) reported = previous.requestId;
        log({ event: 'relay_call', reason, turns: revision, providerRequests: result.providerRequests,
          settledUsd: result.settledUsd, heldUsd: result.heldUsd, reservedUsd: result.reservedUsd,
          promptToTextP50Ms: percentile(latencies, 50), promptToTextP95Ms: percentile(latencies, 95),
          promptToTextMaxMs: latencies.length ? Math.max(...latencies) : null, measuredTurns: latencies.length });
      } catch (error) {
        log({ event: 'relay_call', reason, closeRecorded: false, failure: error?.kind ?? 'unknown', ...(error?.detail ?? {}),
          promptToTextP95Ms: percentile(latencies, 95), measuredTurns: latencies.length });
      }
    }
    endTimer = schedule(() => {
      if (!closed) send({ type: 'end', handoffData: JSON.stringify({ reason }) });
      closed = true;
    }, line ? speechMs(line) : 0);
  }

  async function runTurn(text, promptAt) {
    const requestId = `${claims.callSid}:relay:${revision + 1}`;
    const job = { requestId, superseded: false };
    inFlight = job;
    const previous = previousDelivery();
    const sentAt = now();
    let result;
    try {
      result = await core.turn({ requestId, expectedRevision: revision, utterance: text, previous });
    } catch (error) {
      inFlight = null;
      log({ event: 'relay_turn', requestSeq: revision + 1, status: `core_${error?.kind ?? 'unknown'}`, ...(error?.detail ?? {}),
        coreMs: now() - sentAt });
      if (error?.kind === 'refused' && LIMIT_CODES.has(error.detail?.code)) return finish('limit_reached', RELAY_LINES.limit);
      return finish(error?.kind === 'refused' ? 'core_refused' : 'core_outcome_unknown', RELAY_LINES.unavailable);
    }
    inFlight = null;
    if (previous) reported = previous.requestId;
    if (Number.isSafeInteger(result.revision) && result.revision > revision) revision = result.revision;
    const coreMs = now() - sentAt;
    const base = { event: 'relay_turn', requestSeq: revision, status: result.status, coreMs, core: result.timings,
      httpStatus: result.diagnostics?.httpStatus, errorType: result.diagnostics?.errorType,
      providerRequestId: result.diagnostics?.providerRequestId, diagnosticCode: result.diagnostics?.code };

    if (result.status === 'refused') {
      log({ ...base, code: result.code });
      return finish(LIMIT_CODES.has(result.code) ? 'limit_reached' : 'core_refused',
        LIMIT_CODES.has(result.code) ? RELAY_LINES.limit : RELAY_LINES.unavailable);
    }
    if (result.status !== 'answered' && result.status !== 'provider_failed') {
      // provider_unknown, accounting_unknown, repeated: an outcome nobody
      // knows. Stop; the hold is reconciled later, never retried here.
      log(base);
      return finish('provider_outcome_unknown', RELAY_LINES.unavailable);
    }

    let line = null, kind = null;
    if (result.status === 'answered' && result.reply?.text) {
      line = result.reply.text; kind = result.reply.kind;
      lastReply = { requestId, text: line, delivery: 'submitted', spokenPrefix: null };
    } else if (result.status === 'answered') {
      lastReply = { requestId, text: '', delivery: 'discarded', spokenPrefix: null };
      kind = 'withheld';
    } else {
      providerFailures += 1;
      log({ ...base, providerFailures });
      return finish('provider_failed', RELAY_LINES.unavailable);
    }

    if (job.superseded || ending || closed) {
      // The caller kept talking; this answer is no longer to what they said.
      if (lastReply?.requestId === requestId) lastReply.delivery = 'discarded';
      log({ ...base, replyKind: kind, delivered: false, superseded: job.superseded });
    } else if (line) {
      emit({ type: 'text', token: line, last: true, interruptible: true, preemptible: true });
      const promptToTextMs = now() - promptAt;
      latencies.push(promptToTextMs);
      log({ ...base, replyKind: kind, delivered: true, promptToTextMs, characters: line.length });
    } else {
      log({ ...base, replyKind: kind, delivered: false });
    }
    if (pending && !ending && !closed) {
      const next = pending; pending = null;
      return runTurn(next.text, next.promptAt);
    }
  }

  async function receive(message) {
    if (closed || ending) return;
    if (message?.type === 'setup') {
      if (ready || core) return finish('invalid_setup');
      const params = message.customParameters || {};
      claims = validateRelaySession(params.session, message.callSid, authToken, now());
      if (!claims || params.callSid !== message.callSid || message.from !== claims.caller
        || (accountSid && message.accountSid !== accountSid)) {
        claims = null;
        return finish('invalid_setup');
      }
      try {
        core = coreFactory(claims.callSid);
        const claimed = await core.claimSession({ suiteId: claims.suiteId, greeting });
        if (claimed?.claimed !== true || claimed.suiteId !== claims.suiteId) throw Object.assign(Error('claim'), { kind: 'refused' });
      } catch (error) {
        log({ event: 'relay_session', status: 'claim_failed', failure: error?.kind ?? 'unknown', ...(error?.detail ?? {}) });
        core = null; // nothing was claimed, so there is nothing to close
        return finish('session_claim_failed', RELAY_LINES.unavailable);
      }
      ready = true;
      deadlineTimer = schedule(() => { void finish('deadline', RELAY_LINES.limit); }, Math.max(0, claims.deadline - now() - 8_000));
      log({ event: 'relay_session', status: 'claimed' });
      return;
    }
    if (!ready) return finish('setup_required');
    if (message?.type === 'interrupt') {
      // A playback report from Twilio. It never becomes caller speech.
      if (lastReply && lastReply.delivery === 'submitted' && reported !== lastReply.requestId) {
        const prefix = typeof message.utteranceUntilInterrupt === 'string' ? message.utteranceUntilInterrupt.trim() : '';
        lastReply.delivery = 'interrupted';
        lastReply.spokenPrefix = prefix && lastReply.text.startsWith(prefix) ? prefix : null;
      }
      return;
    }
    if (message?.type === 'prompt') {
      if (message.last !== true) return; // partials never buy anything
      const text = typeof message.voicePrompt === 'string' ? message.voicePrompt.trim() : '';
      if (!text) return;
      if (text.length > 4000) return finish('invalid_prompt', RELAY_LINES.unavailable);
      const promptAt = now();
      if (GOODBYE.test(text) && text.split(/\s+/).length <= 8) {
        if (inFlight) inFlight.superseded = true;
        return finish('caller_goodbye', RELAY_LINES.goodbye);
      }
      if (inFlight) {
        inFlight.superseded = true;
        pending = pending ? { text: `${pending.text} ${text}`, promptAt: pending.promptAt } : { text, promptAt };
        return;
      }
      return runTurn(text, promptAt);
    }
    if (message?.type === 'dtmf') return; // keypad input is not part of this pilot
    if (message?.type === 'error') {
      log({ event: 'relay_twilio_error', description: String(message.description ?? '').replace(/\d{5,}/g, '<number>').slice(0, 120) });
      return finish('twilio_error');
    }
    return finish('unknown_message');
  }

  function socketClosed() {
    if (closed) return;
    void finish('socket_closed').then(() => { closed = true; if (endTimer) unschedule(endTimer); });
  }

  return {
    receive,
    socketClosed,
    snapshot: () => ({ ready, closed, ending, revision, providerFailures, inFlight: Boolean(inFlight),
      pending: pending?.text ?? null, lastReply: lastReply && { ...lastReply }, latencies: [...latencies] }),
  };
}
