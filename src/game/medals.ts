import { clamp, dot, len, sub, type Vec2 } from './math'
import type { TrackCoin, TrackDef, TrackSegment } from './track'
import { closestPointOnSegment, findSegWindowByX, segNormalUp, segXRangeContains } from './track'
import { createInitialRunState } from './state'
import { stepSim } from './sim'

export type MedalTimes = { bronzeMs: number; silverMs: number; goldMs: number }
export type IdealLine = {
  version: 1
  trackId: string
  timeMs: number
  samplesHz: number
  samples: Array<{ t: number; x: number; y: number; vx: number; vy: number }>
}
export type GeneratedCoins = { version: 1; trackId: string; coins: TrackCoin[] }

const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp01 = (x: number) => clamp(x, 0, 1)

const closestPointOnTrack = (trackId: string, p: Vec2, segs: TrackSegment[]) => {
  let bestD2 = Infinity
  let bestQ: Vec2 = { x: 0, y: 0 }
  let bestN: Vec2 = { x: 0, y: -1 }
  // Use x-window search for speed (tracks are monotonic in x).
  // IMPORTANT: must key the segment index per-track. Sharing across tracks can pick the wrong
  // window and break the controller (and precompute).
  const win = findSegWindowByX(trackId, segs, p.x, 42)
  for (let i = win.a; i <= win.b; i++) {
    const s = segs[i]!
    if (!segXRangeContains(s, p.x, 420)) continue
    const q = closestPointOnSegment(p, s.a, s.b)
    const dx = p.x - q.x
    const dy = p.y - q.y
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) {
      bestD2 = d2
      bestQ = { x: q.x, y: q.y }
      bestN = segNormalUp(s.a, s.b)
    }
  }
  return { q: bestQ, nUp: bestN, dist: Math.sqrt(bestD2) }
}

type Policy = {
  // Desired clearance above track along the local up-normal.
  gap: number
  // Controller gains.
  kp: number
  kv: number
  // Anticipation: sample ground a bit ahead in x.
  lookaheadSec: number
  // Thrust “hysteresis” so it doesn’t chatter.
  onThresh: number
  offThresh: number
}

const decideThrust = (track: TrackDef, p: Vec2, v: Vec2, pol: Policy) => {
  const lookX = p.x + Math.max(0, v.x) * pol.lookaheadSec
  const probe = closestPointOnTrack(track.id, { x: lookX, y: p.y }, track.segments)
  const q = probe.q
  const n = probe.nUp
  // Signed distance along “up” normal.
  const along = dot(sub(p, q), n)
  const vAlong = dot(v, n)

  // Error is positive when we’re “too high” (too far above the track).
  const err = along - pol.gap
  // PD control tries to keep us near the surface while staying in contact for speed.
  const u = pol.kp * (-err) + pol.kv * (-vAlong)
  // Convert controller output into a stable boolean with hysteresis.
  if (u > pol.onThresh) return true
  if (u < pol.offThresh) return false
  // In the deadband, bias off (preserve energy + don’t over-float).
  return false
}

const runPolicyOnce = (track: TrackDef, pol: Policy, seed: number) => {
  const s = createInitialRunState(track)
  // Disable expensive extras; we only care about finish time.
  s.recording.active = false
  s.ghostPlayback.active = false
  s.bestGhost = null
  s.bestTimeMs = null
  // Big view so camera death never matters in the estimator.
  s.view.width = 1000
  s.view.height = 1000
  s.view.dpr = 1
  s.camera.x = s.disc.p.x
  s.camera.y = s.disc.p.y
  s.camera.zoom = 1

  const rand = mulberry32(seed)
  // Small random micro-variation to avoid “knife edge” policy artifacts.
  const noise = () => (rand() * 2 - 1) * 0.07

  const dt = 1 / 120
  // Give long / slow tracks enough time to finish during estimation.
  const minSec = 120
  const estSec = track.finishX / 110 // px / (px/s) ~= seconds (conservative)
  const maxSec = Math.max(minSec, Math.min(220, estSec * 1.6 + 25))
  const steps = Math.floor(maxSec / dt)

  // Sample the resulting “line” so we can place coins on it later.
  const samplesHz = 60
  let nextSampleT = 0
  const samples: IdealLine['samples'] = []

  for (let i = 0; i < steps; i++) {
    if (s.finished) break
    const thrust = decideThrust(track, s.disc.p, s.disc.v, pol)
    // Add tiny noise so policies don’t overfit exactly to one deterministic cycle.
    s.input.thrust = thrust && rand() + noise() > 0.06
    stepSim(s, dt)

    const tSec = s.timeMs / 1000
    if (tSec + 1e-6 >= nextSampleT) {
      samples.push({ t: tSec, x: s.disc.p.x, y: s.disc.p.y, vx: s.disc.v.x, vy: s.disc.v.y })
      nextSampleT = samples.length / samplesHz
    }

    // If we’re catastrophically off course, abort.
    // Allow large airborne gaps (deep valleys / big launches) so we don't incorrectly fail.
    const probe = closestPointOnTrack(track.id, s.disc.p, track.segments)
    if (probe.dist > 4200) return null
  }

  if (!s.finished) return null
  const timeMs = Math.round(s.timeMs)
  // Ensure final sample is included.
  const tSec = timeMs / 1000
  if (samples.length === 0 || Math.abs(samples[samples.length - 1]!.t - tSec) > 1 / samplesHz) {
    samples.push({ t: tSec, x: s.disc.p.x, y: s.disc.p.y, vx: s.disc.v.x, vy: s.disc.v.y })
  }
  const line: IdealLine = {
    version: 1,
    trackId: track.id,
    timeMs,
    samplesHz,
    samples,
  }
  return line
}

export const estimateIdealLine = (track: TrackDef, opts?: { budget?: number; seed?: number }) => {
  // budget is “policy attempts”; keep low so it’s usable on mobile.
  const budget = Math.max(40, Math.min(220, opts?.budget ?? 140))
  const seedBase = (opts?.seed ?? 12345) >>> 0
  const rand = mulberry32(seedBase)

  let best: IdealLine | null = null

  for (let i = 0; i < budget; i++) {
    // Sample a family of “strong player” policies.
    // Mix “hug the ground” (usually fastest) and “float” (safer) families.
    const hug = rand() < 0.62
    const gap = hug ? 6 + rand() * 42 : 26 + rand() * 120
    const kp = hug ? 0.25 + rand() * 2.1 : 0.9 + rand() * 2.2
    const kv = hug ? 0.02 + rand() * 0.28 : 0.10 + rand() * 0.55
    const lookaheadSec = hug ? 0.06 + rand() * 0.22 : 0.10 + rand() * 0.35
    // Make thrust rarer in hug mode (generally faster for our physics).
    const onThresh = hug ? 1.0 + rand() * 2.2 : 0.35 + rand() * 0.85
    const offThresh = hug ? -0.9 - rand() * 1.4 : -0.20 - rand() * 0.65

    const pol: Policy = { gap, kp, kv, lookaheadSec, onThresh, offThresh }
    const line = runPolicyOnce(track, pol, seedBase ^ (i * 0x9e3779b9))
    if (line == null) continue
    if (best == null || line.timeMs < best.timeMs) best = line
  }

  return best
}

export const deriveMedalsFromBaseline = (baselineMs: number): MedalTimes => {
  // baseline is “strong run”. Gold should be close to that so it's meaningfully challenging.
  const gold = Math.round(baselineMs * 1.08)
  const silver = Math.round(gold * 1.18)
  const bronze = Math.round(gold * 1.38)
  return { bronzeMs: bronze, silverMs: silver, goldMs: gold }
}

const medalsKey = (trackId: string) => `slopes-medals-v2-${trackId}`
const idealLineKey = (trackId: string) => `slopes-ideal-line-v1-${trackId}`
const coinsKey = (trackId: string) => `slopes-ideal-coins-v1-${trackId}`

export const loadCachedMedals = (trackId: string): MedalTimes | null => {
  try {
    const raw = window.localStorage.getItem(medalsKey(trackId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as MedalTimes
    if (!parsed) return null
    const ok =
      Number.isFinite(parsed.bronzeMs) &&
      Number.isFinite(parsed.silverMs) &&
      Number.isFinite(parsed.goldMs) &&
      parsed.goldMs > 0 &&
      parsed.silverMs >= parsed.goldMs &&
      parsed.bronzeMs >= parsed.silverMs
    return ok ? parsed : null
  } catch {
    return null
  }
}

export const saveCachedMedals = (trackId: string, medals: MedalTimes) => {
  try {
    window.localStorage.setItem(medalsKey(trackId), JSON.stringify(medals))
  } catch {
    // best-effort
  }
}

export const loadCachedIdealLine = (trackId: string): IdealLine | null => {
  try {
    const raw = window.localStorage.getItem(idealLineKey(trackId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as IdealLine
    if (!parsed || parsed.version !== 1) return null
    if (parsed.trackId !== trackId) return null
    if (!Array.isArray(parsed.samples) || parsed.samples.length < 2) return null
    return parsed
  } catch {
    return null
  }
}

export const saveCachedIdealLine = (trackId: string, line: IdealLine) => {
  try {
    window.localStorage.setItem(idealLineKey(trackId), JSON.stringify(line))
  } catch {
    // best-effort
  }
}

export const loadCachedIdealCoins = (trackId: string): TrackCoin[] | null => {
  try {
    const raw = window.localStorage.getItem(coinsKey(trackId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as GeneratedCoins
    if (!parsed || parsed.version !== 1) return null
    if (parsed.trackId !== trackId) return null
    if (!Array.isArray(parsed.coins)) return null
    return parsed.coins.filter(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.r === 'number' &&
        c.p &&
        typeof c.p.x === 'number' &&
        typeof c.p.y === 'number',
    )
  } catch {
    return null
  }
}

export const saveCachedIdealCoins = (trackId: string, coins: TrackCoin[]) => {
  try {
    const payload: GeneratedCoins = { version: 1, trackId, coins }
    window.localStorage.setItem(coinsKey(trackId), JSON.stringify(payload))
  } catch {
    // best-effort
  }
}

export const generateCoinsFromIdealLine = (track: TrackDef, line: IdealLine, opts?: { count?: number }) => {
  const targetCount = Math.max(6, Math.min(64, opts?.count ?? Math.round(track.finishX / 520)))
  const out: TrackCoin[] = []

  // Compute speeds per sample.
  const speeds: number[] = []
  for (const s of line.samples) speeds.push(Math.hypot(s.vx, s.vy))
  const sorted = [...speeds].sort((a, b) => a - b)
  const q = (p: number) => sorted[Math.floor(clamp01(p) * (sorted.length - 1))] ?? 0
  const minSpeed = q(0.62) // keep coins on the faster half-ish of the run

  const minDx = Math.max(220, track.finishX / targetCount)
  let lastX = -Infinity
  let coinId = 1

  for (let i = 0; i < line.samples.length && out.length < targetCount; i++) {
    const s = line.samples[i]!
    if (s.x < lastX + minDx) continue
    const sp = speeds[i]!
    if (sp < minSpeed) continue

    // Place coin slightly above the ideal centerline so it reads “collectible” rather than “inside you”,
    // while still being guaranteed to intersect the disc.
    const probe = closestPointOnTrack(track.id, { x: s.x, y: s.y }, track.segments)
    const n = probe.nUp
    const upOffset = 10
    const p = { x: s.x + n.x * upOffset, y: s.y + n.y * upOffset }

    out.push({ id: `i${coinId++}`, p, r: 14 })
    lastX = s.x
  }

  return out
}


