import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadiness } from '../src/readiness.mjs';

const base = {
  runtimeEnabled: true, twilioAuthToken: 'token', transport: 'relay',
  limits: { maxCallSeconds: 105 },
  relay: { accountSid: 'AC' + 'b'.repeat(32), url: 'https://hbqlhplgqwuesrovbiye.supabase.co/functions/v1/core-v2-voice-relay', keyId: 'render-relay', secret: 'x'.repeat(40) },
  admission: { mode: 'test', allowedCaller: '+13105550100' },
};

test('relay mode needs only Twilio, the owner test admission and the signed Core door — no STT/TTS keys, no Netlify', () => {
  assert.deepEqual(buildReadiness(base), { ready: true, missing: [] });
});

test('relay mode fails closed on a wrong Core URL, short secret or unknown transport', () => {
  assert.deepEqual(buildReadiness({ ...base, relay: { ...base.relay, url: 'https://evil.example/functions/v1/core-v2-voice-relay' } }).missing, ['VOICE_RELAY_URL']);
  assert.deepEqual(buildReadiness({ ...base, relay: { ...base.relay, secret: 'short' } }).missing, ['VOICE_RELAY_HMAC_SECRET']);
  assert.ok(buildReadiness({ ...base, transport: 'carrier-pigeon' }).missing.includes('VOICE_TRANSPORT'));
  assert.ok(buildReadiness({ ...base, runtimeEnabled: false }).missing.includes('VOICE_RUNTIME_ENABLED'));
  assert.ok(buildReadiness({ ...base, admission: { mode: 'disabled' } }).missing.includes('VOICE_ADMISSION_MODE'));
});

test('the default transport is unchanged: media-stream still requires its speech providers', () => {
  const legacy = buildReadiness({ ...base, transport: undefined, voiceSharedSecret: 'shared',
    admission: { mode: 'test', allowedCaller: '+13105550100', url: 'https://walletwccm.com/api/voice-admission' }, voiceTurnUrl: 'https://walletwccm.com/api/voice-advisor-turn', speech: { provider: 'legacy' } });
  assert.ok(legacy.missing.includes('DEEPGRAM_API_KEY'));
});
