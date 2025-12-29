import type { RunState } from './state'

// Shared run start behavior (must match gameplay + editor playtest).
export const startRun = (s: RunState) => {
  if (s.runStarted) return

  // Launch + start timer/recording on first interaction.
  s.runStarted = true
  s.startPlatform.active = false
  s.dead = false
  s.finished = false
  s.finishHandled = false
  s.result = null
  s.timeMs = 0
  s.disc.v = { ...s.track.start.v }
  s.disc.grounded = false
  s.disc.groundBlend = 0
  s.recording.samples = []
  s.recording.nextSampleT = 0
  s.coinsCollected.clear()
  s.jet.energy = 1
  s.ghostPlayback.t = 0
}


