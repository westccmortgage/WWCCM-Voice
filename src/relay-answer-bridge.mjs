import { randomUUID } from 'node:crypto';
import { limitRelayCall } from './twilio-call-limit.mjs';

// Ephemeral single-use redirect tickets. Restart/lost ticket fails closed;
// durable Core admission's repeated flag prevents issuing another bootstrap.
export function createRelayAnswerBridge({ now = Date.now, limit = limitRelayCall } = {}) {
  const pending = new Map();
  return {
    begin({ callSid, caller, session, deadline, repeated }) {
      const time = now();
      for (const [id, entry] of pending) if (entry.expires < time) pending.delete(id);
      if (repeated !== false || !session || !Number.isSafeInteger(deadline)
        || deadline <= time || deadline > time + 105000 || pending.size >= 3) throw Error('answer_bridge_refused');
      const ticket = randomUUID();
      pending.set(ticket, { callSid, caller, session, deadline, expires: Math.min(deadline, time + 10000) });
      // Say answers the incoming call before Redirect asks for the next TwiML.
      // No Connect, WebSocket, Call Update or model request in this document.
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting.</Say>`
        + `<Redirect method="POST">/voice-connected?ticket=${ticket}</Redirect></Response>`;
    },
    async connect({ ticket, callSid, caller, callStatus, accountSid, webhookAccountSid, authToken }) {
      const entry = pending.get(ticket);
      if (!entry || entry.callSid !== callSid || entry.caller !== caller) throw Error('answer_bridge_refused');
      pending.delete(ticket); // Consume BEFORE dispatch, including unknown outcomes.
      if (entry.expires < now() || callStatus !== 'in-progress') throw Error('answer_bridge_refused');
      // Reserve the full HTTP deadline too; conservatively shorten the limit.
      const remaining = Math.floor((entry.deadline - now() - 5000) / 1000);
      if (remaining < 30 || remaining > 105) throw Error('answer_bridge_refused');
      await limit({ callSid, accountSid, webhookAccountSid, authToken, maximumSeconds: remaining });
      if (now() >= entry.deadline) throw Error('answer_bridge_refused');
      return entry.session;
    },
  };
}
