export function buildReadiness(config) {
  const missing = [];
  const present = (value) => typeof value === 'string' && value.trim().length > 0;
  if (config.runtimeEnabled !== true) missing.push('VOICE_RUNTIME_ENABLED');
  if (!present(config.twilioAuthToken)) missing.push('TWILIO_AUTH_TOKEN');
  if (!present(config.voiceTurnUrl)) missing.push('VOICE_TURN_URL');
  if (!present(config.voiceSharedSecret)) missing.push('VOICE_SHARED_SECRET');
  const provider = config.speech?.provider || 'legacy';
  if (provider === 'cloudflare-workers-ai') {
    if (!present(config.speech?.cloudflare?.accountId)) missing.push('CLOUDFLARE_ACCOUNT_ID');
    if (!present(config.speech?.cloudflare?.gatewayId)) missing.push('CLOUDFLARE_AI_GATEWAY_ID');
    if (!present(config.speech?.cloudflare?.gatewayToken)) missing.push('CLOUDFLARE_AI_GATEWAY_TOKEN');
  } else if (provider === 'legacy') {
    if (!present(config.deepgram?.apiKey)) missing.push('DEEPGRAM_API_KEY');
    if (!present(config.elevenlabs?.apiKey)) missing.push('ELEVENLABS_API_KEY');
    if (!present(config.elevenlabs?.voiceId)) missing.push('ELEVENLABS_VOICE_ID');
  } else {
    missing.push('SPEECH_PROVIDER');
  }
  return { ready: missing.length === 0, missing };
}

export function canAcceptTraffic(config) {
  return buildReadiness(config).ready;
}
