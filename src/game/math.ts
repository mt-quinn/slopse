export type Vec2 = { x: number; y: number }

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
export const mul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s })
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y
export const len = (v: Vec2) => Math.hypot(v.x, v.y)
export const normalize = (v: Vec2): Vec2 => {
  const l = Math.hypot(v.x, v.y)
  if (l <= 1e-9) return { x: 0, y: -1 }
  return { x: v.x / l, y: v.y / l }
}

export const perp = (v: Vec2): Vec2 => ({ x: -v.y, y: v.x })

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) })


