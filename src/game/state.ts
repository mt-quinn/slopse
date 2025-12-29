import type { TrackDef } from './track'
import type { Vec2 } from './math'

export type ViewState = {
  width: number
  height: number
  dpr: number
}

export type InputState = {
  thrust: boolean
  thrustPointerId: number | null
}

export type GhostSample = { t: number; x: number; y: number }

export type GhostRun = {
  version: 1
  trackId: string
  timeMs: number
  samplesHz: number
  samples: GhostSample[]
}

export type RunResult = {
  finished: boolean
  timeMs: number
  coinsCollected: number
  coinsTotal: number
  medal: 'none' | 'bronze' | 'silver' | 'gold'
  author: boolean // gold time + all coins
  newBestTime: boolean
}

export type RunState = {
  view: ViewState
  input: InputState

  track: TrackDef

  camera: {
    x: number
    y: number
    zoom: number
  }

  timeMs: number
  finished: boolean
  finishHandled: boolean
  dead: boolean

  disc: {
    p: Vec2
    v: Vec2
    r: number
    grounded: boolean
    groundN: Vec2
    groundBlend: number // 0..1, ramps up on landing to avoid “stop dead” feel
  }

  jet: {
    energy: number // 0..1
    draining: boolean
  }

  coinsCollected: Set<string>

  bestTimeMs: number | null
  bestGhost: GhostRun | null

  ghostPlayback: {
    active: boolean
    t: number
  }

  recording: {
    active: boolean
    samplesHz: number
    nextSampleT: number
    samples: GhostSample[]
  }

  result: RunResult | null
}

export const createInitialRunState = (track: TrackDef): RunState => {
  return {
    view: { width: 360, height: 640, dpr: 1 },
    input: { thrust: false, thrustPointerId: null },
    track,
    camera: { x: track.start.p.x + 160, y: track.start.p.y - 120, zoom: 1 },
    timeMs: 0,
    finished: false,
    finishHandled: false,
    dead: false,
    disc: {
      p: { ...track.start.p },
      v: { ...track.start.v },
      r: 16,
      grounded: false,
      groundN: { x: 0, y: -1 },
      groundBlend: 0,
    },
    jet: { energy: 1, draining: false },
    coinsCollected: new Set(),
    bestTimeMs: null,
    bestGhost: null,
    ghostPlayback: { active: false, t: 0 },
    recording: { active: true, samplesHz: 60, nextSampleT: 0, samples: [] },
    result: null,
  }
}


