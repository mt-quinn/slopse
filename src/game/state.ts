import { trackBounds, type TrackDef, type TrackMaterial } from './track'
import type { Vec2 } from './math'
import { JET_MAX_ENERGY } from './tuning'

export type ViewState = {
  width: number
  height: number
  dpr: number
}

export type InputState = {
  thrust: boolean
  thrustPointerId: number | null
}

export type GhostSample = { t: number; x: number; y: number; thrust?: boolean }

export type GhostRun = {
  version: 1
  trackId: string
  // Hash of track geometry/materials at the time of recording.
  // If missing, treat as incompatible with current tracks.
  trackHash?: string
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
  trackMaxY: number // lowest point of the track in world coords (y grows downward)

  camera: {
    x: number
    y: number
    zoom: number
  }

  runStarted: boolean
  timeMs: number
  finished: boolean
  finishHandled: boolean
  dead: boolean

  startPlatform: {
    active: boolean
    x0: number
    x1: number
    y: number
  }

  disc: {
    p: Vec2
    v: Vec2
    r: number
    // Visual-only rotation for rendering (radians).
    rot: number
    grounded: boolean
    groundMat: TrackMaterial
    groundN: Vec2
    groundT: Vec2 // ground tangent (best effort; used for boost rails, etc.)
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
  const discR = 16
  const platformY = track.start.p.y - 120
  const bounds = trackBounds(track.segments)
  return {
    view: { width: 360, height: 640, dpr: 1 },
    input: { thrust: false, thrustPointerId: null },
    track,
    trackMaxY: bounds.maxY,
    camera: { x: track.start.p.x + 160, y: track.start.p.y - 120, zoom: 1 },
    runStarted: false,
    timeMs: 0,
    finished: false,
    finishHandled: false,
    dead: false,
    startPlatform: {
      active: true,
      x0: track.start.p.x - (discR + 24),
      x1: track.start.p.x + (discR + 24),
      y: platformY,
    },
    disc: {
      // Start on a small platform above the track, stationary until first input.
      p: { x: track.start.p.x, y: platformY - discR },
      v: { x: 0, y: 0 },
      r: discR,
      rot: 0,
      grounded: false,
      groundMat: 'normal',
      groundN: { x: 0, y: -1 },
      groundT: { x: 1, y: 0 },
      groundBlend: 0,
    },
    jet: { energy: JET_MAX_ENERGY, draining: false },
    coinsCollected: new Set(),
    bestTimeMs: null,
    bestGhost: null,
    ghostPlayback: { active: false, t: 0 },
    recording: { active: true, samplesHz: 60, nextSampleT: 0, samples: [] },
    result: null,
  }
}


