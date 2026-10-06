// Dormant protocol adapter: not imported by server.mjs. No provider SDK or keys.
import { createHash } from 'node:crypto';
import { verifyTwilioRequest, validateRelaySession } from './security.mjs';
import { RelayPreSubmissionError } from './relay-text-model.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000;

// Extract only explicit, first-person assertions. Hypotheticals/third parties
// stay in the transcript; they cannot overwrite authoritative caller facts.
export function callerFacts(text) {
  if (/\b(if|suppose|hypothetical|hypothetically|friend|neighbor|neighbour)\b/i.test(text)) return {};
  const facts = {};
  const name = text.match(/\bmy name is ([A-Z][a-z]{1,30})(?=[.,! ]|$)|\b(?:I'm|I am) ([A-Z][a-z]{1,30})(?=[.,!]|$)/);
  if (name) facts.name = name[1] ?? name[2];
  const goal = text.match(/\bI (?:want|need) (?:to )?([^.!?]{3,250})/i);
  if (goal && !/^\$?\d/.test(goal[1])) facts.goal = goal[1].trim();
  const rate = text.match(/\bmy (?:current )?(?:mortgage )?rate is (?:now )?(\d+(?:\.\d+)?)\s*(?:%|percent)/i);
  if (rate && +rate[1] >= 0 && +rate[1] <= 30) facts.mortgageRatePercent = +rate[1];
  const income = text.match(/\bmy monthly income is \$([\d,]+(?:\.\d{1,2})?)/i);
  if (income) facts.monthlyIncomeUsd = +income[1].replaceAll(',', '');
  const repairs = text.match(/\bI (?:want|need) \$([\d,]+(?:\.\d{1,2})?) for repairs/i);
  if (repairs) facts.repairsUsd = +repairs[1].replaceAll(',', '');
  const limit = text.match(/\bI can (?:put|pay) (?:up to )?\$([\d,]+(?:\.\d{1,2})?) (?:a|per) month/i);
  if (limit) facts.repairsPaymentLimitUsd = +limit[1].replaceAll(',', '');
  for (const [key,value] of Object.entries(facts)) if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 1e9)) delete facts[key];
  return facts;
}

// Backend is deliberately mandatory: a production implementation must supply
// durable CAS/idempotency, cost reservations/settlement and reply authorization.
// Ordinary conversation does not call Core's propose/finalize planner.
export function createConversationRelay({ request, authToken, accountSid, lease,
  backend, model, send, now = Date.now, schedule = setTimeout, unschedule = clearTimeout }) {
  const required = ['claimSession', 'claimTurn', 'reserve', 'settle', 'hold', 'release', 'approveReply', 'prepareReply', 'markSubmitted', 'claimDispatch', 'interrupt'];
  const claims = validateRelaySession(lease?.session, lease?.callSid, authToken, now());
  if (!verifyTwilioRequest(request, authToken, { websocket: true }) || !/^AC[a-f0-9]{32}$/i.test(accountSid)
    || !claims || Object.entries(claims).some(([key, value]) => lease[key] !== value)
    || !Number.isSafeInteger(lease.deadline) || lease.deadline <= now()
    || lease.deadline > claims.answeredAt + 120_000
    || !Number.isInteger(lease.maximumTurns) || lease.maximumTurns < 1 || lease.maximumTurns > 17
    || !Number.isInteger(lease.maximumRequests) || lease.maximumRequests < 1 || lease.maximumRequests > 34
    || !Number.isInteger(lease.maximumCharacters) || lease.maximumCharacters < 1 || lease.maximumCharacters > 4000
    || required.some(key => typeof backend?.[key] !== 'function') || typeof model?.generate !== 'function'
    || typeof send !== 'function') throw Error('relay_not_authorized');
  let ready = false, closed = false, busy = null, revision = 0, epoch = 0, requests = 0, characters = 0;
  let state = null, lastReply = null; const finalPrompts = new Set();
  const deadlineTimer = schedule(() => { void close('deadline'); }, lease.deadline - now());
  function emit(message) { if (!closed && now() < lease.deadline) send(message); }
  async function close(reason = 'closed') {
    if (closed) return;
    closed = true; const previousEpoch = epoch; epoch++; busy?.controller.abort(); unschedule(deadlineTimer);
    if (ready) {
      try { await backend.interrupt({ callSid: lease.callSid, revision, expectedEpoch: previousEpoch, epoch,
        fenceRequestId: busy?.requestId ?? null, playbackRequestId: lastReply?.requestId ?? null,
        spokenPrefix: '', delivery: 'interrupted', reason }); }
      catch { /* Session stays closed; no paid operation or replay can follow. */ }
    }
    send({ type: 'end', handoffData: JSON.stringify({ reason }) });
  }
  async function run(text) {
    const job = { controller: new AbortController(), epoch, submitted: false, reservation: null, accounted: false };
    busy = job;
    try {
      const requestId = `${lease.callSid}:relay:${revision + 1}`; job.requestId = requestId;
      const requestDigest = hash(JSON.stringify([lease.callSid, revision, text]));
      const patches = callerFacts(text);
      const factEvidence = Object.fromEntries(Object.keys(patches).map(key => [key, {
        entity: 'caller', scope: 'current', verification: 'caller_asserted',
        sourceRequestId: requestId, sourceTextSha256: hash(text), revision: revision + 1,
        supersedesRevision: state?.factEvidence?.[key]?.revision ?? null,
      }]));
      const context = await backend.claimTurn({ callSid: lease.callSid, requestId, expectedRevision: revision,
        requestDigest, expectedEpoch: job.epoch, text, callerFacts: patches, factEvidence });
      if (context.repeated || context.callSid !== lease.callSid || context.requestId !== requestId || context.requestDigest !== requestDigest || context.epoch !== job.epoch || context.revision !== revision + 1 || !context.state?.facts || !Array.isArray(context.state.history)) throw Error('relay_readback_invalid');
      revision = context.revision; state = clone(context.state);
      if (closed || job.controller.signal.aborted || job.epoch !== epoch || now() >= lease.deadline) return;
      job.reservation = await backend.reserve({ callSid: lease.callSid, requestId, revision,
        maximumRequests: lease.maximumRequests, deadline: lease.deadline });
      if (!job.reservation?.id || !job.reservation.pricingSnapshot || job.reservation.authorized !== true
        || job.reservation.callSid !== lease.callSid || job.reservation.requestId !== requestId || job.reservation.revision !== revision) throw Error('relay_budget_denied');
      if (closed || job.controller.signal.aborted || job.epoch !== epoch || now() >= lease.deadline) return;
      if (++requests > lease.maximumRequests) throw Error('relay_request_limit');
      const dispatch = await backend.claimDispatch({ callSid: lease.callSid, requestId, revision, reservationId: job.reservation.id, expectedEpoch: job.epoch });
      if (dispatch?.claimed !== true || dispatch.providerRequests !== 1 || dispatch.requestId !== requestId || dispatch.reservationId !== job.reservation.id) throw Error('relay_dispatch_not_claimed');
      if (closed || job.controller.signal.aborted || job.epoch !== epoch) return;
      job.submitted = true;
      const result = await model.generate({ text, facts: clone(state.facts), history: clone(state.history.slice(-8)),
        factEvidence: clone(state.factEvidence ?? {}),
        businessFacts: clone(state.businessFacts ?? {}),
        requestId, signal: job.controller.signal, reservation: clone(job.reservation), attempt: clone(dispatch),
        instruction: 'You are Emma. Start with the caller goal, remember their name and confirmed facts, answer naturally and concisely. Do not restart a questionnaire. Never invent mortgage figures, eligibility, rates or action status. Financial assertions need authorized tool evidence.' });
      if (!result?.rawUsage) throw Error('relay_usage_unknown');
      // Even a cancelled response can be billed. Settle authoritative raw usage
      // before fencing its output; backend enforces pricing/token ceilings.
      const settlement = await backend.settle({ reservationId: job.reservation.id, requestId, rawUsage: result.rawUsage });
      if (settlement?.state !== 'settled' || settlement.reservationId !== job.reservation.id || settlement.requestId !== requestId || settlement.providerRequests !== 1) throw Error('relay_usage_unknown');
      job.accounted = true;
      if (closed || job.controller.signal.aborted || job.epoch !== epoch || now() >= lease.deadline) return;
      if (!validText(result.text)) throw Error('relay_reply_invalid');
      const approval = await backend.approveReply({ callSid: lease.callSid, requestId, revision,
        text: result.text, facts: clone(state.facts), evidence: result.evidence ?? [] });
      if (approval?.approved !== true || approval.text !== result.text || !Array.isArray(approval.receiptIds)) throw Error('relay_reply_not_grounded');
      if (closed || job.controller.signal.aborted || job.epoch !== epoch || now() >= lease.deadline) return;
      if (characters + result.text.length > lease.maximumCharacters) throw Error('relay_character_limit');
      const committed = await backend.prepareReply({ callSid: lease.callSid, requestId, revision,
        expectedEpoch: job.epoch, text: result.text, receiptIds: approval.receiptIds, delivery: 'prepared' });
      if (committed?.revision !== revision || committed.requestId !== requestId || committed.epoch !== job.epoch) throw Error('relay_commit_unknown');
      if (closed || job.controller.signal.aborted || job.epoch !== epoch || now() >= lease.deadline) return;
      characters += result.text.length; lastReply = { requestId, revision, text: result.text };
      // Only approved text reaches TTS. 'submitted' never means 'heard'.
      await send({ type: 'text', token: result.text, last: true, interruptible: true, preemptible: true },
        { signal: job.controller.signal, deadline: lease.deadline });
      if (closed || job.controller.signal.aborted || job.epoch !== epoch || now() >= lease.deadline) return;
      const delivered = await backend.markSubmitted({ callSid: lease.callSid, requestId, revision, expectedEpoch: job.epoch, delivery: 'submitted' });
      if (delivered?.requestId !== requestId || !['submitted', 'interrupted'].includes(delivered.delivery)) throw Error('relay_send_readback_unknown');
    } catch (error) {
      if (error instanceof RelayPreSubmissionError) job.submitted = false;
      await close(job.submitted && !job.accounted ? 'provider_outcome_unknown' : 'conversation_unavailable');
    } finally {
      if (job.reservation && !job.accounted) {
        if (job.submitted) await backend.hold({ reservationId: job.reservation.id, reason: 'outcome_unknown' });
        else await backend.release({ reservationId: job.reservation.id, reason: 'not_submitted' });
      }
      if (busy === job) busy = null;
    }
  }
  async function receive(message) {
    if (closed || now() >= lease.deadline) return close('deadline');
    if (message?.type === 'setup') {
      if (ready || busy || message.accountSid !== accountSid || message.callSid !== lease.callSid
        || message.from !== lease.caller || message.customParameters?.session !== lease.session) return close('invalid_setup');
      busy = { controller: new AbortController() };
      try {
        const claimed = await backend.claimSession({ callSid: lease.callSid, session: lease.session,
          caller: lease.caller, suiteId: lease.suiteId, deadline: lease.deadline });
        if (closed || claimed?.claimed !== true || claimed?.revision !== 0 || claimed?.callSid !== lease.callSid || claimed?.suiteId !== lease.suiteId) return close('session_claim_denied');
        state = clone(claimed.state); ready = true;
      } catch { await close('session_claim_unknown'); }
      finally { busy = null; }
      return;
    }
    if (!ready) return close('setup_required');
    if (message?.type === 'interrupt') {
      if (typeof message.utteranceUntilInterrupt !== 'string' || message.utteranceUntilInterrupt.length > 4000
        || !Number.isFinite(message.durationUntilInterruptMs) || message.durationUntilInterruptMs < 0) return close('invalid_interrupt');
      const previousEpoch = epoch; epoch++; busy?.controller.abort();
      // The supplied prefix is only a playback report. Never promote its text
      // to caller facts, financial evidence, or a fully delivered response.
      const prefix = lastReply?.text.startsWith(message.utteranceUntilInterrupt) ? message.utteranceUntilInterrupt : '';
      try {
        const fence = await backend.interrupt({ callSid: lease.callSid, revision, expectedEpoch: previousEpoch, epoch,
          fenceRequestId: busy?.requestId ?? null, playbackRequestId: lastReply?.requestId ?? null,
          spokenPrefix: prefix, delivery: 'interrupted' });
        if (fence?.epoch !== epoch) await close('interrupt_fence_unknown');
      } catch { await close('interrupt_fence_unknown'); }
      return;
    }
    if (message?.type === 'prompt') {
      if (message.last !== true) return; // No speculative paid generation.
      if (!validText(message.voicePrompt)) return close('invalid_prompt');
      const text = message.voicePrompt.trim();
      // Relay exposes no stable prompt event ID. Fail closed on an identical
      // final anywhere in this exclusive call; never buy a delayed replay.
      const finalDigest = hash(text); if (finalPrompts.has(finalDigest)) return;
      if (busy) return close('overlapping_turn');
      if (revision >= lease.maximumTurns) return close('turn_limit');
      finalPrompts.add(finalDigest);
      return run(text);
    }
    if (message?.type === 'error') return close('relay_error');
    if (message?.type === 'dtmf') return close('dtmf_handoff');
    return close('unknown_message');
  }
  return { receive, close, snapshot: () => ({ ready, closed, revision, requests, characters, busy: Boolean(busy), state: clone(state) }) };
}
