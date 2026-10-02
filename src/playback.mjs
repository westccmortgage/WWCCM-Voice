export function beginPlayback(state, controller) {
  const generation = (state.playbackGeneration || 0) + 1;
  state.playbackGeneration = generation;
  state.activePlaybackGeneration = generation;
  state.playbackMark = null;
  state.speaking = true;
  state.ttsAbort = controller;
  return generation;
}

export function finishPlaybackGeneration(state, generation, markName) {
  if (state.activePlaybackGeneration !== generation) return false;
  state.ttsAbort = null;
  if (!markName) {
    state.activePlaybackGeneration = null;
    state.speaking = false;
    return false;
  }
  state.playbackMark = markName;
  return true;
}

export function failPlaybackGeneration(state, generation) {
  if (state.activePlaybackGeneration !== generation) return false;
  state.activePlaybackGeneration = null;
  state.playbackMark = null;
  state.ttsAbort = null;
  state.speaking = false;
  return true;
}

export function acknowledgePlaybackMark(state, name) {
  if (!name || name !== state.playbackMark) return false;
  state.activePlaybackGeneration = null;
  state.playbackMark = null;
  state.speaking = false;
  return true;
}

export function invalidatePlayback(state) {
  const controller = state.ttsAbort;
  state.playbackGeneration = (state.playbackGeneration || 0) + 1;
  state.activePlaybackGeneration = null;
  state.playbackMark = null;
  state.ttsAbort = null;
  state.speaking = false;
  return controller;
}
