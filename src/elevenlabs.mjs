// WWCCM-Voice — ElevenLabs text-to-speech, streamed as Twilio-ready audio.
//
// We request output_format=ulaw_8000 so the audio comes back as 8kHz mu-law —
// exactly what Twilio Media Streams expects — with NO transcoding on our side.
// We stream the response and invoke onChunk() with raw mu-law bytes as they
// arrive, so the agent starts talking before the whole sentence is synthesized.

import { config } from './config.mjs';

/**
 * Synthesize speech and stream mu-law/8000 chunks to onChunk.
 * @param {object} args
 * @param {string} args.text
 * @param {(chunk:Buffer)=>void} args.onChunk
 * @param {AbortSignal} [args.signal]  abort to support barge-in (stop speaking)
 * @returns {Promise<void>}
 */
export async function speak({ text, onChunk, signal }) {
  if (!text || !text.trim()) return;
  if (!config.elevenlabs.apiKey || !config.elevenlabs.voiceId) {
    console.error('[tts] ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set');
    return;
  }

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenlabs.voiceId)}` +
    `/stream?output_format=ulaw_8000&optimize_streaming_latency=3`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'xi-api-key': config.elevenlabs.apiKey,
        'content-type': 'application/json',
        accept: 'audio/basic',
      },
      body: JSON.stringify({
        text,
        model_id: config.elevenlabs.modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  } catch (err) {
    if (err?.name !== 'AbortError') console.error('[tts] request failed:', String(err).slice(0, 200));
    return;
  }

  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => '');
    console.error('[tts] non-OK', resp.status, detail.slice(0, 300));
    return;
  }

  try {
    for await (const chunk of resp.body) {
      if (signal?.aborted) break;
      onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (err) {
    if (err?.name !== 'AbortError') console.error('[tts] stream error:', String(err).slice(0, 200));
  }
}
