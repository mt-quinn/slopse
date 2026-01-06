import { clamp, dot, len, sub, type Vec2 } from './math'

// Track surface type.
// (Mag + kill fields were removed; boosters remain.)
export type TrackMaterial = 'normal' | 'boost'

export type TrackSegment = { a: Vec2; b: Vec2; mat: TrackMaterial }

export type TrackCoin = { id: string; p: Vec2; r: number }

export type TrackDef = {
  id: string
  name: string
  trackHash: string
  // Constant per-track "plane" tilt applied after generation (degrees).
  // 0 = current flat world; 30 = max downsloped plane.
  planeDeg?: number
  start: { p: Vec2; v: Vec2 }
  finishX: number
  segments: TrackSegment[]
  coins: TrackCoin[]
  medals: { bronzeMs: number; silverMs: number; goldMs: number }
}

export const DAILY_TRACK_VERSION = 1

export const localDateKey = (d = new Date()) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// --- Segment spatial index (performance) ---
// Tracks are no longer assumed monotonic in X (Line Rider style). We use a simple spatial hash
// (uniform grid) to quickly find nearby segments for collision queries.
type SpatialIndex = {
  cellSize: number
  buckets: Map<number, number[]>
  stamp: Uint32Array
  stampId: number
}

// Cache by segments array identity so live-edited tracks (editor) always rebuild their index.
// Also keyed by cellSize because different query radii may want different bucket sizes.
const spatialCache = new WeakMap<TrackSegment[], Map<number, SpatialIndex>>()

const segMinX = (s: TrackSegment) => (s.a.x <= s.b.x ? s.a.x : s.b.x)
const segMaxX = (s: TrackSegment) => (s.a.x >= s.b.x ? s.a.x : s.b.x)
const segMinY = (s: TrackSegment) => (s.a.y <= s.b.y ? s.a.y : s.b.y)
const segMaxY = (s: TrackSegment) => (s.a.y >= s.b.y ? s.a.y : s.b.y)

const packCellKey = (cx: number, cy: number) => ((cx & 0xffff) << 16) | (cy & 0xffff)

export const getSpatialIndex = (_trackId: string, segs: TrackSegment[], cellSize = 160): SpatialIndex => {
  let byCell = spatialCache.get(segs)
  if (!byCell) {
    byCell = new Map()
    spatialCache.set(segs, byCell)
  }
  const cached = byCell.get(cellSize)
  if (cached) return cached

  const buckets = new Map<number, number[]>()
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    const minX = segMinX(s)
    const maxX = segMaxX(s)
    const minY = segMinY(s)
    const maxY = segMaxY(s)
    const ax = Math.floor(minX / cellSize)
    const bx = Math.floor(maxX / cellSize)
    const ay = Math.floor(minY / cellSize)
    const by = Math.floor(maxY / cellSize)
    for (let cx = ax; cx <= bx; cx++) {
      for (let cy = ay; cy <= by; cy++) {
        const k = packCellKey(cx, cy)
        const arr = buckets.get(k)
        if (arr) arr.push(i)
        else buckets.set(k, [i])
      }
    }
  }

  const idx: SpatialIndex = {
    cellSize,
    buckets,
    stamp: new Uint32Array(Math.max(1, segs.length)),
    stampId: 1,
  }
  byCell.set(cellSize, idx)
  return idx
}

export const querySegIndicesAabb = (
  trackId: string,
  segs: TrackSegment[],
  aabb: { minX: number; minY: number; maxX: number; maxY: number },
  cellSize = 160,
) => {
  const idx = getSpatialIndex(trackId, segs, cellSize)
  // Resize stamp if segment count changed (shouldn't when cached hits, but safe).
  if (idx.stamp.length !== segs.length) idx.stamp = new Uint32Array(Math.max(1, segs.length))
  idx.stampId = (idx.stampId + 1) >>> 0
  if (idx.stampId === 0) {
    idx.stamp.fill(0)
    idx.stampId = 1
  }

  const cs = idx.cellSize
  const ax = Math.floor(aabb.minX / cs)
  const bx = Math.floor(aabb.maxX / cs)
  const ay = Math.floor(aabb.minY / cs)
  const by = Math.floor(aabb.maxY / cs)

  const out: number[] = []
  for (let cx = ax; cx <= bx; cx++) {
    for (let cy = ay; cy <= by; cy++) {
      const k = packCellKey(cx, cy)
      const arr = idx.buckets.get(k)
      if (!arr) continue
      for (const si of arr) {
        if (idx.stamp[si] === idx.stampId) continue
        idx.stamp[si] = idx.stampId
        out.push(si)
      }
    }
  }
  return out
}

const catmullRom = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 => {
  // Uniform Catmull–Rom spline (C1 smooth).
  const t2 = t * t
  const t3 = t2 * t
  return {
    x:
      0.5 *
      ((2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      ((2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  }
}

export const buildCatmullRomSegments = (ctrl: Vec2[], stepPx: number): TrackSegment[] => {
  if (ctrl.length < 2) return []
  const pts: Vec2[] = []
  const step = Math.max(4, stepPx)
  const n = ctrl.length

  // Start at first control point.
  pts.push({ ...ctrl[0]! })

  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[i - 1] ?? ctrl[i]!
    const p1 = ctrl[i]!
    const p2 = ctrl[i + 1]!
    const p3 = ctrl[i + 2] ?? ctrl[i + 1]!

    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const steps = Math.max(6, Math.ceil(chord / step))
    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      const p = catmullRom(p0, p1, p2, p3, t)
      pts.push(p)
    }
  }

  const segs: TrackSegment[] = []
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (dx * dx + dy * dy < 1e-6) continue
    segs.push({ a, b, mat: 'normal' })
  }
  return segs
}

const catmullRom1d = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

// Forward-only (strictly increasing X) Catmull–Rom sampling:
// - X is lerped between consecutive control points (monotonic).
// - Y is Catmull–Rom over the y-values (smooth).
// This prevents local backtracking/loops in X while keeping the "flowy" feel.
export const buildForwardCatmullRomSegments = (ctrl: Vec2[], stepPx: number): TrackSegment[] => {
  if (ctrl.length < 2) return []
  const step = Math.max(4, stepPx)
  const pts: Vec2[] = []

  pts.push({ ...ctrl[0]! })
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[i - 1] ?? ctrl[i]!
    const p1 = ctrl[i]!
    const p2 = ctrl[i + 1]!
    const p3 = ctrl[i + 2] ?? ctrl[i + 1]!

    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const chord = Math.hypot(dx, dy)
    const steps = Math.max(6, Math.ceil(chord / step))

    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      const x = p1.x + (p2.x - p1.x) * t
      const y = catmullRom1d(p0.y, p1.y, p2.y, p3.y, t)
      pts.push({ x, y })
    }
  }

  const segs: TrackSegment[] = []
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (dx * dx + dy * dy < 1e-6) continue
    // Enforce strict forward progression (numerical safety).
    if (b.x <= a.x + 1e-6) continue
    segs.push({ a, b, mat: 'normal' })
  }
  return segs
}

const hash32 = (s: string) => {
  // FNV-1a 32-bit
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

const hex8 = (u: number) => (u >>> 0).toString(16).padStart(8, '0')

const hashTrackSegments = (segs: TrackSegment[]) => {
  // FNV-1a over integerized segment endpoints + material, stable across runs.
  let h = 2166136261 >>> 0
  const mix = (n: number) => {
    h ^= n >>> 0
    h = Math.imul(h, 16777619) >>> 0
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    mix(Math.round(s.a.x))
    mix(Math.round(s.a.y))
    mix(Math.round(s.b.x))
    mix(Math.round(s.b.y))
    mix(s.mat === 'boost' ? 1 : 0)
  }
  return hex8(h)
}

const mkRng = (seed: number) => {
  let x = (seed >>> 0) || 0x12345678
  const u01 = () => {
    // xorshift32
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return ((x >>> 0) & 0xffffffff) / 0x100000000
  }
  const s = () => u01() * 2 - 1
  return {
    u01,
    s,
    int: (a: number, b: number) => Math.floor(u01() * (b - a + 1)) + a,
    pick: <T,>(arr: T[]) => arr[Math.floor(u01() * arr.length)]!,
  }
}

// Reduce extreme peak height a bit so dailies remain summit-able with current jet rules.
const clampY = (y: number) => clamp(y, 140, 1200)

const ease01 = (t: number) => t * t * (3 - 2 * t)

const enforceGradeClamp = (ysIn: number[], dx: number) => {
  // Clamp *only* truly extreme grades (keeps playability, doesn't flatten macro-shapes).
  const ys = ysIn.slice()
  const maxDownSlope = 1.35
  const maxUpSlope = 0.95
  const maxDy = maxDownSlope * Math.max(1, dx)
  const minDy = -maxUpSlope * Math.max(1, dx)
  for (let i = 1; i < ys.length; i++) {
    const prev = ys[i - 1]!
    const cur = ys[i]!
    const dy = clamp(cur - prev, minDy, maxDy)
    ys[i] = clampY(prev + dy)
  }
  return ys
}

const ensureVerticalRange = (ysIn: number[], wantRange: number) => {
  let minY = Infinity
  let maxY = -Infinity
  for (const y of ysIn) {
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const range = maxY - minY
  if (range >= wantRange) return ysIn
  const mid = (minY + maxY) * 0.5
  const k = wantRange / Math.max(1, range)
  return ysIn.map((y) => clampY(mid + (y - mid) * k))
}

const generateDailyYs = (ctrlCount: number, dx: number, rng: ReturnType<typeof mkRng>) => {
  const ys: number[] = new Array(ctrlCount).fill(0)
  const startY = clampY(rng.int(480, 620))

  // Warmup that feels like Longline: short pad → meaningful descent → recovery → small rollers.
  const depth = rng.int(420, 720)
  const recovery = rng.int(140, 260)
  const rA = rng.int(90, 180)
  const rB = rng.int(70, 160)
  const yOff = [
    0,
    rng.int(-8, 16),
    Math.round(depth * 0.10),
    Math.round(depth * 0.28),
    Math.round(depth * 0.50),
    Math.round(depth * 0.74),
    depth,
    Math.round(depth - (depth - recovery) * 0.55),
    recovery,
    recovery + rA,
    Math.max(0, recovery - Math.round(rB * 0.65)),
    recovery + Math.round(rB * 0.95),
    recovery + Math.round(rB * 0.25),
  ]
  const warmEnd = Math.min(ctrlCount - 1, 12)
  for (let i = 0; i <= warmEnd; i++) ys[i] = clampY(startY + yOff[i]!)

  let i = warmEnd + 1
  let y = ys[warmEnd]!

  const addSection = (steps: number, dyTotal: number, bumps: number, bumpAmp: number) => {
    const y0 = y
    for (let k = 1; k <= steps; k++) {
      if (i >= ctrlCount) return
      const t = k / steps
      const base = y0 + ease01(t) * dyTotal
      const wave = bumps > 0 ? Math.sin(t * Math.PI * 2 * bumps) * bumpAmp : 0
      ys[i] = clampY(base + wave)
      y = ys[i]!
      i++
    }
  }

  const remaining = () => ctrlCount - i

  // Macro structure: we always include a cathedral-style deep dip + ridge.
  // Then we interleave long ski downs + roller gardens until we reach the end.
  // (These are the beats that make Longline/Cathedral feel "intentional".)
  while (remaining() > 10) {
    const r = remaining()
    if (r < 20) break

    const pick = rng.pick(['ski', 'rollers', 'cathedral'] as const)
    if (pick === 'ski') {
      const steps = rng.int(10, 18) // ~2.5k–5k px
      const dy = rng.int(380, 820)
      addSection(steps, dy, rng.int(1, 2), rng.int(60, 140))
      // recovery bump
      addSection(rng.int(6, 10), -rng.int(180, 420), 1, rng.int(40, 110))
    } else if (pick === 'rollers') {
      const steps = rng.int(12, 22)
      const drift = rng.int(-180, 180)
      addSection(steps, drift, rng.int(3, 6), rng.int(170, 320))
    } else {
      // Cathedral beat: deep drop + tall ridge.
      const dropSteps = rng.int(8, 14)
      const drop = rng.int(720, 1250)
      addSection(dropSteps, drop, 1, rng.int(90, 170))

      const ridgeSteps = rng.int(9, 16)
      const ridge = -rng.int(780, 1350)
      addSection(ridgeSteps, ridge, 1, rng.int(80, 150))
    }
  }

  // Finish: guide toward a reasonable end height (no weird cliff endings).
  const endY = clampY(rng.int(280, 520))
  const stepsToEnd = Math.max(6, remaining() - 1)
  const dyEnd = endY - y
  addSection(stepsToEnd, dyEnd, rng.int(1, 2), rng.int(40, 90))

  // Fill any leftover slots.
  while (i < ctrlCount) {
    ys[i] = y
    i++
  }

  // Ensure we have Cathedral-like vertical range (slightly reduced to fit jet limits).
  const ys2 = ensureVerticalRange(ys, rng.int(600, 900))
  return enforceGradeClamp(ys2, dx)
}

const segSlope = (s: TrackSegment) => {
  const dx = s.b.x - s.a.x
  const dy = s.b.y - s.a.y
  return dy / Math.max(1e-6, dx)
}

const carveGapsAfterJumps = (segs: TrackSegment[], rng: ReturnType<typeof mkRng>, gapCount: number) => {
  if (gapCount <= 0) return segs
  if (segs.length < 120) return segs

  // Remove short windows of segments to create discontinuities (jumps/pits).
  // Constraint: discontinuities can only begin after an "uphill" jump ramp (kicker).
  // Keep these reasonably spaced and away from the very start/end.
  const windows: Array<{ a: number; b: number }> = []
  const minSep = 220
  const jumpSlopeThresh = -0.26 // uphill in y-down space (negative slope)
  const minRampLen = 4
  const maxLandingUphill = -0.08 // landing should not immediately be another strong uphill
  let guard = 0
  while (windows.length < gapCount && guard++ < 2000) {
    const len = rng.int(16, 34)
    const aMin = 60
    const aMax = Math.max(aMin, segs.length - 60 - len)
    const a = rng.int(aMin, aMax)

    // Ensure we have an uphill ramp run ending at a-1.
    let rampLen = 0
    for (let j = a - 1; j >= 0; j--) {
      if (segSlope(segs[j]!) <= jumpSlopeThresh) rampLen++
      else break
      if (rampLen >= minRampLen) break
    }
    if (rampLen < minRampLen) continue

    // Ensure the landing segment is not a hard uphill immediately.
    const landI = a + len + 1
    if (landI >= segs.length) continue
    const landSlope = segSlope(segs[landI]!)
    if (landSlope < maxLandingUphill) continue

    const b = a + len
    if (windows.some((w) => Math.abs(w.a - a) < minSep || (a <= w.b && b >= w.a))) continue
    windows.push({ a, b })
  }
  if (windows.length === 0) return segs

  const kill = new Uint8Array(segs.length)
  for (const w of windows) {
    for (let i = w.a; i <= w.b && i < segs.length; i++) kill[i] = 1
  }
  const out: TrackSegment[] = []
  for (let i = 0; i < segs.length; i++) if (!kill[i]) out.push(segs[i]!)
  return out
}

const applyBoostWindows = (segs: TrackSegment[], rng: ReturnType<typeof mkRng>, boostCount: number) => {
  if (segs.length < 20) return

  // Candidate indices for boosters.
  const uphill: number[] = []
  const downhillMid: number[] = []

  // Uphill candidates (dy/dx < 0).
  for (let i = 0; i < segs.length; i++) {
    const m = segSlope(segs[i]!)
    if (m < -0.22) uphill.push(i)
  }

  // Downhill runs: choose midpoints (landing approach).
  const downThresh = 0.26
  let i = 0
  while (i < segs.length) {
    while (i < segs.length && segSlope(segs[i]!) <= downThresh) i++
    const start = i
    while (i < segs.length && segSlope(segs[i]!) > downThresh) i++
    const end = i // exclusive
    const lenRun = end - start
    if (lenRun >= 18) downhillMid.push(start + Math.floor(lenRun / 2))
  }

  const candidates = [...uphill, ...downhillMid]
  if (candidates.length === 0) return

  // Pick spaced-apart windows.
  const chosen: number[] = []
  const minSep = 120 // segment index spacing (roughly distance-based)
  let guard = 0
  while (chosen.length < boostCount && guard++ < 2000) {
    const idx = candidates[rng.int(0, candidates.length - 1)]!
    if (chosen.some((j) => Math.abs(j - idx) < minSep)) continue
    chosen.push(idx)
  }

  // Apply a short boost window around each chosen index.
  for (const c of chosen) {
    const w = rng.int(10, 18)
    const a = Math.max(0, c - Math.floor(w / 2))
    const b = Math.min(segs.length - 1, c + Math.floor(w / 2))
    for (let k = a; k <= b; k++) segs[k]!.mat = 'boost'
  }
}

export const makeDailyTrack = (dateKey = localDateKey()): TrackDef => {
  const seed = hash32(`${DAILY_TRACK_VERSION}:${dateKey}`)
  return makeDailyTrackFromSeed(seed, { id: `daily-${dateKey}-v${DAILY_TRACK_VERSION}`, name: `Daily — ${dateKey}` })
}

export type DailyTrackGenOpts = {
  enableGaps?: boolean
  gapCount?: number | null // null/undefined => random
  enableBoosts?: boolean
  boostCount?: number | null // null/undefined => random
  // Apply a global plane tilt after generation:
  // - number: fixed degrees
  // - null/undefined: random 1..30 deg
  planeDeg?: number | null
  // Finish distance range override (in px). If omitted, uses the doubled default.
  finishX?: { min: number; max: number } | null
}

const applyPlaneTiltToSegments = (segs: TrackSegment[], planeDeg: number, origin: Vec2): TrackSegment[] => {
  const deg = clamp(planeDeg, 0, 30)
  if (deg <= 1e-6) return segs
  const a = (deg * Math.PI) / 180
  const s = Math.sin(a)
  const c = Math.cos(a)
  const x0 = origin.x
  const y0 = origin.y
  const tiltY = (p: Vec2): Vec2 => {
    const x = p.x - x0
    const y = p.y - y0
    // "Rotate" the plane while keeping forward (x) as our progress axis:
    // y' = y*cos(a) + x*sin(a)
    return { x: p.x, y: y0 + y * c + x * s }
  }
  return segs.map((seg) => ({ a: tiltY(seg.a), b: tiltY(seg.b), mat: seg.mat }))
}

export const makeDailyTrackFromSeed = (
  seed: number,
  meta?: { id?: string; name?: string },
  opts?: DailyTrackGenOpts,
): TrackDef => {
  const rng = mkRng(seed)

  // Target ~60–120s feel: long, fast, and varied (default length doubled).
  const fx = opts?.finishX
  const finishX = fx ? rng.int(fx.min, fx.max) : rng.int(38000, 55000)
  const dx = rng.int(220, 290)
  const ctrlCount = Math.max(28, Math.floor(finishX / dx) + 1)

  const ys = generateDailyYs(ctrlCount, dx, rng)
  const ctrl: Vec2[] = ys.map((y, i) => ({ x: i * dx, y }))

  // Strictly forward-only geometry.
  let segments = buildForwardCatmullRomSegments(ctrl, 16)

  // Discontinuities (gaps/pits) while still progressing forward.
  if (opts?.enableGaps ?? true) {
    // Enforced: at least 1 discontinuity unless explicitly overridden to 0.
    const gapCount = opts?.gapCount == null ? rng.int(1, 3) : Math.max(0, Math.floor(opts.gapCount))
    segments = carveGapsAfterJumps(segments, rng, gapCount)
  }

  // Boost rails.
  if (opts?.enableBoosts ?? true) {
    // Enforced: at least a few boost windows unless explicitly overridden to 0.
    const boostCount = opts?.boostCount == null ? rng.int(6, 16) : Math.max(0, Math.floor(opts.boostCount))
    applyBoostWindows(segments, rng, boostCount)
  }

  // Apply a per-track plane tilt AFTER generation decisions (keeps "core gen" unchanged).
  const planeDeg = opts?.planeDeg == null ? rng.int(1, 30) : clamp(opts.planeDeg, 0, 30)
  segments = applyPlaneTiltToSegments(segments, planeDeg, ctrl[0]!)

  // Medals are currently not the focus; keep placeholders so sim can still compute a RunResult.
  const goldMs = rng.int(68000, 112000)
  const silverMs = Math.round(goldMs * 1.05)
  const bronzeMs = Math.round(goldMs * 1.1)

  const id = meta?.id ?? `seed-${hex8(seed)}-v${DAILY_TRACK_VERSION}`
  const name = meta?.name ?? `Seed ${hex8(seed)}`
  const trackHash = hashTrackSegments(segments)
  return {
    id,
    name,
    trackHash,
    planeDeg,
    start: { p: { x: 40, y: ctrl[0]!.y - 40 }, v: { x: 260, y: 0 } },
    finishX,
    segments,
    coins: [],
    medals: { bronzeMs, silverMs, goldMs },
  }
}

export const closestPointOnSegment = (p: Vec2, a: Vec2, b: Vec2) => {
  const ab = sub(b, a)
  const ap = sub(p, a)
  const abLen2 = Math.max(1e-9, dot(ab, ab))
  const t = clamp(dot(ap, ab) / abLen2, 0, 1)
  return { x: a.x + ab.x * t, y: a.y + ab.y * t, t }
}

export const segNormalUp = (a: Vec2, b: Vec2): Vec2 => {
  // Choose the “upward” normal (negative y) for a segment.
  const dx = b.x - a.x
  const dy = b.y - a.y
  const L = Math.hypot(dx, dy) || 1
  // Two normals: (dy,-dx) and (-dy,dx). Pick the one with y < 0.
  const n1 = { x: dy / L, y: -dx / L }
  const n2 = { x: -dy / L, y: dx / L }
  return n1.y <= n2.y ? n1 : n2
}

export const trackBounds = (segments: TrackSegment[]) => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of segments) {
    minX = Math.min(minX, s.a.x, s.b.x)
    minY = Math.min(minY, s.a.y, s.b.y)
    maxX = Math.max(maxX, s.a.x, s.b.x)
    maxY = Math.max(maxY, s.a.y, s.b.y)
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX, minY, maxX, maxY }
}

export const coinHit = (p: Vec2, pr: number, coin: TrackCoin) => {
  const d = len(sub(p, coin.p))
  return d <= pr + coin.r
}


