// Twilio Call resource Update TimeLimit: a total call limit, independent of
// WebSocket setup. Uses the existing runtime account/token, never new keys.
// https://www.twilio.com/docs/voice/api/call-resource#update-a-call-resource
export async function limitRelayCall({ callSid, accountSid, webhookAccountSid, authToken,
  maximumSeconds, fetchImpl = fetch }) {
  if (!/^CA[a-f0-9]{32}$/i.test(callSid || '') || !/^AC[a-f0-9]{32}$/i.test(accountSid || '')
    || webhookAccountSid !== accountSid || !authToken || !Number.isInteger(maximumSeconds)
    || maximumSeconds < 30 || maximumSeconds > 105) throw Error('call_limit_invalid');
  const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ TimeLimit: String(maximumSeconds) }).toString(),
  }); // Exactly one attempt; never retry an ambiguous response.
  if (!response.ok) throw Error('call_limit_unconfirmed');
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 16384) throw Error('call_limit_unconfirmed');
  const call = JSON.parse(raw);
  if (call.sid !== callSid || call.account_sid !== accountSid) throw Error('call_limit_unconfirmed');
}
