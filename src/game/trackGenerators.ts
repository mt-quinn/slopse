import { makeDailyTrackFromSeed, type DailyTrackGenOpts, type TrackDef } from './track'

export type TrackGeneratorId = 'daily-v1'

export type TrackGenerator = {
  id: TrackGeneratorId
  label: string
  generate: (seed: number, opts?: DailyTrackGenOpts) => TrackDef
}

export const TRACK_GENERATORS: TrackGenerator[] = [
  {
    id: 'daily-v1',
    label: 'Daily v1 (forward-only + gaps + boosts)',
    generate: (seed, opts) => makeDailyTrackFromSeed(seed, { id: `tool-daily-${seed}`, name: `Daily v1 — ${seed}` }, opts),
  },
]

export const getGenerator = (id: TrackGeneratorId): TrackGenerator => {
  const g = TRACK_GENERATORS.find((x) => x.id === id)
  if (!g) return TRACK_GENERATORS[0]!
  return g
}


