export function buildReadiness(config) {
  const missing = [];
  const present = (value) => typeof value === 'string' && value.trim().length > 0;
  if (!present(config.twilioAuthToken)) missing.push('TWILIO_AUTH_TOKEN');
  if (!present(config.voiceTurnUrl)) missing.push('VOICE_TURN_URL');
  if (!present(config.voiceSharedSecret)) missing.push('VOICE_SHARED_SECRET');
  if (!present(config.deepgram?.apiKey)) missing.push('DEEPGRAM_API_KEY');
  if (!present(config.elevenlabs?.apiKey)) missing.push('ELEVENLABS_API_KEY');
  if (!present(config.elevenlabs?.voiceId)) missing.push('ELEVENLABS_VOICE_ID');
  return { ready: missing.length === 0, missing };
}

export function canAcceptTraffic(config) {
  return buildReadiness(config).ready;
}
