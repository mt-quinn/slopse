import { clamp, lerp } from './math'
import type { RunState } from './state'

export const updateRunCamera = (s: RunState) => {
  const v = s.disc.v
  const speed = Math.hypot(v.x, v.y)
  const baseZoom = 1
  const zoomOut = clamp(speed / 2200, 0, 1) * 0.42
  const targetZoom = clamp(baseZoom - zoomOut, 0.55, 1)

  const lookahead = clamp(Math.max(0, v.x) * 0.24, 0, 360)
  const targetX = s.disc.p.x + 90 + lookahead
  const targetY = s.disc.p.y - 130

  // Follow up quickly (y decreasing), but follow down slowly so falling can kill you.
  const cam = s.camera
  const upRate = 0.16
  // While you're still above the track's lowest point, follow down quickly so big jumps don't
  // "bottom out" the view. Once you're below the track's lowest point, follow down slowly so
  // falling can kill you.
  const belowLowest = s.disc.p.y - s.disc.r > s.trackMaxY + 40
  const downRate = belowLowest ? 0.04 : 0.14
  const rateY = targetY < cam.y ? upRate : downRate
  cam.x = lerp(cam.x, targetX, 0.10)
  cam.y = lerp(cam.y, targetY, rateY)
  cam.zoom = lerp(cam.zoom, targetZoom, 0.10)
}

export const applyCameraDeath = (s: RunState) => {
  // Death by falling below camera bottom.
  // Guard against invalid/too-small view sizes that can happen transiently on some browsers.
  if (s.runStarted && s.view.height > 80 && s.view.width > 80 && !s.dead && !s.finished) {
    // Only allow "fall off bottom of view" death once you're below the track's lowest point.
    // This prevents large jumps / long airtime from killing you prematurely.
    if (s.disc.p.y - s.disc.r <= s.trackMaxY + 60) return
    const bottom = s.camera.y + s.view.height / (2 * Math.max(0.0001, s.camera.zoom))
    if (s.disc.p.y - s.disc.r > bottom + 12) {
      s.dead = true
      s.input.thrust = false
      s.input.thrustPointerId = null
      const timeMs = Math.max(1, Math.round(s.timeMs))
      s.result = {
        finished: false,
        timeMs,
        coinsCollected: s.coinsCollected.size,
        coinsTotal: s.track.coins.length,
        medal: 'none',
        author: false,
        newBestTime: false,
      }
    }
  }
}


