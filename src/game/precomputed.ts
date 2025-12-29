import type { TrackCoin } from './track'
import type { MedalTimes } from './medals'

export type PrecomputedTrackData = {
  medals: MedalTimes
  coins: TrackCoin[]
}

// Precomputed at build time via `npm run precompute`.
export { PRECOMPUTED_BY_TRACK } from './precomputed.generated'


