export function beginBrainRequest(state) {
  if (state.ended) return null;
  const controller = new AbortController();
  state.brainAbort = controller;
  return controller;
}

export function finishBrainRequest(state, controller) {
  if (state.brainAbort === controller) state.brainAbort = null;
  return !state.ended;
}

export function endCall(state) {
  if (state.ended) return null;
  state.ended = true;
  const controller = state.brainAbort;
  state.brainAbort = null;
  return controller;
}
