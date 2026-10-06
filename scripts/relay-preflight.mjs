// Zero-cost preflight for Emma on ConversationRelay. Run it where the relay
// secret already lives (Render shell, or a private shell with the same env),
// after Core is armed and before the owner places a call:
//
//   VOICE_RELAY_URL=... VOICE_RELAY_KEY_ID=... VOICE_RELAY_HMAC_SECRET=... \
//   RELAY_SUITE_ID=<suite id> RENDER_URL=https://wwccm-voice.onrender.com \
//   node scripts/relay-preflight.mjs
//
// It never admits a call (no suite capacity used), never starts a turn (no
// model request, no money) and never prints the secret. It sends ONE signed
// claim_session for a random call id that was never admitted. Core can only
// answer `admission_not_found` if the function is enabled, the HMAC key id
// and secret match, the nonce store and restricted database login work, and
// the provider registry, budget and admission policy all assembled.
import { randomBytes } from 'node:crypto';
import { createRelayCoreClient } from '../src/relay-core-client.mjs';

const { VOICE_RELAY_URL, VOICE_RELAY_KEY_ID, VOICE_RELAY_HMAC_SECRET, RELAY_SUITE_ID, RENDER_URL } = process.env;
const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

if (RENDER_URL) {
  try {
    const response = await fetch(new URL('/ready', RENDER_URL), { redirect: 'error' });
    const body = await response.json();
    check('render /ready', response.status === 200 && body.ready === true && body.missing?.length === 0,
      `HTTP ${response.status}; missing=${JSON.stringify(body.missing ?? null)}`);
  } catch (error) { check('render /ready', false, error?.name ?? 'Error'); }
}

const callSid = `CA${randomBytes(16).toString('hex')}`;
try {
  const client = createRelayCoreClient({ url: VOICE_RELAY_URL, keyId: VOICE_RELAY_KEY_ID, secret: VOICE_RELAY_HMAC_SECRET, callSid });
  try {
    await client.claimSession({ suiteId: RELAY_SUITE_ID || 'preflight', greeting: 'preflight' });
    check('core relay door', false, 'a never-admitted call was claimed; stop and investigate');
  } catch (error) {
    const code = error?.detail?.code;
    const hint = {
      admission_not_found: 'armed, signed, database and configuration OK',
      relay_endpoint_disabled: 'CORE_V2_RELAY_ENABLED is not true',
      relay_service_not_configured: 'a CORE_V2_RELAY_* value, the paid/network switch, or the provider key is missing or invalid',
      relay_persistence_unavailable: 'database URL or restricted login problem',
      unauthorized: 'key id or HMAC secret differs between Render and Core (or clock skew)',
    }[code] ?? 'unexpected';
    check('core relay door', code === 'admission_not_found', `${error?.detail?.httpStatus ?? '-'} ${code ?? error?.kind}: ${hint}`);
  }
} catch (error) {
  check('core relay door', false, `client not built: ${error?.message}`);
}

for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`);
const ok = results.length > 0 && results.every((result) => result.ok);
console.log(ok ? 'PREFLIGHT PASS (no call admitted, no model request)' : 'PREFLIGHT FAIL — do not place the call');
await new Promise((resolve) => process.stdout.write('', resolve));
process.exit(ok ? 0 : 1);
