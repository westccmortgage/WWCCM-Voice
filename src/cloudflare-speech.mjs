// Cloudflare AI Gateway -> Workers AI speech adapter.
//
// This module deliberately keeps the same narrow contracts as the existing
// Deepgram STT and ElevenLabs TTS adapters. It does not own conversation logic,
// mortgage calculations, disclosure timing, or call identity.

import WebSocket from 'ws';
import { config } from './config.mjs';

const STARTUP_BUFFER_LIMIT = 512 * 1024;
const STT_MESSAGE_LIMIT = 256 * 1024;
const STT_UTTERANCE_LIMIT = 8 * 1024;
const TTS_RESPONSE_LIMIT = 2 * 1024 * 1024;
const TTS_TIMEOUT_MS = 20_000;

function gatewayUrl(settings, model, params = {}) {
  const account = settings.accountId?.trim();
  const gateway = settings.gatewayId?.trim();
  if (!account || !gateway) throw new Error('Cloudflare AI Gateway coordinates are missing');
  const query = new URLSearchParams({ model, ...params });
  return `wss://gateway.ai.cloudflare.com/v1/${encodeURIComponent(account)}/${encodeURIComponent(gateway)}/workers-ai?${query}`;
}

function gatewayHeaders(settings) {
  const token = settings.gatewayToken?.trim();
  if (!token) throw new Error('Cloudflare AI Gateway token is missing');
  return { 'cf-aig-authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}` };
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error('Speech synthesis aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Open real-time Nova-3 transcription through Cloudflare AI Gateway.
 * Twilio audio is already raw G.711 mu-law at 8 kHz, so no transcoding occurs.
 */
export function openCloudflareTranscription(
  { onFinal, onInterim, onOpen, onError },
  { WebSocketImpl = WebSocket, settings = config.speech.cloudflare } = {},
) {
  const url = gatewayUrl(settings, settings.sttModel, {
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    language: settings.language,
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: '300',
    vad_events: 'true',
  });
  const ws = new WebSocketImpl(url, {
    headers: gatewayHeaders(settings),
    maxPayload: STT_MESSAGE_LIMIT,
  });
  const openState = WebSocketImpl.OPEN ?? 1;
  let open = false;
  const pending = [];
  let pendingBytes = 0;
  let finalSegments = [];

  ws.on('open', () => {
    open = true;
    for (const audio of pending) ws.send(audio);
    pending.length = 0;
    pendingBytes = 0;
    onOpen?.();
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.type === 'Error') {
      onError?.(new Error(`Cloudflare STT error: ${String(message.description || message.message || 'unknown').slice(0, 160)}`));
      return;
    }
    const transcript = String(message.channel?.alternatives?.[0]?.transcript || '').trim();
    if (message.is_final && transcript) {
      const accumulatedLength = finalSegments.reduce((sum, segment) => sum + segment.length + 1, 0);
      if (accumulatedLength + transcript.length > STT_UTTERANCE_LIMIT) {
        finalSegments = [];
        onError?.(new Error('Cloudflare STT utterance limit reached'));
        try {
          ws.close(1009, 'transcript limit');
        } catch {
          // Already closed.
        }
        return;
      }
      finalSegments.push(transcript);
    }
    if (message.speech_final) {
      const utterance = finalSegments.join(' ').trim();
      finalSegments = [];
      if (utterance) onFinal?.(utterance);
    } else if (!message.is_final && transcript) {
      onInterim?.(transcript);
    }
  });
  ws.on('error', (error) => onError?.(error));
  ws.on('close', () => {
    open = false;
  });

  return {
    sendAudio(audio) {
      if (!Buffer.isBuffer(audio)) throw new TypeError('speech audio must be a Buffer');
      if (open && ws.readyState === openState) ws.send(audio);
      else if (pendingBytes + audio.length <= STARTUP_BUFFER_LIMIT) {
        pending.push(audio);
        pendingBytes += audio.length;
      } else {
        onError?.(new Error('Cloudflare STT startup audio buffer limit reached'));
      }
    },
    finish() {
      if (ws.readyState === openState) ws.send(JSON.stringify({ type: 'Finalize' }));
    },
    close() {
      pending.length = 0;
      pendingBytes = 0;
      finalSegments = [];
      try {
        if (ws.readyState === openState) ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        // Best-effort protocol close; the transport is closed below.
      }
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Stream Aura-1 audio through Cloudflare AI Gateway.
 * Requests raw, headerless G.711 mu-law at 8 kHz for direct Twilio playback.
 */
export function speakCloudflare(
  { text, onChunk, signal },
  { WebSocketImpl = WebSocket, settings = config.speech.cloudflare, timeoutMs = TTS_TIMEOUT_MS } = {},
) {
  if (!text?.trim()) return Promise.reject(new Error('TTS text is empty'));
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));

  return new Promise((resolve, reject) => {
    let ws;
    try {
      const url = gatewayUrl(settings, settings.ttsModel, {
        encoding: 'mulaw',
        sample_rate: '8000',
        container: 'none',
        speaker: settings.speaker,
      });
      ws = new WebSocketImpl(url, {
        headers: gatewayHeaders(settings),
        maxPayload: TTS_RESPONSE_LIMIT,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let receivedBytes = 0;
    const timer = setTimeout(() => fail(new Error('Cloudflare TTS timeout')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const close = () => {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    };
    const succeed = () => {
      if (settled) return;
      if (receivedBytes === 0) return fail(new Error('Cloudflare TTS returned no audio'));
      settled = true;
      cleanup();
      close();
      resolve();
    };
    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      close();
      reject(error);
    }
    const onAbort = () => {
      try {
        if (ws.readyState === (WebSocketImpl.OPEN ?? 1)) ws.send(JSON.stringify({ type: 'Clear' }));
      } catch {
        // The socket is closing anyway.
      }
      fail(abortError(signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    ws.on('open', () => {
      if (settled) return;
      try {
        ws.send(JSON.stringify({ type: 'Speak', text: text.trim() }));
        ws.send(JSON.stringify({ type: 'Flush' }));
      } catch (error) {
        fail(error);
      }
    });
    ws.on('message', (data, isBinary) => {
      if (settled) return;
      if (isBinary) {
        const audio = Buffer.isBuffer(data) ? data : Buffer.from(data);
        receivedBytes += audio.length;
        if (receivedBytes > TTS_RESPONSE_LIMIT) {
          fail(new Error('Cloudflare TTS response limit exceeded'));
          return;
        }
        try {
          onChunk(audio);
        } catch (error) {
          fail(error);
        }
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type === 'Flushed') succeed();
      else if (message.type === 'Error') {
        fail(new Error(`Cloudflare TTS error: ${String(message.description || message.message || 'unknown').slice(0, 160)}`));
      }
    });
    ws.on('error', fail);
    ws.on('close', () => {
      if (!settled) fail(new Error('Cloudflare TTS closed before completion'));
    });
  });
}

export const CLOUDFLARE_SPEECH_LIMITS = Object.freeze({
  startupBufferBytes: STARTUP_BUFFER_LIMIT,
  sttMessageBytes: STT_MESSAGE_LIMIT,
  sttUtteranceCharacters: STT_UTTERANCE_LIMIT,
  ttsResponseBytes: TTS_RESPONSE_LIMIT,
  ttsTimeoutMs: TTS_TIMEOUT_MS,
});
