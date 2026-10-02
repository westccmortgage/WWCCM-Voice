// WWCCM-Voice — configuration & compliance copy.
//
// Everything secret comes from the environment (see .env.example / render.yaml).
// The compliance strings are spoken at the top of every call and MUST stay:
// California is a two-party consent state for call recording, and the caller must
// be told they are speaking with an AI assistant, not a licensed loan officer.

export const config = {
  port: Number(process.env.PORT) || 8080,

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
      'This call may be recorded and processed by an automated assistant for quality and to help plan your mortgage scenario.',
    ai:
      "You're speaking with Wallet W C C M's A I assistant — not a licensed loan officer. Everything is an estimate for planning only, and a licensed broker reviews every scenario.",
    greeting:
      'Hi! I can help you plan your home financing. To estimate your real cash to close, tell me the purchase price and how much you plan to put down.',
    goodbye:
      'Thanks for calling Wallet W C C M. A licensed broker will follow up. Goodbye.',
    fallback:
      "Sorry, I didn't catch that. Could you say that again?",
  },
  ru: {
    recording:
      'Этот звонок может записываться и обрабатываться автоматическим помощником для качества и для расчёта вашего сценария по ипотеке.',
    ai:
      'Вы говорите с A I-помощником Wallet W C C M — это не лицензированный кредитный специалист. Все цифры — только оценка для планирования, и каждый сценарий проверяет лицензированный брокер.',
    greeting:
      'Здравствуйте! Я помогу спланировать финансирование покупки жилья. Чтобы оценить сумму к закрытию, назовите цену покупки и сколько вы планируете внести первоначально.',
    goodbye:
      'Спасибо, что позвонили в Wallet W C C M. Лицензированный брокер свяжется с вами. До свидания.',
    fallback: 'Извините, я не расслышал. Повторите, пожалуйста.',
  },
  es: {
    recording:
      'Esta llamada puede ser grabada y procesada por un asistente automatizado para calidad y para planificar su escenario hipotecario.',
    ai:
      'Está hablando con el asistente de inteligencia artificial de Wallet W C C M, no con un oficial de préstamos con licencia. Todo es una estimación solo para planificación, y un corredor con licencia revisa cada escenario.',
    greeting:
      'Hola! Puedo ayudarle a planificar el financiamiento de su vivienda. Para estimar el efectivo necesario para cerrar, dígame el precio de compra y cuánto planea dar de enganche.',
    goodbye:
      'Gracias por llamar a Wallet W C C M. Un corredor con licencia le dará seguimiento. Adiós.',
    fallback: 'Disculpe, no entendí. Puede repetirlo?',
  },
  zh: {
    recording:
      '为了服务质量和帮助规划您的贷款方案，本次通话可能会被录音并由自动助理处理。',
    ai:
      '您正在与 Wallet W C C M 的人工智能助理通话，而非持牌贷款专员。所有数字仅为规划用途的估算，每个方案都会由持牌经纪人审核。',
    greeting:
      '您好！我可以帮助您规划购房贷款。为了估算您的实际结算资金，请告诉我购买价格以及您计划支付的首付金额。',
    goodbye: '感谢致电 Wallet W C C M。持牌经纪人会与您联系。再见。',
    fallback: '抱歉，我没有听清，请再说一遍。',
  },
};

export function disclosuresFor(lang) {
  return DISCLOSURES[lang] || DISCLOSURES.en;
}
