import { randomUUID } from 'node:crypto';
import { limitRelayCall } from './twilio-call-limit.mjs';

// Ephemeral single-use redirect tickets. Restart/lost ticket fails closed;
// durable Core admission's repeated flag prevents issuing another bootstrap.
export function createRelayAnswerBridge({ now = Date.now, limit = limitRelayCall } = {}) {
  const pending = new Map();
  return {
    begin({ callSid, caller, session, deadline, maximumSeconds, repeated, opening }) {
      const time = now();
      for (const [id, entry] of pending) if (entry.expires < time) pending.delete(id);
      if (repeated !== false || !session || typeof opening !== 'string' || !opening || opening.length > 1000
        || !Number.isSafeInteger(maximumSeconds) || maximumSeconds < 30 || maximumSeconds > 105
        || !Number.isSafeInteger(deadline)
        || deadline <= time || deadline > time + 105000 || pending.size >= 3) throw Error('answer_bridge_refused');
      const ticket = randomUUID();
      pending.set(ticket, { callSid, caller, session, deadline, maximumSeconds, expires: Math.min(deadline, time + 45000) });
      // Say answers the incoming call before Redirect asks for the next TwiML.
      // No Connect, WebSocket, Call Update or model request in this document.
      const spoken = opening.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US" voice="woman" loop="1">${spoken}</Say>`
        + `<Redirect method="POST">/voice-connected?ticket=${ticket}#ct=1000&amp;rt=5000&amp;tt=5000&amp;rc=0</Redirect></Response>`;
    },
    async connect({ ticket, callSid, caller, callStatus, accountSid, webhookAccountSid, authToken }) {
      const entry = pending.get(ticket);
      if (!entry || entry.callSid !== callSid || entry.caller !== caller) throw Error('answer_bridge_refused');
      pending.delete(ticket); // Consume BEFORE dispatch, including unknown outcomes.
      if (entry.expires < now() || callStatus !== 'in-progress') throw Error('answer_bridge_refused');
      // Keep the full HTTP budget inside the original session deadline.
      if (entry.deadline - now() <= 5000) throw Error('answer_bridge_refused');
      // Twilio counts TimeLimit from call answer, not from this update.
      await limit({ callSid, accountSid, webhookAccountSid, authToken, maximumSeconds: entry.maximumSeconds });
      if (now() >= entry.deadline) throw Error('answer_bridge_refused');
      return entry.session;
    },
  };
}
