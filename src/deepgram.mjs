// WWCCM-Voice — Deepgram streaming speech-to-text.
//
// We open ONE Deepgram live WebSocket per call and feed it the caller's raw
// mulaw/8000 audio exactly as Twilio delivers it (no transcoding needed). We get
// interim + final transcripts back. The caller is considered "done speaking" when
// Deepgram reports speech_final (utterance end via endpointing), at which point we
// hand the final transcript to the brain.

import WebSocket from 'ws';
import { config } from './config.mjs';

/**
 * Open a Deepgram live transcription socket.
 * @param {object} handlers
 * @param {(text:string)=>void} handlers.onFinal   final utterance text
 * @param {(text:string)=>void} [handlers.onInterim] partial text (for barge-in)
 * @param {()=>void} [handlers.onOpen]
 * @param {(err:any)=>void} [handlers.onError]
 * @returns {{ sendAudio:(buf:Buffer)=>void, finish:()=>void, close:()=>void }}
 */
export function openDeepgram({ onFinal, onInterim, onOpen, onError }) {
  const params = new URLSearchParams({
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    model: config.deepgram.model,
    language: config.deepgram.language,
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: '300', // ms of silence that ends an utterance
    vad_events: 'true',
  });
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${config.deepgram.apiKey}` },
  });

  let open = false;
  const pending = [];
  let pendingBytes = 0;

  ws.on('open', () => {
    open = true;
    for (const buf of pending) ws.send(buf);
    pending.length = 0;
    pendingBytes = 0;
    onOpen && onOpen();
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type !== 'Results') return;
    const alt = msg.channel?.alternatives?.[0];
    const transcript = (alt?.transcript || '').trim();
    if (!transcript) return;
    if (msg.is_final && msg.speech_final) {
      onFinal && onFinal(transcript);
    } else if (!msg.is_final) {
      onInterim && onInterim(transcript);
    }
  });

  ws.on('error', (err) => onError && onError(err));
  ws.on('close', () => {
    open = false;
  });

  return {
    sendAudio(buf) {
      if (open && ws.readyState === WebSocket.OPEN) ws.send(buf);
      else if (pendingBytes + buf.length <= 512 * 1024) {
        pending.push(buf);
        pendingBytes += buf.length;
      } else {
        onError && onError(new Error('Deepgram startup audio buffer limit reached'));
      }
    },
    finish() {
      // Ask Deepgram to flush any buffered audio into a final result.
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Finalize' }));
      } catch {
        /* ignore */
      }
    },
    close() {
      pending.length = 0;
      pendingBytes = 0;
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* ignore */
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
