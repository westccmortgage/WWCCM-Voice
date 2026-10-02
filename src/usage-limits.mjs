export function boundedInteger(value, fallback, { min, max }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function reserveSpeechCharacters(state, text, limit) {
  const characters = String(text || '').length;
  if (!characters || !Number.isInteger(limit) || limit < 1) return false;
  const used = Number.isInteger(state.ttsCharacters) ? state.ttsCharacters : 0;
  if (used + characters > limit) return false;
  state.ttsCharacters = used + characters;
  return true;
}
