import { clamp, dot, len, mul, normalize, sub, type Vec2 } from './math'
import type { RunState } from './state'
import { coinHit, closestPointOnSegment, querySegIndicesAabb, segNormalUp } from './track'
import { JET_MAX_ENERGY } from './tuning'

const GRAVITY = 1400 // px/s^2
const JET_ACCEL = 2475 // px/s^2 upwards when thrusting (increased by 50% from 1650)
const AIR_DRAG = 0.06 // quadratic-ish via dt-stable multiplier
const MAX_SPEED = 2400

const GROUND_STICK_EPS = 0.9
const GROUND_SNAP_DIST = 4

// Landing smoothing: ramp into “fully constrained to slope” over a short window.
// This keeps mild slopes from instantly nuking forward speed on contact.
const LANDING_BLEND_TIME = 0.14
const LANDING_VEL_TC = 0.10
const LANDING_PRESERVE_SPEED = 0.90

const MAX_SUBSTEPS = 6

const capSpeed = (v: Vec2) => {
  const s = Math.hypot(v.x, v.y)
  if (s <= MAX_SPEED) return v
  const k = MAX_SPEED / Math.max(1e-6, s)
  return { x: v.x * k, y: v.y * k }
}

const dtStableDrag = (v: Vec2, k: number, dt: number) => {
  // Exponential decay: v *= exp(-k*dt)
  const f = Math.exp(-k * dt)
  return { x: v.x * f, y: v.y * f }
}

const bestMedal = (timeMs: number, bronzeMs: number, silverMs: number, goldMs: number) => {
  if (timeMs <= goldMs) return 'gold'
  if (timeMs <= silverMs) return 'silver'
  if (timeMs <= bronzeMs) return 'bronze'
  return 'none'
}

export const stepSim = (s: RunState, dtSecRaw: number) => {
  if (s.dead || s.finished) return
  if (!s.runStarted) return

  const dtSec = Math.min(0.05, dtSecRaw)
  const subSteps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(dtSec / (1 / 120))))
  const h = dtSec / subSteps

  for (let step = 0; step < subSteps; step++) {
    const disc = s.disc

    // Integrate time (ms) in the same sub-stepped loop so recording/playback aligns.
    s.timeMs += h * 1000

    // Forces: gravity + jet (world-up).
    let ax = 0
    let ay = GRAVITY

    const thrusting = s.input.thrust && s.jet.energy > 0 && !s.finished && !s.dead
    s.jet.draining = thrusting
    if (thrusting) {
      ay -= JET_ACCEL
      // Drain energy in air or on ground alike; only recharge on ground (per spec).
      s.jet.energy = clamp(s.jet.energy - h * 0.55, 0, JET_MAX_ENERGY)
    }

    // Integrate velocity.
    disc.v.x += ax * h
    disc.v.y += ay * h
    disc.v = capSpeed(disc.v)

    // Air drag (very light; mostly for stability on mobile).
    disc.v = dtStableDrag(disc.v, AIR_DRAG, h)

    // Integrate position.
    disc.p.x += disc.v.x * h
    disc.p.y += disc.v.y * h

    // Collide with track segments.
    const wasGrounded = disc.grounded
    disc.grounded = false
    disc.groundN = { x: 0, y: -1 }

    // Performance: spatial hash query for segments near the disc (tracks can loop/backtrack).
    const pad = disc.r + GROUND_SNAP_DIST + 10
    const cand = querySegIndicesAabb(
      s.track.id,
      s.track.segments,
      { minX: disc.p.x - pad, minY: disc.p.y - pad, maxX: disc.p.x + pad, maxY: disc.p.y + pad },
      160,
    )

    for (let ci = 0; ci < cand.length; ci++) {
      const seg = s.track.segments[cand[ci]!]!
      const q = closestPointOnSegment(disc.p, seg.a, seg.b)
      const d = sub(disc.p, q)
      const dist = len(d)
      const target = disc.r

      // “Generous” contact: if we’re very close, treat as contact even if slightly separated.
      if (dist <= target + GROUND_SNAP_DIST) {
        // Determine the “ground/up” normal for this segment and only allow it to be ground
        // if the contact is from above-ish.
        const nUp = segNormalUp(seg.a, seg.b)
        const toCenter = dist > 1e-6 ? { x: d.x / dist, y: d.y / dist } : { ...nUp }
        const fromAbove = dot(toCenter, nUp) > 0.15
        if (!fromAbove) continue

        // If we're not actually intersecting and we're moving away from the ground,
        // do NOT "magnet snap" back down — this enables clean lift-off with the jetpack.
        const vnUp = dot(disc.v, nUp) // + means moving upward (away from ground)
        const isPenetrating = dist < target - 0.25
        if (!isPenetrating && vnUp > 60) continue

        // Penetration resolution (only if overlapping or within snap).
        const pen = target - dist
        const push = pen > 0 ? pen : Math.min(GROUND_SNAP_DIST, target + GROUND_SNAP_DIST - dist)
        if (push > 0) {
          disc.p.x += toCenter.x * push
          disc.p.y += toCenter.y * push
        }

        // Velocity: instead of instantly projecting onto the slope (which can feel like a hard stop),
        // ease the correction over a short landing window and bias toward preserving speed.
        //
        // We still keep the solver stable by doing positional correction first.
        const n = nUp
        const vn = dot(disc.v, n) // n points away from ground; vn < 0 means moving into ground
        if (vn < 0) {
          const v0 = { ...disc.v }
          const speed0 = Math.hypot(v0.x, v0.y)

          // Fully inelastic projection (kills into-ground normal component).
          const vProj = { x: v0.x - n.x * vn, y: v0.y - n.y * vn }

          // “Preserve speed” variant: keep magnitude closer to pre-impact by scaling the projected vector.
          let vTarget = vProj
          const speedProj = Math.hypot(vProj.x, vProj.y)
          if (speed0 > 1e-3 && speedProj > 1e-3) {
            const k = speed0 / speedProj
            const vNoLoss = { x: vProj.x * k, y: vProj.y * k }
            vTarget = {
              x: vProj.x + (vNoLoss.x - vProj.x) * LANDING_PRESERVE_SPEED,
              y: vProj.y + (vNoLoss.y - vProj.y) * LANDING_PRESERVE_SPEED,
            }
          }

          // Landing blend: ramp from 0->1 when we first become grounded.
          if (!wasGrounded) disc.groundBlend = 0
          disc.groundBlend = clamp(disc.groundBlend + h / LANDING_BLEND_TIME, 0, 1)

          // Time-constant for smooth convergence (dt-stable).
          const alpha = (1 - Math.exp(-h / Math.max(1e-6, LANDING_VEL_TC))) * disc.groundBlend
          disc.v.x = v0.x + (vTarget.x - v0.x) * alpha
          disc.v.y = v0.y + (vTarget.y - v0.y) * alpha

          // Safety: don’t allow strong “into ground” velocity to persist (prevents tunneling on steep hits).
          const vn2 = dot(disc.v, n)
          if (vn2 < -120) {
            disc.v.x -= n.x * vn2
            disc.v.y -= n.y * vn2
          }
        }

        // Tiny “stick” bias so we don’t hover off ramps between frames.
        if (isPenetrating || vn < 30) {
          disc.p.x -= n.x * (GROUND_STICK_EPS * 0.35)
          disc.p.y -= n.y * (GROUND_STICK_EPS * 0.35)
        }

        disc.grounded = true
        disc.groundN = n

        break
      }
    }

    if (!disc.grounded) {
      disc.groundBlend = 0
    }

    // Ground recharge for jet energy (Noita-style: only when grounded and not thrusting).
    if (disc.grounded && !thrusting) {
      s.jet.energy = clamp(s.jet.energy + h * 1.35, 0, JET_MAX_ENERGY)
    }

    // Coin pickup.
    for (const c of s.track.coins) {
      if (s.coinsCollected.has(c.id)) continue
      if (coinHit(disc.p, disc.r, c)) {
        s.coinsCollected.add(c.id)
        const nav: any = typeof navigator !== 'undefined' ? (navigator as any) : null
        if (nav && typeof nav.vibrate === 'function') nav.vibrate(8)
      }
    }

    // Finish line: simple x threshold, but only count it when we're alive.
    if (disc.p.x >= s.track.finishX) {
      s.finished = true
      const timeMs = Math.max(1, Math.round(s.timeMs))
      const medal = bestMedal(timeMs, s.track.medals.bronzeMs, s.track.medals.silverMs, s.track.medals.goldMs)
      const coinsTotal = s.track.coins.length
      const coinsCollected = s.coinsCollected.size
      // "Author" rating is only meaningful if the track actually has coins.
      const author = coinsTotal > 0 && medal === 'gold' && coinsCollected === coinsTotal
      const prevBest = s.bestTimeMs
      const newBestTime = prevBest == null || timeMs < prevBest
      s.result = {
        finished: true,
        timeMs,
        coinsCollected,
        coinsTotal,
        medal,
        author,
        newBestTime,
      }
    }

    // Death rule (handled by camera): we only set s.dead from outside (App tick) since it depends on camera bounds.

    // Recording sample (fixed Hz in sim time).
    if (s.recording.active && !s.dead && !s.finished) {
      const tSec = s.timeMs / 1000
      if (tSec + 1e-6 >= s.recording.nextSampleT) {
        s.recording.samples.push({ t: tSec, x: disc.p.x, y: disc.p.y, thrusting })
        s.recording.nextSampleT = s.recording.samples.length / s.recording.samplesHz
      }
    }
  }
}

export const sampleGhostAt = (samples: Array<{ t: number; x: number; y: number; thrusting: boolean }>, t: number) => {
  if (samples.length === 0) return null
  if (t <= samples[0]!.t) return { x: samples[0]!.x, y: samples[0]!.y, thrusting: samples[0]!.thrusting }
  const last = samples[samples.length - 1]!
  if (t >= last.t) return { x: last.x, y: last.y, thrusting: last.thrusting }

  // Linear search is fine for v1 sample counts; if needed we can binary search.
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i]!
    if (b.t >= t) {
      const a = samples[i - 1]!
      const span = Math.max(1e-6, b.t - a.t)
      const u = clamp((t - a.t) / span, 0, 1)
      // Use thrusting state from earlier sample (no interpolation needed for boolean)
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, thrusting: a.thrusting }
    }
  }
  return { x: last.x, y: last.y, thrusting: last.thrusting }
}


