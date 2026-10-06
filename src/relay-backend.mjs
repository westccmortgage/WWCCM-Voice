// Thin control/readback transport contract. No deployment supplies this yet.
// Sign/authenticate and implement its durable transactions on the server side.
import { createHash } from 'node:crypto';
const actions = ['claimSession', 'claimTurn', 'reserve', 'settle', 'hold', 'release', 'approveReply', 'prepareReply', 'markSubmitted', 'claimDispatch', 'interrupt'];
export function createRelayBackend({ exchange, callSid, suiteId }) {
  if (typeof exchange !== 'function' || !/^CA[a-f0-9]{32}$/i.test(callSid)
    || !/^[A-Za-z0-9_.:-]{1,80}$/.test(suiteId)) throw Error('relay_backend_not_configured');
  let sequence = 0, closed = false;
  return Object.fromEntries(actions.map(action => [action, async input => {
    if ((closed && !['settle', 'hold', 'release'].includes(action))
      || input?.callSid && input.callSid !== callSid) throw Error('relay_backend_closed');
    const operationId = `${callSid}:control:${++sequence}`;
    const unsigned = { protocol: 'wwccm.relay-control.1', action, callSid, suiteId, operationId, input };
    const serialized = JSON.stringify(unsigned);
    if (Buffer.byteLength(serialized) > 32000) throw Error('relay_backend_request_too_large');
    const requestDigest = createHash('sha256').update(serialized).digest('hex');
    try {
      // No retries. Exchange must persist idempotency/lease/budget state and
      // return exact authoritative operation-bound readback, never local guesses.
      const response = await exchange({ ...unsigned, requestDigest });
      if (response?.protocol !== 'wwccm.relay-control-result.1' || response.action !== action
        || response.operationId !== operationId || response.callSid !== callSid || response.suiteId !== suiteId
        || response.requestDigest !== requestDigest || response.committed !== true
        || !response.result || typeof response.result !== 'object') throw Error('relay_backend_readback_unknown');
      return response.result;
    } catch (error) {
      // Settlement/hold operations must remain available to quarantine a paid
      // outcome even when a different operation's readback became unknown.
      if (!['settle', 'hold', 'release'].includes(action)) closed = true;
      throw error;
    }
  }]));
}
