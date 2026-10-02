import test from 'node:test';
import assert from 'node:assert/strict';

import { DISCLOSURES } from '../src/config.mjs';

test('every locale uses the full company name and removes the old spoken initials', () => {
  for (const [language, disclosure] of Object.entries(DISCLOSURES)) {
    const spokenCopy = [disclosure.recording, disclosure.ai, disclosure.goodbye].join(' ');
    assert.match(spokenCopy, /West Coast Capital Mortgage/, language);
    assert.doesNotMatch(spokenCopy, /Wallet W C C M|\bW C C M\b/, language);
  }
});

test('every locale retains Emma, AI, recording, non-licensed, and estimate/review disclosures', () => {
  const requiredCopy = {
    en: {
      recording: ['may be recorded', 'for quality'],
      ai: ['Emma', 'A I assistant', 'not a licensed loan officer', 'estimate', 'licensed broker reviews'],
    },
    ru: {
      recording: ['может записываться', 'автоматическим помощником'],
      ai: ['Эмма', 'A I-помощник', 'не лицензированный', 'оценка', 'лицензированный брокер'],
    },
    es: {
      recording: ['puede ser grabada', 'asistente automatizado'],
      ai: ['Emma', 'asistente de inteligencia artificial', 'no una oficial de préstamos con licencia', 'estimación', 'corredor con licencia'],
    },
    zh: {
      recording: ['可能会被录音', '自动助理'],
      ai: ['Emma', '人工智能助理', '而非持牌贷款专员', '估算', '持牌经纪人'],
    },
  };

  for (const [language, fields] of Object.entries(requiredCopy)) {
    for (const [field, phrases] of Object.entries(fields)) {
      for (const phrase of phrases) {
        assert.ok(DISCLOSURES[language][field].includes(phrase), `${language}.${field}: ${phrase}`);
      }
    }
  }
});

test('English introduction identifies the company once before Emma and the AI disclosure', () => {
  const disclosure = DISCLOSURES.en;
  const intro = `${disclosure.recording} ${disclosure.ai} ${disclosure.greeting}`;

  assert.ok(intro.startsWith("Hi, you've reached West Coast Capital Mortgage."));
  assert.equal(intro.match(/West Coast Capital Mortgage/g)?.length, 1);
  assert.match(intro, /My name is Emma\. I'm your A I assistant/);
  assert.ok(
    intro.indexOf('West Coast Capital Mortgage') < intro.indexOf('My name is Emma'),
    'company name must be spoken before Emma introduces herself',
  );
  assert.match(intro, /not a licensed loan officer/);
  assert.match(intro, /may be recorded/);
  assert.ok(intro.endsWith('How can I help you today?'));
  assert.doesNotMatch(intro, /purchase price|put down/i);
});
