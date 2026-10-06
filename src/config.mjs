// WWCCM-Voice — configuration & compliance copy.
//
// Everything secret comes from the environment (see .env.example / render.yaml).
// The compliance strings are spoken at the top of every call and MUST stay:
// California is a two-party consent state for call recording, and the caller must
// be told they are speaking with an AI assistant, not a licensed loan officer.

import { boundedInteger } from './usage-limits.mjs';

export const config = {
  port: Number(process.env.PORT) || 8080,
  runtimeEnabled: process.env.VOICE_RUNTIME_ENABLED === 'true',

  // The advisor "brain" endpoint in the Wallet WCCM site (image repo):
  //   https://walletwccm.com/api/voice-advisor-turn
  voiceTurnUrl: process.env.VOICE_TURN_URL || '',
  voiceSharedSecret: process.env.VOICE_SHARED_SECRET || '',

  // Default remains the currently deployed adapters. The Cloudflare path is
  // local-only until its Workers AI entitlement and gateway token are verified.
  speech: {
    provider: (process.env.SPEECH_PROVIDER || 'legacy').toLowerCase(),
    cloudflare: {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
      gatewayId: process.env.CLOUDFLARE_AI_GATEWAY_ID || '',
      gatewayToken: process.env.CLOUDFLARE_AI_GATEWAY_TOKEN || '',
      sttModel: process.env.CLOUDFLARE_STT_MODEL || '@cf/deepgram/nova-3',
      ttsModel: process.env.CLOUDFLARE_TTS_MODEL || '@cf/deepgram/aura-1',
      speaker: process.env.CLOUDFLARE_TTS_SPEAKER || 'asteria',
      language: process.env.DEEPGRAM_LANGUAGE || process.env.AGENT_LANGUAGE || 'en',
    },
  },

  // Spoken language for the whole call (brain + greeting). en | ru | es | zh.
  language: (process.env.AGENT_LANGUAGE || 'en').toLowerCase(),

  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY || '',
    model: process.env.DEEPGRAM_MODEL || 'nova-2',
    language: process.env.DEEPGRAM_LANGUAGE || process.env.AGENT_LANGUAGE || 'en',
  },

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voiceId: process.env.ELEVENLABS_VOICE_ID || '',
    // Turbo v2.5 is low-latency and multilingual — good for a phone agent.
    modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5',
  },

  // Required: all webhook and WebSocket traffic is rejected when absent.
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',

  // Which voice path /voice answers with. `media-stream` is the existing
  // Deepgram/ElevenLabs bridge and stays the default. `relay` returns Twilio
  // ConversationRelay TwiML: Twilio handles speech in and out, and each final
  // caller utterance becomes one signed request to Core's relay door.
  transport: (process.env.VOICE_TRANSPORT || 'media-stream').toLowerCase(),
  relay: {
    url: process.env.VOICE_RELAY_URL || '',
    keyId: process.env.VOICE_RELAY_KEY_ID || '',
    secret: process.env.VOICE_RELAY_HMAC_SECRET || '',
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    ttsProvider: process.env.VOICE_RELAY_TTS_PROVIDER || '',
    voice: process.env.VOICE_RELAY_VOICE || '',
    turnTimeoutMs: boundedInteger(process.env.VOICE_RELAY_TURN_TIMEOUT_MS, 9_000, { min: 3_000, max: 15_000 }),
  },

  // A test release is a separate admission mode, not merely an enabled
  // public phone number. It admits only the owner's exact E.164 caller and
  // bounds the complete suite across webhook and Core requests.
  admission: {
    mode: (process.env.VOICE_ADMISSION_MODE || 'disabled').toLowerCase(),
    url: process.env.VOICE_ADMISSION_URL || '',
    sharedSecret: process.env.VOICE_SHARED_SECRET || '',
    allowedCaller: process.env.VOICE_TEST_ALLOWED_CALLER || '',
  },

  // Hard provider-usage ceilings. For a bounded acceptance call these can be
  // tightened without changing code (for example 120 seconds / 6 turns / 8000
  // synthesized characters). Invalid values fall back to the reviewed limits.
  limits: {
    maxCallSeconds: boundedInteger(process.env.MAX_CALL_SECONDS, 1_800, { min: 30, max: 1_800 }),
    maxTurns: boundedInteger(process.env.MAX_CONVERSATION_TURNS, 60, { min: 1, max: 60 }),
    maxTtsCharacters: boundedInteger(process.env.MAX_TTS_CHARACTERS, 25_000, { min: 500, max: 100_000 }),
  },

  // Business facts spoken on request — never cross these numbers.
  nmls: {
    companyNmls: '2817729',
    companyDre: '02440065',
  },
};

/** Spoken disclosures by language. Played before the conversation starts. */
export const DISCLOSURES = {
  en: {
    recording:
      "Hi, you've reached West Coast Capital Mortgage. This call may be recorded for quality.",
    ai:
      "My name is Emma. I'm your A I assistant, not a licensed loan officer. Any figures are planning estimates, and a licensed broker reviews every scenario.",
    greeting:
      'How can I help you today?',
    goodbye:
      'Thanks for calling West Coast Capital Mortgage. A licensed broker will follow up. Goodbye.',
    fallback:
      "Sorry, I didn't catch that. Could you say that again?",
    unavailable:
      "Sorry, I can't safely continue this call right now. Please call West Coast Capital Mortgage again shortly. Goodbye.",
  },
  ru: {
    recording:
      'Спасибо, что позвонили в West Coast Capital Mortgage. Этот звонок может записываться и обрабатываться автоматическим помощником для качества и для расчёта вашего сценария по ипотеке.',
    ai:
      'Меня зовут Эмма. Я ваш A I-помощник, а не лицензированный кредитный специалист. Все цифры — только оценка для планирования, и каждый сценарий проверяет лицензированный брокер.',
    greeting:
      'Чем я могу помочь вам сегодня?',
    goodbye:
      'Спасибо, что позвонили в West Coast Capital Mortgage. Лицензированный брокер свяжется с вами. До свидания.',
    fallback: 'Извините, я не расслышал. Повторите, пожалуйста.',
    unavailable: 'Извините, сейчас я не могу безопасно продолжить этот звонок. Пожалуйста, перезвоните в West Coast Capital Mortgage немного позже. До свидания.',
  },
  es: {
    recording:
      'Gracias por llamar a West Coast Capital Mortgage. Esta llamada puede ser grabada y procesada por un asistente automatizado para calidad y para planificar su escenario hipotecario.',
    ai:
      'Me llamo Emma. Soy su asistente de inteligencia artificial, no una oficial de préstamos con licencia. Todo es una estimación solo para planificación, y un corredor con licencia revisa cada escenario.',
    greeting:
      '¿Cómo puedo ayudarle hoy?',
    goodbye:
      'Gracias por llamar a West Coast Capital Mortgage. Un corredor con licencia le dará seguimiento. Adiós.',
    fallback: 'Disculpe, no entendí. Puede repetirlo?',
    unavailable: 'Lo siento, no puedo continuar esta llamada de forma segura en este momento. Por favor, vuelva a llamar a West Coast Capital Mortgage en unos minutos. Adiós.',
  },
  zh: {
    recording:
      '感谢致电 West Coast Capital Mortgage。为了服务质量和帮助规划您的贷款方案，本次通话可能会被录音并由自动助理处理。',
    ai:
      '我叫 Emma，是您的人工智能助理，而非持牌贷款专员。所有数字仅为规划用途的估算，每个方案都会由持牌经纪人审核。',
    greeting:
      '今天我能为您做些什么？',
    goodbye: '感谢致电 West Coast Capital Mortgage。持牌经纪人会与您联系。再见。',
    fallback: '抱歉，我没有听清，请再说一遍。',
    unavailable: '抱歉，我现在无法安全地继续本次通话。请稍后再次致电 West Coast Capital Mortgage。再见。',
  },
};

export function disclosuresFor(lang) {
  return DISCLOSURES[lang] || DISCLOSURES.en;
}
