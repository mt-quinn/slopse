import type { RunState } from '../game/state'
import { clamp } from '../game/math'
import { sampleGhostAt } from '../game/sim'
import { JET_MAX_ENERGY } from '../game/tuning'
import { trackBounds } from '../game/track'

const withDpr = (ctx: CanvasRenderingContext2D, dpr: number, fn: () => void) => {
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  fn()
  ctx.restore()
}

// Player marble image (loaded from /public).
let ballImg: HTMLImageElement | null = null
let ballImgReady = false
const getBallImg = () => {
  if (ballImg) return ballImg
  const img = new Image()
  img.src = '/ball.webp'
  img.onload = () => {
    ballImgReady = true
  }
  img.onerror = () => {
    // keep ballImgReady false; we will fallback to simple circle rendering.
  }
  ballImg = img
  return img
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

    // Colored area underneath the track (extends to bottom of screen)
    {
      const segs = s.track.segments
      if (segs.length > 0) {
        ctx.save()
        ctx.fillStyle = '#00576F'
        ctx.beginPath()
        
        // Start from the first segment
        ctx.moveTo(segs[0]!.a.x, segs[0]!.a.y)
        
        // Follow the track path
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i]!
          const prev = i > 0 ? segs[i - 1]! : null
          const cont =
            prev != null &&
            Math.abs(prev.b.x - seg.a.x) < 1e-6 &&
            Math.abs(prev.b.y - seg.a.y) < 1e-6
          if (!cont) ctx.lineTo(seg.a.x, seg.a.y)
          ctx.lineTo(seg.b.x, seg.b.y)
        }
        
        // Extend to bottom of screen (in world coordinates)
        // Calculate bottom of viewport in world space
        const bottomWorldY = s.camera.y + (h / 2) / zoom
        const lastSeg = segs[segs.length - 1]!
        
        // Draw down to bottom, then back along bottom, then close
        ctx.lineTo(lastSeg.b.x, bottomWorldY)
        ctx.lineTo(segs[0]!.a.x, bottomWorldY)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }
    }

    const drawTrackByMat = (mat: 'normal' | 'boost', strokeStyle: string, lineWidth: number, dashed?: number[]) => {
      ctx.save()
      ctx.strokeStyle = strokeStyle
      ctx.lineWidth = lineWidth
      if (dashed) ctx.setLineDash(dashed)
      ctx.beginPath()
      const segs = s.track.segments
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]!
        if (seg.mat !== mat) continue
        const prev = i > 0 ? segs[i - 1]! : null
        const cont =
          prev != null &&
          prev.mat === seg.mat &&
          Math.abs(prev.b.x - seg.a.x) < 1e-6 &&
          Math.abs(prev.b.y - seg.a.y) < 1e-6
        if (!cont) ctx.moveTo(seg.a.x, seg.a.y)
        ctx.lineTo(seg.b.x, seg.b.y)
      }
      ctx.stroke()
      ctx.restore()
    }

    // Soft back glow line (material-coded)
    drawTrackByMat('normal', 'rgba(140, 100, 255, 0.18)', 16)
    drawTrackByMat('boost', 'rgba(120, 180, 255, 0.22)', 18)

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
    drawTrackByMat('normal', 'rgba(255, 246, 213, 0.75)', 5)
    // Boost rails: brighter + dashed “chevron-like” read.
    drawTrackByMat('boost', 'rgba(120, 180, 255, 0.92)', 6, [10, 8])

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

    // Player marble
    {
      const p = s.disc.p
      const r = s.disc.r
      const img = getBallImg()

      // subtle glow for readability
      const speed = Math.hypot(s.disc.v.x, s.disc.v.y)
      const heat = clamp(speed / 1800, 0, 1)
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = `rgba(255, 120, 210, ${0.06 + 0.12 * heat})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, r * (2.25 + heat * 0.25), 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      if (ballImgReady && img.naturalWidth > 0) {
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(s.disc.rot)
        ctx.imageSmoothingEnabled = true
        const d = r * 2.15
        ctx.drawImage(img, -d / 2, -d / 2, d, d)
        // outline for contrast
        ctx.strokeStyle = 'rgba(0,0,0,0.28)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(0, 0, r, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      } else {
        // Fallback: simple marble circle if image isn't ready yet.
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
      }
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

    // Minimap strip (top, full width): whole course line with player (red) and ghost (blue)
    {
      const padX = 14
      const y0 = 14
      const maxH = 110

      const b = trackBounds(s.track.segments)
      const bw = Math.max(1, b.maxX - b.minX)
      const bh = Math.max(1, b.maxY - b.minY)
      const availW = Math.max(1, w - padX * 2)
      const sFit = Math.min(availW / bw, maxH / bh)
      const usedH = bh * sFit

      // Center vertically within the strip height.
      const top = y0 + (maxH - usedH) * 0.5

      const mx = (wx: number) => padX + (wx - b.minX) * sFit
      const my = (wy: number) => top + (wy - b.minY) * sFit

      ctx.save()
      ctx.globalCompositeOperation = 'source-over'

      // Track polyline (clean, no container)
      ctx.strokeStyle = 'rgba(255, 246, 213, 0.30)'
      ctx.lineWidth = 1.75
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      const segs = s.track.segments
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]!
        const prev = i > 0 ? segs[i - 1]! : null
        const cont =
          prev != null &&
          Math.abs(prev.b.x - seg.a.x) < 1e-6 &&
          Math.abs(prev.b.y - seg.a.y) < 1e-6
        if (!cont) ctx.moveTo(mx(seg.a.x), my(seg.a.y))
        ctx.lineTo(mx(seg.b.x), my(seg.b.y))
      }
      ctx.stroke()

      // Ghost dot (blue)
      if (s.bestGhost && s.ghostPlayback.active) {
        const t = s.timeMs / 1000
        const gp = sampleGhostAt(s.bestGhost.samples, t)
        if (gp) {
          ctx.fillStyle = 'rgba(120, 180, 255, 0.95)'
          ctx.beginPath()
          ctx.arc(mx(gp.x), my(gp.y), 3.2, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Player dot (red)
      ctx.fillStyle = 'rgba(255, 70, 90, 0.95)'
      ctx.beginPath()
      ctx.arc(mx(s.disc.p.x), my(s.disc.p.y), 3.6, 0, Math.PI * 2)
      ctx.fill()

      ctx.restore()
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

    // Instruction hint:
    // - Shows before start
    // - Continues until 2s after start, then fades out
    // - No container; two lines
    // - Hidden during replay (recording.active is false in replay)
    if (!s.dead && !s.finished && s.recording.active) {
      const t = s.timeMs / 1000
      const showPre = !s.runStarted
      const showPost = s.runStarted && t >= 0 && t < 2.0
      if (showPre || showPost) {
        const fade = !s.runStarted ? 1 : t < 1.5 ? 1 : clamp((2.0 - t) / 0.5, 0, 1)
        const line1 = 'Tap to thrust'
        const line2 = 'Triple tap to reset'
        const x = w * 0.5
        const y = h * 0.30

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = fade
        ctx.font = "950 18px 'Oxanium', system-ui, sans-serif"
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = 'rgba(255,246,213,0.92)'
        ctx.shadowColor = 'rgba(0,0,0,0.55)'
        ctx.shadowBlur = 14
        ctx.shadowOffsetY = 2

        ctx.fillText(line1, x, y)
        ctx.fillText(line2, x, y + 22)
        ctx.restore()
      }
    }
  })
}


