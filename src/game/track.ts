import { clamp, dot, len, sub, type Vec2 } from './math'

export type TrackSegment = { a: Vec2; b: Vec2 }

export type TrackCoin = { id: string; p: Vec2; r: number }

export type TrackDef = {
  id: string
  name: string
  start: { p: Vec2; v: Vec2 }
  finishX: number
  segments: TrackSegment[]
  coins: TrackCoin[]
  medals: { bronzeMs: number; silverMs: number; goldMs: number }
}

export const getTrackById = (id: string) => ALL_TRACKS.find((t) => t.id === id) ?? null

// --- Segment indexing helpers (performance) ---
// Our tracks are monotonic in X. We can binary search by segment x-range and then
// test only a small neighborhood, instead of scanning the whole segment list.
const segMinX = (s: TrackSegment) => (s.a.x <= s.b.x ? s.a.x : s.b.x)
const segMaxX = (s: TrackSegment) => (s.a.x >= s.b.x ? s.a.x : s.b.x)

type SegIndex = { startX: number[] }
const segIndexCache = new Map<string, SegIndex>()

export const getSegIndex = (trackId: string, segs: TrackSegment[]): SegIndex => {
  const cached = segIndexCache.get(trackId)
  if (cached && cached.startX.length === segs.length) return cached
  const startX = segs.map((s) => segMinX(s))
  const idx = { startX }
  segIndexCache.set(trackId, idx)
  return idx
}

export const findSegWindowByX = (
  trackId: string,
  segs: TrackSegment[],
  x: number,
  halfWindow: number,
) => {
  const idx = getSegIndex(trackId, segs)
  const xs = idx.startX
  // upper_bound for x
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! <= x) lo = mid + 1
    else hi = mid
  }
  const center = Math.max(0, lo - 1)
  const a = Math.max(0, center - halfWindow)
  const b = Math.min(segs.length - 1, center + halfWindow)
  return { a, b }
}

export const segXRangeContains = (seg: TrackSegment, x: number, pad: number) => {
  const x0 = segMinX(seg) - pad
  const x1 = segMaxX(seg) + pad
  return x >= x0 && x <= x1
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
    segs.push({ a, b })
  }
  return segs
}

export const TRACK_001: TrackDef = {
  id: 'track-001',
  name: 'Warmup Slope',
  start: { p: { x: 40, y: 260 }, v: { x: 220, y: 0 } },
  finishX: 2600,
  medals: { bronzeMs: 26000, silverMs: 19000, goldMs: 14500 },
  // Smooth spline sampled into many tiny segments for collision + rendering.
  segments: buildCatmullRomSegments(
    [
      { x: 0, y: 320 },
      { x: 380, y: 320 },
      { x: 720, y: 240 },
      { x: 1040, y: 300 },
      { x: 1380, y: 520 },
      { x: 1540, y: 520 },
      { x: 1760, y: 360 },
      { x: 1960, y: 420 },
      { x: 2140, y: 320 },
      { x: 2360, y: 360 },
      { x: 2600, y: 280 },
    ],
    18,
  ),
  coins: [],
}

export const TRACK_002: TrackDef = {
  id: 'track-002',
  name: 'Longline (10k)',
  start: { p: { x: 40, y: 260 }, v: { x: 240, y: 0 } },
  // ~4x+ length vs track-001 (2600). This is ~10.6k.
  finishX: 10600,
  // Placeholder defaults; `App.tsx` will estimate and cache medals for this track on first load.
  medals: { bronzeMs: 0, silverMs: 0, goldMs: 0 },
  segments: buildCatmullRomSegments(
    [
      // Section 1: warmup into first descent
      { x: 0, y: 320 },
      { x: 500, y: 320 },
      { x: 900, y: 240 },
      { x: 1300, y: 300 },
      { x: 1700, y: 520 },
      { x: 1900, y: 520 },
      { x: 2200, y: 360 },
      { x: 2500, y: 420 },
      { x: 2850, y: 300 },
      { x: 3200, y: 360 },
      { x: 3500, y: 260 },

      // Section 2: long downhill “ski” with a clean launch
      { x: 3900, y: 340 },
      { x: 4300, y: 560 },
      { x: 4700, y: 610 },
      { x: 5100, y: 520 },
      { x: 5500, y: 360 },
      { x: 5900, y: 300 },

      // Section 3: rolling hills (reward pump timing)
      { x: 6350, y: 360 },
      { x: 6750, y: 300 },
      { x: 7150, y: 420 },
      { x: 7550, y: 280 },
      { x: 7950, y: 420 },
      { x: 8350, y: 300 },

      // Section 4: high-speed valley + climb (tests jet energy management)
      { x: 8750, y: 420 },
      { x: 9150, y: 640 },
      { x: 9550, y: 610 },
      { x: 9900, y: 420 },
      { x: 10250, y: 320 },
      { x: 10600, y: 280 },
    ],
    16,
  ),
  coins: [],
}

const mkTrack = (id: string, name: string, finishX: number, ctrl: Vec2[], startY: number, v0: number): TrackDef => ({
  id,
  name,
  start: { p: { x: 40, y: startY }, v: { x: v0, y: 0 } },
  finishX,
  medals: { bronzeMs: 0, silverMs: 0, goldMs: 0 },
  segments: buildCatmullRomSegments(ctrl, 16),
  // Coins are authored (track editor). Default: none.
  coins: [],
})

export const TRACK_003 = mkTrack(
  'track-003',
  'Skyhooks',
  8200,
  [
    { x: 0, y: 360 },
    { x: 520, y: 360 },
    { x: 980, y: 260 },
    { x: 1400, y: 520 },
    { x: 1800, y: 520 },
    { x: 2300, y: 260 },
    { x: 2900, y: 220 },
    { x: 3500, y: 420 },
    { x: 4200, y: 300 },
    { x: 4900, y: 520 },
    { x: 5600, y: 260 },
    { x: 6350, y: 340 },
    { x: 7100, y: 240 },
    { x: 8200, y: 300 },
  ],
  300,
  250,
)

export const TRACK_004 = mkTrack(
  'track-004',
  'The Deep',
  9200,
  [
    { x: 0, y: 280 },
    { x: 650, y: 300 },
    { x: 1200, y: 520 },
    { x: 1700, y: 700 },
    { x: 2200, y: 720 },
    { x: 2800, y: 640 },
    { x: 3400, y: 420 },
    { x: 4100, y: 340 },
    { x: 4800, y: 520 },
    { x: 5600, y: 740 },
    { x: 6500, y: 720 },
    { x: 7400, y: 420 },
    { x: 8200, y: 320 },
    { x: 9200, y: 300 },
  ],
  240,
  260,
)

export const TRACK_005 = mkTrack(
  'track-005',
  'Roller Garden',
  7600,
  [
    { x: 0, y: 360 },
    { x: 420, y: 320 },
    { x: 780, y: 420 },
    { x: 1120, y: 280 },
    { x: 1460, y: 440 },
    { x: 1820, y: 260 },
    { x: 2200, y: 440 },
    { x: 2580, y: 260 },
    { x: 2960, y: 440 },
    { x: 3340, y: 260 },
    { x: 3720, y: 440 },
    { x: 4100, y: 260 },
    { x: 4600, y: 360 },
    { x: 5200, y: 300 },
    { x: 5900, y: 380 },
    { x: 6600, y: 260 },
    { x: 7600, y: 300 },
  ],
  320,
  255,
)

export const TRACK_006 = mkTrack(
  'track-006',
  'Staircase',
  8400,
  [
    { x: 0, y: 600 },
    { x: 600, y: 600 },
    { x: 900, y: 520 },
    { x: 1400, y: 520 },
    { x: 1700, y: 440 },
    { x: 2200, y: 440 },
    { x: 2500, y: 360 },
    { x: 3000, y: 360 },
    { x: 3300, y: 300 },
    { x: 3900, y: 300 },
    { x: 4300, y: 340 },
    { x: 4800, y: 260 },
    { x: 5600, y: 320 },
    { x: 6400, y: 260 },
    { x: 7200, y: 320 },
    { x: 8400, y: 280 },
  ],
  520,
  270,
)

export const TRACK_007 = mkTrack(
  'track-007',
  'Cliffside',
  9800,
  [
    { x: 0, y: 380 },
    { x: 900, y: 340 },
    { x: 1500, y: 520 },
    { x: 2200, y: 620 },
    { x: 2900, y: 260 },
    { x: 3400, y: 260 },
    { x: 4200, y: 520 },
    { x: 5000, y: 620 },
    { x: 5600, y: 300 },
    { x: 6300, y: 340 },
    { x: 7000, y: 520 },
    { x: 7900, y: 660 },
    { x: 8600, y: 320 },
    { x: 9800, y: 300 },
  ],
  300,
  260,
)

export const TRACK_008 = mkTrack(
  'track-008',
  'Low Orbit',
  9000,
  [
    { x: 0, y: 560 },
    { x: 800, y: 520 },
    { x: 1500, y: 420 },
    { x: 2300, y: 260 },
    { x: 3200, y: 240 },
    { x: 4100, y: 260 },
    { x: 4800, y: 340 },
    { x: 5500, y: 260 },
    { x: 6200, y: 220 },
    { x: 7000, y: 260 },
    { x: 7900, y: 320 },
    { x: 9000, y: 280 },
  ],
  520,
  265,
)

export const TRACK_009 = mkTrack(
  'track-009',
  'Canyon Echo',
  10400,
  [
    { x: 0, y: 320 },
    { x: 700, y: 300 },
    { x: 1300, y: 420 },
    { x: 1900, y: 680 },
    { x: 2600, y: 720 },
    { x: 3400, y: 520 },
    { x: 4200, y: 320 },
    { x: 5000, y: 520 },
    { x: 5800, y: 720 },
    { x: 6600, y: 660 },
    { x: 7400, y: 420 },
    { x: 8200, y: 300 },
    { x: 9000, y: 440 },
    { x: 9800, y: 340 },
    { x: 10400, y: 300 },
  ],
  280,
  260,
)

export const TRACK_010 = mkTrack(
  'track-010',
  'Needlethread',
  7800,
  [
    { x: 0, y: 520 },
    { x: 700, y: 520 },
    { x: 1200, y: 360 },
    { x: 1600, y: 260 },
    { x: 2100, y: 300 },
    { x: 2700, y: 500 },
    { x: 3200, y: 520 },
    { x: 3800, y: 360 },
    { x: 4300, y: 240 },
    { x: 4900, y: 300 },
    { x: 5600, y: 520 },
    { x: 6400, y: 420 },
    { x: 7200, y: 280 },
    { x: 7800, y: 300 },
  ],
  460,
  260,
)

export const TRACK_011 = mkTrack(
  'track-011',
  'Afterburn Valley',
  11200,
  [
    { x: 0, y: 320 },
    { x: 900, y: 300 },
    { x: 1600, y: 520 },
    { x: 2400, y: 680 },
    { x: 3400, y: 740 },
    { x: 4400, y: 520 },
    { x: 5200, y: 280 },
    { x: 6100, y: 320 },
    { x: 7100, y: 560 },
    { x: 8100, y: 740 },
    { x: 9100, y: 520 },
    { x: 10000, y: 300 },
    { x: 11200, y: 280 },
  ],
  280,
  260,
)

export const TRACK_012 = mkTrack(
  'track-012',
  'Microgravity',
  8600,
  [
    { x: 0, y: 420 },
    { x: 700, y: 360 },
    { x: 1400, y: 300 },
    { x: 2200, y: 280 },
    { x: 3000, y: 300 },
    { x: 3800, y: 320 },
    { x: 4600, y: 280 },
    { x: 5400, y: 300 },
    { x: 6200, y: 320 },
    { x: 7000, y: 300 },
    { x: 7800, y: 280 },
    { x: 8600, y: 300 },
  ],
  360,
  265,
)

export const ALL_TRACKS: TrackDef[] = [
  TRACK_002,
  TRACK_003,
  TRACK_004,
  TRACK_005,
  TRACK_006,
  TRACK_007,
  TRACK_008,
  TRACK_009,
  TRACK_010,
  TRACK_011,
  TRACK_012,
  TRACK_001,
]

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


