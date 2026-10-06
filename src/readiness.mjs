const SUPPORTED_SPEECH_MODELS = Object.freeze({
  cloudflareStt: Object.freeze(['@cf/deepgram/nova-3']),
  cloudflareTts: Object.freeze(['@cf/deepgram/aura-1']),
  deepgram: Object.freeze(['nova-2']),
  elevenlabs: Object.freeze(['eleven_turbo_v2_5']),
});

const publicModelIdentifier = (value, kind) => (
  SUPPORTED_SPEECH_MODELS[kind]?.includes(value) ? value : 'invalid'
);

export function buildReadiness(config) {
  const missing = [];
  const present = (value) => typeof value === 'string' && value.trim().length > 0;
  if (config.runtimeEnabled !== true) missing.push('VOICE_RUNTIME_ENABLED');
  if (!present(config.twilioAuthToken)) missing.push('TWILIO_AUTH_TOKEN');
  const transport = config.transport || 'media-stream';
  if (transport !== 'media-stream' && transport !== 'relay') missing.push('VOICE_TRANSPORT');
  if (transport !== 'relay' && !present(config.voiceTurnUrl)) missing.push('VOICE_TURN_URL');
  if (transport !== 'relay' && !present(config.voiceSharedSecret)) missing.push('VOICE_SHARED_SECRET');
  if (transport === 'relay') {
    try {
      const url = new URL(config.relay?.url || '');
      if (url.protocol !== 'https:' || url.pathname !== '/functions/v1/core-v2-voice-relay'
        || !url.hostname.endsWith('.supabase.co')) missing.push('VOICE_RELAY_URL');
    } catch { missing.push('VOICE_RELAY_URL'); }
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(config.relay?.keyId || '')) missing.push('VOICE_RELAY_KEY_ID');
    if (String(config.relay?.secret || '').length < 32) missing.push('VOICE_RELAY_HMAC_SECRET');
  }
  const admission = config.admission || {};
  if (admission.mode === 'test') {
    if (!/^\+[1-9]\d{7,14}$/.test(admission.allowedCaller || '')) missing.push('VOICE_TEST_ALLOWED_CALLER');
    if (transport === 'relay') {
      // Admission goes through the signed Core relay door in this mode.
    } else if (!present(admission.url)) missing.push('VOICE_ADMISSION_URL');
    else try {
      const url = new URL(admission.url);
      if (url.href !== 'https://walletwccm.com/api/voice-admission') missing.push('VOICE_ADMISSION_URL');
    } catch { missing.push('VOICE_ADMISSION_URL'); }
  } else {
    missing.push('VOICE_ADMISSION_MODE');
  }
  const provider = config.speech?.provider || 'legacy';
  if (transport === 'relay') {
    // Twilio performs speech recognition and synthesis on this path.
  } else if (provider === 'cloudflare-workers-ai') {
    if (!present(config.speech?.cloudflare?.accountId)) missing.push('CLOUDFLARE_ACCOUNT_ID');
    if (!present(config.speech?.cloudflare?.gatewayId)) missing.push('CLOUDFLARE_AI_GATEWAY_ID');
    if (!present(config.speech?.cloudflare?.gatewayToken)) missing.push('CLOUDFLARE_AI_GATEWAY_TOKEN');
    if (publicModelIdentifier(config.speech?.cloudflare?.sttModel, 'cloudflareStt') === 'invalid') {
      missing.push('CLOUDFLARE_STT_MODEL');
    }
    if (publicModelIdentifier(config.speech?.cloudflare?.ttsModel, 'cloudflareTts') === 'invalid') {
      missing.push('CLOUDFLARE_TTS_MODEL');
    }
  } else if (provider === 'legacy') {
    if (!present(config.deepgram?.apiKey)) missing.push('DEEPGRAM_API_KEY');
    if (!present(config.elevenlabs?.apiKey)) missing.push('ELEVENLABS_API_KEY');
    if (!present(config.elevenlabs?.voiceId)) missing.push('ELEVENLABS_VOICE_ID');
    if (publicModelIdentifier(config.deepgram?.model, 'deepgram') === 'invalid') missing.push('DEEPGRAM_MODEL');
    if (publicModelIdentifier(config.elevenlabs?.modelId, 'elevenlabs') === 'invalid') {
      missing.push('ELEVENLABS_MODEL_ID');
    }
  } else {
    missing.push('SPEECH_PROVIDER');
  }
  return { ready: missing.length === 0, missing };
}

/**
 * Nonsecret deployment metadata for health/readiness reconciliation.
 *
 * Never echo arbitrary environment values here: configuration mistakes can
 * put credentials in the wrong variable. Provider names and model identifiers
 * come from finite, code-owned allowlists, so this endpoint cannot disclose
 * URLs, phone numbers, owner hashes, or opaque tokens.
 */
export function buildSpeechDiagnostic(config) {
  const provider = config.speech?.provider;
  if (provider === 'cloudflare-workers-ai') {
    return Object.freeze({
      provider,
      stt: Object.freeze({
        provider: 'cloudflare-workers-ai',
        model: publicModelIdentifier(config.speech?.cloudflare?.sttModel, 'cloudflareStt'),
      }),
      tts: Object.freeze({
        provider: 'cloudflare-workers-ai',
        model: publicModelIdentifier(config.speech?.cloudflare?.ttsModel, 'cloudflareTts'),
      }),
    });
  }
  if (provider === 'legacy' || provider == null) {
    return Object.freeze({
      provider: 'legacy',
      stt: Object.freeze({
        provider: 'deepgram',
        model: publicModelIdentifier(config.deepgram?.model, 'deepgram'),
      }),
      tts: Object.freeze({
        provider: 'elevenlabs',
        model: publicModelIdentifier(config.elevenlabs?.modelId, 'elevenlabs'),
      }),
    });
  }
  return Object.freeze({ provider: 'invalid', stt: null, tts: null });
}

export function buildServiceStatus(config, { liveness = false } = {}) {
  const status = buildReadiness(config);
  return Object.freeze({
    ok: liveness ? true : status.ready,
    service: 'wwccm-voice',
    configured: status.ready,
    ready: status.ready,
    missing: status.missing,
    speech: buildSpeechDiagnostic(config),
  });
}

export function canAcceptTraffic(config) {
  return buildReadiness(config).ready;
}
