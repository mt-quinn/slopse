import { clamp, dot, len, sub, type Vec2 } from './math'
import { EDITED_TRACK_SOURCES } from './tracks.edited'

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

// --- Authored track format (editor) ---
// The game sim/collision uses `segments` (sampled line segments), but the editor needs a higher-level
// representation with vertices + handles. We store cubic Bézier handles as vectors relative to the node.
export type TrackPathNode = {
  p: Vec2
  // Incoming handle vector from p (relative). If omitted, treated as {0,0}.
  in?: Vec2
  // Outgoing handle vector from p (relative). If omitted, treated as {0,0}.
  out?: Vec2
}

export type TrackPath = {
  id: string
  nodes: TrackPathNode[]
  closed?: boolean
}

export type TrackSource = Omit<TrackDef, 'segments'> & {
  paths: TrackPath[]
  // Sampling density for runtime segments.
  sampleStepPx?: number
}

export const getTrackById = (id: string) => ALL_TRACKS.find((t) => t.id === id) ?? null
export const getTrackSourceById = (id: string) => ALL_TRACK_SOURCES.find((t) => t.id === id) ?? null

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
    segs.push({ a, b })
  }
  return segs
}

const vadd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
const vsub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const vmul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k })

// Convert a polyline (or Catmull control points) into smooth nodes with symmetric in/out handles.
// This is used to seed editor-editable data for our existing tracks.
export const nodesFromCatmullCtrl = (ctrl: Vec2[]): TrackPathNode[] => {
  const n = ctrl.length
  if (n === 0) return []
  if (n === 1) return [{ p: { ...ctrl[0]! } }]
  const nodes: TrackPathNode[] = []
  for (let i = 0; i < n; i++) {
    const p = ctrl[i]!
    const pPrev = ctrl[i - 1] ?? ctrl[i]!
    const pNext = ctrl[i + 1] ?? ctrl[i]!
    // Catmull tangent (uniform) at p.
    const m = vmul(vsub(pNext, pPrev), 0.5)
    // Hermite->Bezier: c1 = p + m/3, c2 = p - m/3 (for adjacent segment endpoints).
    const h = vmul(m, 1 / 3)
    nodes.push({ p: { ...p }, in: vmul(h, -1), out: h })
  }
  // For endpoints, bias tangents to be less aggressive.
  const m0 = vsub(ctrl[1]!, ctrl[0]!)
  nodes[0] = { p: { ...ctrl[0]! }, in: { x: 0, y: 0 }, out: vmul(m0, 1 / 3) }
  const mn = vsub(ctrl[n - 1]!, ctrl[n - 2]!)
  nodes[n - 1] = { p: { ...ctrl[n - 1]! }, in: vmul(mn, -1 / 3), out: { x: 0, y: 0 } }
  return nodes
}

const evalCubic = (p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 => {
  const u = 1 - t
  const tt = t * t
  const uu = u * u
  const uuu = uu * u
  const ttt = tt * t
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  }
}

export const buildBezierSegmentsFromPaths = (paths: TrackPath[], stepPx: number): TrackSegment[] => {
  const segs: TrackSegment[] = []
  const step = Math.max(3, stepPx)
  for (const path of paths) {
    const nodes = path.nodes
    const closed = !!path.closed
    const count = nodes.length
    if (count < 2) continue
    const segCount = closed ? count : count - 1
    for (let i = 0; i < segCount; i++) {
      const a = nodes[i]!
      const b = nodes[(i + 1) % count]!
      const p0 = a.p
      const p3 = b.p
      const c1 = vadd(p0, a.out ?? { x: 0, y: 0 })
      const c2 = vadd(p3, b.in ?? { x: 0, y: 0 })

      // Estimate curve length with a coarse polyline for step count.
      const lEst =
        Math.hypot(c1.x - p0.x, c1.y - p0.y) +
        Math.hypot(c2.x - c1.x, c2.y - c1.y) +
        Math.hypot(p3.x - c2.x, p3.y - c2.y)
      const steps = Math.max(6, Math.ceil(lEst / step))
      let prev = { ...p0 }
      for (let k = 1; k <= steps; k++) {
        const t = k / steps
        const p = evalCubic(p0, c1, c2, p3, t)
        const dx = p.x - prev.x
        const dy = p.y - prev.y
        if (dx * dx + dy * dy > 1e-6) segs.push({ a: prev, b: p })
        prev = p
      }
    }
  }
  return segs
}

export const compileTrack = (src: TrackSource): TrackDef => {
  const stepPx = Math.max(6, src.sampleStepPx ?? 16)
  const segments = buildBezierSegmentsFromPaths(src.paths, stepPx)
  return {
    id: src.id,
    name: src.name,
    start: src.start,
    finishX: src.finishX,
    segments,
    coins: src.coins,
    medals: src.medals,
  }
}

export const TRACK_001: TrackSource = {
  id: 'track-001',
  name: 'Warmup Slope',
  start: { p: { x: 40, y: 260 }, v: { x: 220, y: 0 } },
  finishX: 2600,
  medals: { bronzeMs: 26000, silverMs: 19000, goldMs: 14500 },
  sampleStepPx: 18,
  paths: [
    {
      id: 'p1',
      nodes: nodesFromCatmullCtrl([
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
      ]),
    },
  ],
  coins: [],
}

export const TRACK_002: TrackSource = {
  id: 'track-002',
  name: 'Longline (10k)',
  start: { p: { x: 40, y: 260 }, v: { x: 240, y: 0 } },
  // ~4x+ length vs track-001 (2600). This is ~10.6k.
  finishX: 10600,
  // Placeholder defaults; `App.tsx` will estimate and cache medals for this track on first load.
  medals: { bronzeMs: 0, silverMs: 0, goldMs: 0 },
  sampleStepPx: 16,
  paths: [
    {
      id: 'p1',
      nodes: nodesFromCatmullCtrl([
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
      ]),
    },
  ],
  coins: [],
}

const mkTrack = (
  id: string,
  name: string,
  finishX: number,
  ctrl: Vec2[],
  startY: number,
  v0: number,
): TrackSource => ({
  id,
  name,
  start: { p: { x: 40, y: startY }, v: { x: v0, y: 0 } },
  finishX,
  medals: { bronzeMs: 0, silverMs: 0, goldMs: 0 },
  sampleStepPx: 16,
  paths: [{ id: 'p1', nodes: nodesFromCatmullCtrl(ctrl) }],
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

export const TRACK_013 = mkTrack(
  'track-013',
  'Cathedral Drop',
  10400,
  [
    // Big vertical variation: deep drops + tall climbs.
    { x: 0, y: 320 },
    { x: 420, y: 320 },
    { x: 900, y: 420 },
    { x: 1350, y: 780 },
    { x: 1750, y: 1180 },
    { x: 2200, y: 1280 }, // deep valley floor
    { x: 2700, y: 980 },
    { x: 3200, y: 520 },
    { x: 3650, y: 220 }, // high ridge
    { x: 4100, y: 260 },
    { x: 4700, y: 760 },
    { x: 5350, y: 1080 },
    { x: 6000, y: 740 },
    { x: 6600, y: 260 }, // second ridge
    { x: 7100, y: 180 },
    { x: 7700, y: 520 },
    { x: 8300, y: 1040 },
    { x: 8800, y: 1320 }, // second deep dip
    { x: 9300, y: 980 },
    { x: 9800, y: 520 },
    { x: 10400, y: 300 },
  ],
  260,
  245,
)

export const TRACK_014: TrackSource = {
  id: 'track-014',
  name: 'Sky Loop (Split)',
  start: { p: { x: 40, y: 640 }, v: { x: 260, y: 0 } },
  finishX: 9200,
  medals: { bronzeMs: 0, silverMs: 0, goldMs: 0 },
  coins: [],
  sampleStepPx: 14,
  paths: [
    // Approach + launch ramp (ends near the loop, but NOT connected)
    {
      id: 'p-approach',
      nodes: nodesFromCatmullCtrl([
        { x: 0, y: 640 },
        { x: 700, y: 640 },
        { x: 1200, y: 700 },
        { x: 1700, y: 920 }, // build speed in a dip
        { x: 2100, y: 760 },
        { x: 2400, y: 520 },
        { x: 2620, y: 450 }, // launch lip
      ]),
    },

    // Discontiguous loop above the ramp:
    // This is an *open* loop with a gap on the bottom (between ~45° and ~135°),
    // so you can enter/exit without any contiguous connection.
    {
      id: 'p-loop',
      nodes: nodesFromCatmullCtrl(
        (() => {
          const cx = 2900
          const cy = 260
          const r = 240
          const deg = (d: number) => (d * Math.PI) / 180
          const angles = [135, 165, 195, 225, 255, 270, 285, 315, 345, 15, 45]
          return angles.map((a) => ({
            x: cx + r * Math.cos(deg(a)),
            y: cy + r * Math.sin(deg(a)),
          }))
        })(),
      ),
    },

    // Exit ramp (starts near loop exit, but NOT connected)
    {
      id: 'p-exit',
      nodes: nodesFromCatmullCtrl([
        { x: 3160, y: 470 },
        { x: 3600, y: 610 },
        { x: 4200, y: 520 },
        { x: 4900, y: 720 },
        { x: 5600, y: 520 },
        { x: 6400, y: 660 },
        { x: 7400, y: 520 },
        { x: 8200, y: 600 },
        { x: 9200, y: 520 },
      ]),
    },
  ],
}

const BASE_TRACK_SOURCES: TrackSource[] = [
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
  TRACK_013,
  TRACK_014,
  TRACK_001,
]

const mergeEdited = (base: TrackSource[], edited: TrackSource[]) => {
  const byId = new Map<string, TrackSource>()
  for (const t of base) byId.set(t.id, t)
  for (const t of edited) byId.set(t.id, t)
  return Array.from(byId.values())
}

export const ALL_TRACK_SOURCES: TrackSource[] = mergeEdited(BASE_TRACK_SOURCES, EDITED_TRACK_SOURCES)
export const ALL_TRACKS: TrackDef[] = ALL_TRACK_SOURCES.map(compileTrack)

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


