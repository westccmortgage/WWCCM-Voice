import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  openCloudflareTranscription,
  speakCloudflare,
  CLOUDFLARE_SPEECH_LIMITS,
} from '../src/cloudflare-speech.mjs';

const SETTINGS = {
  accountId: 'account-id',
  gatewayId: 'gateway-id',
  gatewayToken: 'test-gateway-token',
  sttModel: '@cf/deepgram/nova-3',
  ttsModel: '@cf/deepgram/aura-1',
  speaker: 'asteria',
  language: 'en',
};

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    MockWebSocket.instances.push(this);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

test.beforeEach(() => {
  MockWebSocket.instances.length = 0;
});

test('Cloudflare Nova-3 streams raw Twilio mu-law and parses interim/final events', () => {
  const interim = [];
  const final = [];
  const errors = [];
  const stt = openCloudflareTranscription(
    {
      onInterim: (text) => interim.push(text),
      onFinal: (text) => final.push(text),
      onError: (error) => errors.push(error),
    },
    { WebSocketImpl: MockWebSocket, settings: SETTINGS },
  );
  const socket = MockWebSocket.instances[0];
  const url = new URL(socket.url);
  assert.equal(url.pathname, '/v1/account-id/gateway-id/workers-ai');
  assert.equal(url.searchParams.get('model'), '@cf/deepgram/nova-3');
  assert.equal(url.searchParams.get('encoding'), 'mulaw');
  assert.equal(url.searchParams.get('sample_rate'), '8000');
  assert.equal(url.searchParams.get('channels'), '1');
  assert.equal(socket.options.headers['cf-aig-authorization'], 'Bearer test-gateway-token');
  assert.equal(socket.options.maxPayload, CLOUDFLARE_SPEECH_LIMITS.sttMessageBytes);

  const audio = Buffer.from([0xff, 0x7f, 0x00]);
  stt.sendAudio(audio);
  socket.readyState = MockWebSocket.OPEN;
  socket.emit('open');
  assert.equal(socket.sent[0], audio);

  socket.emit(
    'message',
    Buffer.from(JSON.stringify({ is_final: false, channel: { alternatives: [{ transcript: 'hel' }] } })),
    false,
  );
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({ is_final: true, speech_final: false, channel: { alternatives: [{ transcript: 'hello' }] } }),
    ),
    false,
  );
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({ is_final: true, speech_final: false, channel: { alternatives: [{ transcript: 'world' }] } }),
    ),
    false,
  );
  // Nova-3 can end an utterance with an empty speech_final event after sending
  // one or more finalized transcript segments.
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({ is_final: true, speech_final: true, channel: { alternatives: [{ transcript: '' }] } }),
    ),
    false,
  );
  assert.deepEqual(interim, ['hel']);
  assert.deepEqual(final, ['hello world']);
  assert.deepEqual(errors, []);

  stt.finish();
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: 'Finalize' });
  stt.close();
  assert.equal(socket.closed, true);
});

test('Cloudflare Nova-3 emits buffered transcript when Finalize completes without speech_final', () => {
  const final = [];
  const stt = openCloudflareTranscription(
    { onFinal: (text) => final.push(text), onError: assert.fail },
    { WebSocketImpl: MockWebSocket, settings: SETTINGS },
  );
  const socket = MockWebSocket.instances[0];
  socket.readyState = MockWebSocket.OPEN;
  socket.emit('open');

  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: 'cloudflare voice' }] },
      }),
    ),
    false,
  );
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        is_final: true,
        from_finalize: true,
        channel: { alternatives: [{ transcript: 'smoke test seven' }] },
      }),
    ),
    false,
  );

  assert.deepEqual(final, ['cloudflare voice smoke test seven']);
  stt.close();
});

test('Cloudflare Nova-3 empty Finalize completion flushes prior finalized segments', () => {
  const final = [];
  const stt = openCloudflareTranscription(
    { onFinal: (text) => final.push(text), onError: assert.fail },
    { WebSocketImpl: MockWebSocket, settings: SETTINGS },
  );
  const socket = MockWebSocket.instances[0];
  socket.readyState = MockWebSocket.OPEN;
  socket.emit('open');

  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: 'buffered transcript' }] },
      }),
    ),
    false,
  );
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        is_final: true,
        from_finalize: true,
        channel: { alternatives: [{ transcript: '' }] },
      }),
    ),
    false,
  );

  assert.deepEqual(final, ['buffered transcript']);
  stt.close();
});

test('Cloudflare Aura requests raw headerless mu-law/8k and streams binary audio', async () => {
  const chunks = [];
  const completion = speakCloudflare(
    { text: 'Safe deterministic reply.', onChunk: (chunk) => chunks.push(chunk) },
    { WebSocketImpl: MockWebSocket, settings: SETTINGS, timeoutMs: 1_000 },
  );
  const socket = MockWebSocket.instances[0];
  const url = new URL(socket.url);
  assert.equal(url.searchParams.get('model'), '@cf/deepgram/aura-1');
  assert.equal(url.searchParams.get('encoding'), 'mulaw');
  assert.equal(url.searchParams.get('sample_rate'), '8000');
  assert.equal(url.searchParams.get('container'), 'none');
  assert.equal(url.searchParams.get('speaker'), 'asteria');

  socket.readyState = MockWebSocket.OPEN;
  socket.emit('open');
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'Speak', text: 'Safe deterministic reply.' });
  assert.deepEqual(JSON.parse(socket.sent[1]), { type: 'Flush' });

  const audio = Buffer.alloc(160, 0xff);
  socket.emit('message', audio, true);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'Flushed' })), false);
  await completion;
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], audio);
  assert.equal(socket.closed, true);
});

test('Cloudflare Aura cancellation sends Clear and rejects without waiting for audio', async () => {
  const chunks = [];
  const controller = new AbortController();
  const completion = speakCloudflare(
    { text: 'Stop this.', onChunk: (chunk) => chunks.push(chunk), signal: controller.signal },
    { WebSocketImpl: MockWebSocket, settings: SETTINGS, timeoutMs: 1_000 },
  );
  const socket = MockWebSocket.instances[0];
  socket.readyState = MockWebSocket.OPEN;
  socket.emit('open');
  controller.abort();
  await assert.rejects(completion, (error) => error.name === 'AbortError');
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: 'Clear' });
  socket.emit('message', Buffer.alloc(160), true);
  assert.deepEqual(chunks, []);
  assert.equal(socket.closed, true);
});

test('Cloudflare Aura never starts if cancellation wins the open race', async () => {
  const chunks = [];
  const controller = new AbortController();
  const completion = speakCloudflare(
    { text: 'Never send this.', onChunk: (chunk) => chunks.push(chunk), signal: controller.signal },
    { WebSocketImpl: MockWebSocket, settings: SETTINGS, timeoutMs: 1_000 },
  );
  const socket = MockWebSocket.instances[0];
  controller.abort();
  await assert.rejects(completion, (error) => error.name === 'AbortError');
  socket.readyState = MockWebSocket.OPEN;
  socket.emit('open');
  socket.emit('message', Buffer.alloc(160), true);
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(chunks, []);
});

test('Cloudflare Nova-3 rejects unbounded startup buffering', () => {
  const errors = [];
  const stt = openCloudflareTranscription(
    { onFinal: () => {}, onError: (error) => errors.push(error) },
    { WebSocketImpl: MockWebSocket, settings: SETTINGS },
  );
  stt.sendAudio(Buffer.alloc(CLOUDFLARE_SPEECH_LIMITS.startupBufferBytes + 1));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /buffer limit/);
});

test('Cloudflare Nova-3 bounds accumulated finalized transcript segments', () => {
  const errors = [];
  openCloudflareTranscription(
    { onFinal: () => {}, onError: (error) => errors.push(error) },
    { WebSocketImpl: MockWebSocket, settings: SETTINGS },
  );
  const socket = MockWebSocket.instances[0];
  socket.readyState = MockWebSocket.OPEN;
  socket.emit('open');
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: 'x'.repeat(CLOUDFLARE_SPEECH_LIMITS.sttUtteranceCharacters + 1) }] },
      }),
    ),
    false,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /utterance limit/);
  assert.equal(socket.closed, true);
});

test('Cloudflare Aura rejects oversized binary output', async () => {
  const completion = speakCloudflare(
    { text: 'Bounded output.', onChunk: () => {} },
    { WebSocketImpl: MockWebSocket, settings: SETTINGS, timeoutMs: 1_000 },
  );
  const socket = MockWebSocket.instances[0];
  socket.readyState = MockWebSocket.OPEN;
  socket.emit('open');
  socket.emit('message', Buffer.alloc(CLOUDFLARE_SPEECH_LIMITS.ttsResponseBytes + 1), true);
  await assert.rejects(completion, /response limit exceeded/);
  assert.equal(socket.closed, true);
});

test('Cloudflare speech transport limits are bounded', () => {
  assert.equal(CLOUDFLARE_SPEECH_LIMITS.startupBufferBytes, 512 * 1024);
  assert.equal(CLOUDFLARE_SPEECH_LIMITS.sttMessageBytes, 256 * 1024);
  assert.equal(CLOUDFLARE_SPEECH_LIMITS.sttUtteranceCharacters, 8 * 1024);
  assert.equal(CLOUDFLARE_SPEECH_LIMITS.ttsResponseBytes, 2 * 1024 * 1024);
  assert.equal(CLOUDFLARE_SPEECH_LIMITS.ttsTimeoutMs, 20_000);
});
