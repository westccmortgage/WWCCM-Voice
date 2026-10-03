import crypto from 'node:crypto';

export function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function publicRequestUrls(req, { websocket = false } = {}) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)) return [];
  const path = req.url || req.originalUrl || '/';
  if (websocket) return [`wss://${host}${path}`, `https://${host}${path}`];
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return [`${proto}://${host}${req.originalUrl || path}`];
}

export function twilioSignature(url, params, authToken) {
  const data = Object.keys(params || {})
    .sort()
    .reduce((value, key) => value + key + String(params[key] ?? ''), url);
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioRequest(req, authToken, { websocket = false } = {}) {
  if (!authToken) return false;
  const provided = req.headers['x-twilio-signature'];
  if (typeof provided !== 'string' || !provided) return false;
  const params = websocket ? {} : req.body || {};
  return publicRequestUrls(req, { websocket }).some((url) =>
    safeEqual(provided, twilioSignature(url, params, authToken)),
  );
}

export function issueCallSession(callSid, authToken, lease) {
  if (!callSid || !authToken) return '';
  if (!lease || !Number.isSafeInteger(lease.answeredAt) || !Number.isSafeInteger(lease.deadline)
    || lease.deadline <= lease.answeredAt || !/^[A-Za-z0-9_.:-]{1,80}$/.test(lease.suiteId || '')
    || !/^\+[1-9][0-9]{7,14}$/.test(lease.caller || '')
    || !Number.isInteger(lease.maximumTurns) || !Number.isInteger(lease.maximumBrainRequests)
    || !Number.isInteger(lease.maximumTtsCharacters)) return '';
  const payload = Buffer.from(
    JSON.stringify({ callSid, exp: lease.deadline, answeredAt: lease.answeredAt,
      deadline: lease.deadline, suiteId: lease.suiteId, caller: lease.caller,
      maximumTurns: lease.maximumTurns, maximumBrainRequests: lease.maximumBrainRequests,
      maximumTtsCharacters: lease.maximumTtsCharacters,
      nonce: crypto.randomBytes(16).toString('hex') }),
  ).toString('base64url');
  const mac = crypto.createHmac('sha256', authToken).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function callSessionClaims(token, expectedCallSid, authToken, now = Date.now()) {
  if (!token || !expectedCallSid || !authToken) return false;
  const [payload, providedMac, extra] = String(token).split('.');
  if (!payload || !providedMac || extra) return false;
  const expectedMac = crypto.createHmac('sha256', authToken).update(payload).digest('base64url');
  if (!safeEqual(providedMac, expectedMac)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.callSid === expectedCallSid && Number.isFinite(data.exp) && data.exp >= now
      && Number.isFinite(data.answeredAt) && Number.isFinite(data.deadline)
      && data.answeredAt <= now && data.deadline === data.exp
      && /^[A-Za-z0-9_.:-]{1,80}$/.test(data.suiteId || '')
      && /^\+[1-9][0-9]{7,14}$/.test(data.caller || '')
      && Number.isInteger(data.maximumTurns) && data.maximumTurns >= 1 && data.maximumTurns <= 60
      && Number.isInteger(data.maximumBrainRequests) && data.maximumBrainRequests >= 1 && data.maximumBrainRequests <= 100
      && Number.isInteger(data.maximumTtsCharacters) && data.maximumTtsCharacters >= 500 && data.maximumTtsCharacters <= 100000
      ? data : null;
  } catch {
    return null;
  }
}

export function verifyCallSession(token, expectedCallSid, authToken, now = Date.now()) {
  return Boolean(callSessionClaims(token, expectedCallSid, authToken, now));
}

export function validateStartIdentity(msg, authToken, now = Date.now()) {
  const streamSid = String(msg?.start?.streamSid || msg?.streamSid || '');
  const callSid = String(msg?.start?.callSid || '');
  const params = msg?.start?.customParameters || {};
  const claims = callSessionClaims(params.session, callSid, authToken, now);
  const valid =
    /^MZ[a-f0-9]{32}$/i.test(streamSid) &&
    /^CA[a-f0-9]{32}$/i.test(callSid) &&
    params.callSid === callSid && claims;
  return valid ? { streamSid, callSid, answeredAt: claims.answeredAt, deadline: claims.deadline,
    suiteId: claims.suiteId, caller: claims.caller, maximumTurns: claims.maximumTurns,
    maximumBrainRequests: claims.maximumBrainRequests,
    maximumTtsCharacters: claims.maximumTtsCharacters } : null;
}
