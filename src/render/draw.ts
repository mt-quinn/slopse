import type { RunState } from '../game/state'
import { clamp } from '../game/math'
import { sampleGhostAt } from '../game/sim'
import { JET_MAX_ENERGY } from '../game/tuning'

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
      // Avoid visually connecting discontiguous segments (e.g. multiple paths in the editor).
      const prev = i > 0 ? s.track.segments[i - 1]!.b : null
      const cont =
        prev != null &&
        Math.abs(prev.x - seg.a.x) < 1e-6 &&
        Math.abs(prev.y - seg.a.y) < 1e-6
      if (!cont) ctx.moveTo(seg.a.x, seg.a.y)
      ctx.lineTo(seg.b.x, seg.b.y)
    }
    ctx.stroke()

    // Start platform (pre-run)
    if (!s.runStarted && s.startPlatform.active) {
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = 'rgba(255, 246, 213, 0.85)'
      ctx.lineWidth = 6
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(s.startPlatform.x0, s.startPlatform.y)
      ctx.lineTo(s.startPlatform.x1, s.startPlatform.y)
      ctx.stroke()
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(s.startPlatform.x0, s.startPlatform.y + 4)
      ctx.lineTo(s.startPlatform.x1, s.startPlatform.y + 4)
      ctx.stroke()
      ctx.restore()
    }

    // Main rail
    ctx.strokeStyle = 'rgba(255, 246, 213, 0.75)'
    ctx.lineWidth = 5
    ctx.beginPath()
    for (let i = 0; i < s.track.segments.length; i++) {
      const seg = s.track.segments[i]!
      const prev = i > 0 ? s.track.segments[i - 1]!.b : null
      const cont =
        prev != null &&
        Math.abs(prev.x - seg.a.x) < 1e-6 &&
        Math.abs(prev.y - seg.a.y) < 1e-6
      if (!cont) ctx.moveTo(seg.a.x, seg.a.y)
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
        
        // Ghost jetpack flame indicator
        if (p.thrusting) {
          const bodyY = p.y - r - 10
          ctx.globalCompositeOperation = 'lighter'
          ctx.globalAlpha = 0.30
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

    // Player-attached HUD elements
    {
      const p = s.disc.p
      const sx = (p.x - s.camera.x) * zoom + w / 2
      const sy = (p.y - s.camera.y) * zoom + h / 2

      // Jet meter (only when not full): to the left of the player
      if (JET_MAX_ENERGY > 0 && s.jet.energy < JET_MAX_ENERGY - 1e-4) {
        const frac = clamp(s.jet.energy / JET_MAX_ENERGY, 0, 1)
        const barH = 46
        const barW = 10
        const bx = sx - 42
        const by = sy - barH / 2
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        // background
        ctx.fillStyle = 'rgba(10, 8, 22, 0.62)'
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'
        ctx.lineWidth = 2
        ctx.beginPath()
        const r = 6
        ctx.moveTo(bx + r, by)
        ctx.arcTo(bx + barW, by, bx + barW, by + barH, r)
        ctx.arcTo(bx + barW, by + barH, bx, by + barH, r)
        ctx.arcTo(bx, by + barH, bx, by, r)
        ctx.arcTo(bx, by, bx + barW, by, r)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()

        // fill
        const fillH = Math.max(0, (barH - 4) * frac)
        const fx = bx + 2
        const fy = by + (barH - 2) - fillH
        ctx.fillStyle = 'rgba(120, 180, 255, 0.85)'
        ctx.beginPath()
        const fr = 4
        ctx.moveTo(fx + fr, fy)
        ctx.arcTo(fx + (barW - 4), fy, fx + (barW - 4), fy + fillH, fr)
        ctx.arcTo(fx + (barW - 4), fy + fillH, fx, fy + fillH, fr)
        ctx.arcTo(fx, fy + fillH, fx, fy, fr)
        ctx.arcTo(fx, fy, fx + (barW - 4), fy, fr)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }
    }

    // Ghost time delta tag (screen-space, attached to ghost)
    if (s.bestGhost && s.ghostPlayback.active && s.runStarted && !s.dead && !s.finished) {
      const tNow = s.timeMs / 1000
      const pGhost = sampleGhostAt(s.bestGhost.samples, tNow)
      if (pGhost) {
        // Find the ghost time that best matches the player's *position* (works even for loops/backtracking).
        const px = s.disc.p.x
        const py = s.disc.p.y
        let bestI = 0
        let bestD2 = Infinity
        const samples = s.bestGhost.samples
        for (let i = 0; i < samples.length; i++) {
          const a = samples[i]!
          const dx = a.x - px
          const dy = a.y - py
          const d2 = dx * dx + dy * dy
          if (d2 < bestD2) {
            bestD2 = d2
            bestI = i
          }
        }
        const tGhostAtPlayer = samples[bestI]?.t ?? tNow
        const delta = tNow - tGhostAtPlayer // + means player is behind (slower)
        const sign = delta >= 0 ? '+' : '-'
        const text = `${sign}${Math.abs(delta).toFixed(2)}s`

        const gx = (pGhost.x - s.camera.x) * zoom + w / 2
        const gy = (pGhost.y - s.camera.y) * zoom + h / 2

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.font = "900 12px 'Oxanium', system-ui, sans-serif"
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const tw = ctx.measureText(text).width
        const padX = 10
        const bw = tw + padX * 2
        const bh = 22
        const bx = gx - bw / 2
        const by = gy - 40 - bh / 2
        ctx.fillStyle = 'rgba(10, 8, 22, 0.62)'
        ctx.strokeStyle = 'rgba(140, 190, 255, 0.25)'
        ctx.lineWidth = 2
        ctx.beginPath()
        const r = 12
        ctx.moveTo(bx + r, by)
        ctx.arcTo(bx + bw, by, bx + bw, by + bh, r)
        ctx.arcTo(bx + bw, by + bh, bx, by + bh, r)
        ctx.arcTo(bx, by + bh, bx, by, r)
        ctx.arcTo(bx, by, bx + bw, by, r)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = 'rgba(170, 215, 255, 0.95)'
        ctx.fillText(text, gx, by + bh / 2 + 0.5)
        ctx.restore()
      }
    }

    // Screen-space prompt
    if (!s.runStarted && !s.dead && !s.finished) {
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "900 14px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const label = 'Tap / Space to start'
      const x = w * 0.5
      const y = h * 0.70
      const tw = ctx.measureText(label).width
      const padX = 14
      const boxW = tw + padX * 2
      const boxH = 30
      const bx = x - boxW / 2
      const by = y - boxH / 2
      ctx.fillStyle = 'rgba(10, 8, 22, 0.62)'
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 2
      ctx.beginPath()
      const r = 14
      ctx.moveTo(bx + r, by)
      ctx.arcTo(bx + boxW, by, bx + boxW, by + boxH, r)
      ctx.arcTo(bx + boxW, by + boxH, bx, by + boxH, r)
      ctx.arcTo(bx, by + boxH, bx, by, r)
      ctx.arcTo(bx, by, bx + boxW, by, r)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,246,213,0.95)'
      ctx.fillText(label, x, y)
      ctx.restore()
    }
  })
}


