import type { RunState } from '../game/state'
import { clamp } from '../game/math'
import { sampleGhostAt } from '../game/sim'

const withDpr = (ctx: CanvasRenderingContext2D, dpr: number, fn: () => void) => {
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  fn()
  ctx.restore()
}

export const drawFrame = (canvas: HTMLCanvasElement, s: RunState) => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = s.view.dpr
  withDpr(ctx, dpr, () => {
    const w = s.view.width
    const h = s.view.height
    ctx.clearRect(0, 0, w, h)

    // Camera transform: world -> screen.
    const zoom = s.camera.zoom
    ctx.save()
    ctx.translate(w / 2, h / 2)
    ctx.scale(zoom, zoom)
    ctx.translate(-s.camera.x, -s.camera.y)

    // Track
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Soft back glow line
    ctx.strokeStyle = 'rgba(140, 100, 255, 0.18)'
    ctx.lineWidth = 16
    ctx.beginPath()
    for (let i = 0; i < s.track.segments.length; i++) {
      const seg = s.track.segments[i]!
      if (i === 0) ctx.moveTo(seg.a.x, seg.a.y)
      ctx.lineTo(seg.b.x, seg.b.y)
    }
    ctx.stroke()

    // Main rail
    ctx.strokeStyle = 'rgba(255, 246, 213, 0.75)'
    ctx.lineWidth = 5
    ctx.beginPath()
    for (let i = 0; i < s.track.segments.length; i++) {
      const seg = s.track.segments[i]!
      if (i === 0) ctx.moveTo(seg.a.x, seg.a.y)
      ctx.lineTo(seg.b.x, seg.b.y)
    }
    ctx.stroke()

    // Coins
    for (const c of s.track.coins) {
      const got = s.coinsCollected.has(c.id)
      const a = got ? 0.12 : 1
      ctx.save()
      ctx.globalAlpha = a
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = 'rgba(255, 220, 120, 0.14)'
      ctx.beginPath()
      ctx.arc(c.p.x, c.p.y, c.r * 2.1, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'rgba(255, 220, 120, 0.95)'
      ctx.beginPath()
      ctx.arc(c.p.x, c.p.y, c.r, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.restore()
    }

    // Finish line
    ctx.save()
    ctx.strokeStyle = 'rgba(255, 120, 210, 0.55)'
    ctx.lineWidth = 3
    ctx.setLineDash([10, 10])
    ctx.beginPath()
    ctx.moveTo(s.track.finishX, -2000)
    ctx.lineTo(s.track.finishX, 2000)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()

    // Ghost (best run)
    if (s.bestGhost && s.ghostPlayback.active) {
      const t = s.timeMs / 1000
      const p = sampleGhostAt(s.bestGhost.samples, t)
      if (p) {
        const r = s.disc.r
        ctx.save()
        ctx.globalAlpha = 0.42
        ctx.strokeStyle = 'rgba(140, 190, 255, 0.95)'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }
    }

    // Player disc
    {
      const p = s.disc.p
      const r = s.disc.r
      const speed = Math.hypot(s.disc.v.x, s.disc.v.y)
      const heat = clamp(speed / 1800, 0, 1)

      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = `rgba(255, 120, 210, ${0.10 + 0.18 * heat})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, r * (2.3 + heat * 0.35), 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      ctx.save()
      const grad = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, 2, p.x, p.y, r * 1.35)
      grad.addColorStop(0, 'rgba(255,255,255,0.92)')
      grad.addColorStop(0.55, 'rgba(255,245,200,0.92)')
      grad.addColorStop(1, 'rgba(180,150,255,0.70)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.38)'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.restore()

      // Upright “player” on top of disc (purely visual, no physics).
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      const bodyY = p.y - r - 10
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'
      ctx.lineWidth = 6
      ctx.lineCap = 'round'
      // outline
      ctx.beginPath()
      ctx.moveTo(p.x, bodyY + 10)
      ctx.lineTo(p.x, bodyY + 34)
      ctx.stroke()
      // fill
      ctx.strokeStyle = 'rgba(255,246,213,0.95)'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(p.x, bodyY + 10)
      ctx.lineTo(p.x, bodyY + 34)
      ctx.stroke()
      // head
      ctx.fillStyle = 'rgba(255,246,213,0.95)'
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(p.x, bodyY, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      // Jet flame if thrusting
      if (s.input.thrust && s.jet.energy > 0 && !s.dead && !s.finished) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.fillStyle = 'rgba(120, 180, 255, 0.25)'
        ctx.beginPath()
        ctx.ellipse(p.x, bodyY + 46, 10, 18, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = 'rgba(120, 180, 255, 0.65)'
        ctx.beginPath()
        ctx.ellipse(p.x, bodyY + 44, 5, 10, 0, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    ctx.restore() // camera
  })
}


