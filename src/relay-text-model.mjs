// Server-side transport is injected. No env/key lookup, provider call on import,
// schema tool, planning phase, automatic retry, or SDK dependency.
export const RELAY_MODEL = 'claude-haiku-4-5-20251001';
export class RelayPreSubmissionError extends Error {}
export function createRelayTextModel({ transport }) {
  if (typeof transport !== 'function') throw Error('relay_model_transport_missing');
  const submittedReservations = new Set();
  return {
    async generate({ text, facts, factEvidence, businessFacts, history, instruction, requestId, signal, reservation, attempt }) {
      const pricing = reservation?.pricingSnapshot;
      if (submittedReservations.has(reservation?.id)) throw Error('relay_reservation_already_submitted');
      if (signal.aborted || attempt?.claimed !== true || attempt.providerRequests !== 1 || attempt.reservationId !== reservation?.id || attempt.requestId !== requestId || pricing?.model !== RELAY_MODEL || pricing.maximumInputTokens !== 8000
        || pricing.maximumOutputTokens !== 400 || !reservation.id) throw new RelayPreSubmissionError('relay_model_not_reserved');
      const context = JSON.stringify({ callerFacts: facts, factEvidence: factEvidence ?? {},
        configuredBusinessFacts: businessFacts ?? {}, history, currentUtterance: text });
      // Conservative byte headroom; authority must still check actual usage.
      // Do not silently truncate caller facts to fit an old prose transcript.
      if (Buffer.byteLength(context + instruction, 'utf8') > 6000) throw new RelayPreSubmissionError('relay_context_too_large');
      submittedReservations.add(reservation.id);
      const response = await transport({ requestId, reservationId: reservation.id, attempt, signal,
        body: { model: RELAY_MODEL, max_tokens: 400, stream: false, system: instruction,
          messages: [{ role: 'user', content: context }] } });
      if (response?.status !== 200 || response.body?.model !== RELAY_MODEL || !response.body.usage
        || !Number.isSafeInteger(response.body.usage.input_tokens) || response.body.usage.input_tokens < 0
        || !Number.isSafeInteger(response.body.usage.output_tokens) || response.body.usage.output_tokens < 0
        || response.body.usage.input_tokens > 8000 || response.body.usage.output_tokens > 400
        || (response.body.usage.cache_creation_input_tokens ?? 0) !== 0
        || (response.body.usage.cache_read_input_tokens ?? 0) !== 0) throw Error('relay_model_outcome_unusable');
      const usable = response.body.stop_reason === 'end_turn' && Array.isArray(response.body.content)
        && response.body.content.length === 1 && response.body.content[0].type === 'text'
        && typeof response.body.content[0].text === 'string';
      // Preserve known raw usage even when a completion is truncated/refused.
      // The engine settles it, then rejects empty unusable speech without retry.
      return { text: usable ? response.body.content[0].text : '', rawUsage: response.body.usage,
        evidence: [], ...(usable ? {} : { unusableReason: 'incomplete_text_result' }) };
    },
  };
}
