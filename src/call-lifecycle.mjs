export function beginBrainRequest(state) {
  if (state.ended) return null;
  const controller = new AbortController();
  state.brainAbort = controller;
  return controller;
}

export function finishBrainRequest(state, controller) {
  if (state.brainAbort !== controller) return false;
  state.brainAbort = null;
  return !state.ended;
}

export function cancelBrainRequest(state) {
  const controller = state.brainAbort;
  state.brainAbort = null;
  try {
    controller?.abort();
  } catch {
    /* ignore */
  }
  return controller;
}

export function endCall(state) {
  if (state.ended) return null;
  state.ended = true;
  const controller = state.brainAbort;
  state.brainAbort = null;
  return controller;
}
