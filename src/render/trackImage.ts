import type { TrackDef } from '../game/track'
import { trackBounds } from '../game/track'

export type TrackImageOpts = {
  width: number
  height: number
  padPx?: number
  bg?: string
}

export const renderTrackImage = (canvas: HTMLCanvasElement, track: TrackDef, opts: TrackImageOpts) => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const w = Math.max(1, Math.floor(opts.width))
  const h = Math.max(1, Math.floor(opts.height))
  canvas.width = w
  canvas.height = h

  const pad = Math.max(0, Math.floor(opts.padPx ?? 24))
  const bg = opts.bg ?? '#0B0A16'

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  const segs = track.segments
  if (segs.length === 0) return

  const b = trackBounds(segs)
  const bw = Math.max(1, b.maxX - b.minX)
  const bh = Math.max(1, b.maxY - b.minY)
  const sFit = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)
  const ox = pad - b.minX * sFit
  const oy = pad - b.minY * sFit

  const tx = (x: number) => x * sFit + ox
  const ty = (y: number) => y * sFit + oy

  const drawByMat = (mat: 'normal' | 'boost', strokeStyle: string, lineWidth: number, dashed?: number[]) => {
    ctx.save()
    ctx.strokeStyle = strokeStyle
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (dashed) ctx.setLineDash(dashed)
    ctx.beginPath()
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!
      if (s.mat !== mat) continue
      const prev = i > 0 ? segs[i - 1]! : null
      const cont =
        prev != null &&
        prev.mat === s.mat &&
        Math.abs(prev.b.x - s.a.x) < 1e-6 &&
        Math.abs(prev.b.y - s.a.y) < 1e-6
      if (!cont) ctx.moveTo(tx(s.a.x), ty(s.a.y))
      ctx.lineTo(tx(s.b.x), ty(s.b.y))
    }
    ctx.stroke()
    ctx.restore()
  }

  // Subtle glow
  drawByMat('normal', 'rgba(140, 100, 255, 0.20)', Math.max(1.5, sFit * 6))
  drawByMat('boost', 'rgba(120, 180, 255, 0.24)', Math.max(2, sFit * 7))

  // Main rails
  drawByMat('normal', 'rgba(255, 246, 213, 0.86)', Math.max(1.25, sFit * 2.2))
  drawByMat('boost', 'rgba(120, 180, 255, 0.98)', Math.max(1.25, sFit * 2.4), [10, 8])

  // Finish line
  ctx.save()
  ctx.strokeStyle = 'rgba(255, 120, 210, 0.70)'
  ctx.lineWidth = Math.max(1, sFit * 1.5)
  ctx.setLineDash([10, 10])
  const fx = tx(track.finishX)
  ctx.beginPath()
  ctx.moveTo(fx, 0)
  ctx.lineTo(fx, h)
  ctx.stroke()
  ctx.restore()

  // Minimal label
  ctx.save()
  ctx.font = "800 16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
  ctx.fillStyle = 'rgba(255,246,213,0.90)'
  ctx.fillText(track.name, 16, 28)
  ctx.fillStyle = 'rgba(170, 215, 255, 0.80)'
  const plane = track.planeDeg != null ? `plane ${Math.round(track.planeDeg)}°` : 'plane ?'
  ctx.fillText(`${segs.length} segs • ${plane}`, 16, 48)
  ctx.restore()
}


