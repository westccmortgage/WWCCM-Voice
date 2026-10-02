// Provider-neutral speech seam. The deployed default remains the legacy
// Deepgram STT + ElevenLabs TTS path until SPEECH_PROVIDER=cloudflare-workers-ai
// is explicitly configured and separately released.

import { config } from './config.mjs';
import { openDeepgram } from './deepgram.mjs';
import { speak as speakElevenLabs } from './elevenlabs.mjs';
import { openCloudflareTranscription, speakCloudflare } from './cloudflare-speech.mjs';

export function openTranscription(handlers) {
  if (config.speech.provider === 'cloudflare-workers-ai') {
    return openCloudflareTranscription(handlers);
  }
  return openDeepgram(handlers);
}

export function synthesizeSpeech(args) {
  if (config.speech.provider === 'cloudflare-workers-ai') return speakCloudflare(args);
  return speakElevenLabs(args);
}
