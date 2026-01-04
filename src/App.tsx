import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './app.css'
import { localDateKey, makeDailyTrack } from './game/track'
import { createInitialRunState, type GhostRun, type RunResult, type RunState } from './game/state'
import { loadBestGhost, loadBestTimeMs, saveBestGhost, saveBestTimeMs } from './game/persist'
import { clamp, lerp } from './game/math'
import { stepSim } from './game/sim'
import { sampleGhostAt } from './game/sim'
import { drawFrame } from './render/draw'
import {
  fetchDailyAround,
  fetchDailyRunById,
  fetchDailyTop5,
  loadLastLbName,
  loadSubmittedRunId,
  saveLastLbName,
  saveSubmittedRunId,
  submitDailyRun,
  type RankedRun,
} from './game/leaderboard'
import { applyCameraDeath, updateRunCamera } from './game/camera'
import { startRun } from './game/runControl'
import {
  startBackgroundMusic,
  pauseBackgroundMusic,
  resumeBackgroundMusic,
  setBackgroundMusicVolume,
  getBackgroundMusicVolume,
  tryResumeBackgroundMusicAfterGesture,
  setSfxVolume,
  getSfxVolume,
  playJetpackSfx,
  stopJetpackSfx,
  playRollingballSfx,
  stopRollingballSfx,
  pauseAllSfx,
} from './game/audio'

const fmtMs = (ms: number) => {
  const t = Math.max(0, Math.round(ms))
  const m = Math.floor(t / 60000)
  const s = Math.floor((t % 60000) / 1000)
  const cs = Math.floor((t % 1000) / 10)
  const mm = String(m).padStart(1, '0')
  const ss = String(s).padStart(2, '0')
  const cc = String(cs).padStart(2, '0')
  return `${mm}:${ss}.${cc}`
}

const medalLabel = (r: RunResult | null) => {
  if (!r) return null
  if (r.author) return 'GOLD + ALL COINS'
  if (r.medal === 'gold') return 'GOLD'
  if (r.medal === 'silver') return 'SILVER'
  if (r.medal === 'bronze') return 'BRONZE'
  return 'FINISH'
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const hudBucketRef = useRef<number>(-1)

  const dateKey = useMemo(() => localDateKey(), [])
  const track = useMemo(() => makeDailyTrack(dateKey), [dateKey])
  const [paused, setPaused] = useState(false)
  const [musicVolume, setMusicVolume] = useState(() => getBackgroundMusicVolume())
  const [sfxVolume, setSfxVolumeState] = useState(() => getSfxVolume())

  const stateRef = useRef<RunState | null>(null)

  const [lbTop5, setLbTop5] = useState<RankedRun[] | null>(null)
  const [lbAround, setLbAround] = useState<RankedRun[] | null>(null)
  const [lbErr, setLbErr] = useState<string | null>(null)
  const [lbLoading, setLbLoading] = useState(false)
  const [lbName, setLbName] = useState(() => (typeof window !== 'undefined' ? loadLastLbName() : ''))
  const [lbSubmittedId, setLbSubmittedId] = useState<string | null>(() =>
    typeof window !== 'undefined' ? loadSubmittedRunId(dateKey) : null,
  )
  const [lbSubmitting, setLbSubmitting] = useState(false)
  const [lbSubmitErr, setLbSubmitErr] = useState<string | null>(null)

  // Prevent re-submitting the same finished run repeatedly.
  const runTokenRef = useRef<string>('init')
  const [submittedRunToken, setSubmittedRunToken] = useState<string | null>(null)
  const newRunToken = useCallback(() => {
    try {
      const a = new Uint32Array(3)
      crypto.getRandomValues(a)
      return `${a[0]!.toString(16)}${a[1]!.toString(16)}${a[2]!.toString(16)}`
    } catch {
      return `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
    }
  }, [])

  const lsKeyGhostPick = useMemo(() => `slopes-lb-ghost-pick-${dateKey}`, [dateKey])
  const [ghostPickId, setGhostPickId] = useState<string | null>(() => {
    try {
      return typeof window !== 'undefined' ? window.localStorage.getItem(`slopes-lb-ghost-pick-${dateKey}`) : null
    } catch {
      return null
    }
  })
  const [ghostPick, setGhostPick] = useState<{ id: string; replay: GhostRun } | null>(null)
  const tempGhostRef = useRef<GhostRun | null>(null)
  const [replayRun, setReplayRun] = useState<RankedRun | null>(null)
  const [replayEnded, setReplayEnded] = useState(false)
  const replayRef = useRef<{
    samples: GhostRun['samples']
    durationSec: number
    t: number
    lastX: number
    lastY: number
  } | null>(null)

  type HudState = {
    timeMs: number
    energy: number
    coins: number
    coinsTotal: number
    bestTimeMs: number | null
    dead: boolean
    finished: boolean
    medal: string | null
  }

  const [hud, setHud] = useState<HudState>(() => ({
    timeMs: 0,
    energy: 1,
    coins: 0,
    coinsTotal: track.coins.length,
    bestTimeMs: typeof window !== 'undefined' ? loadBestTimeMs(track.id) : null,
    dead: false,
    finished: false,
    medal: null as string | null,
  }))
  const handledFinishRef = useRef(false)

  // When entering replay mode from the finished overlay, keep a copy so Exit restores it.
  const preReplayRef = useRef<{ state: RunState | null; hud: HudState; paused: boolean } | null>(null)

  const isGhostCompatible = useCallback(
    (g: GhostRun | null) => {
      if (!g) return false
      if (g.trackId !== track.id) return false
      if (!g.trackHash) return false
      return g.trackHash === track.trackHash
    },
    [track.id, track.trackHash],
  )

  const resolvePickedGhost = useCallback(
    async (id: string) => {
      // First try any currently loaded leaderboard rows.
      const fromLists = [...(lbTop5 ?? []), ...(lbAround ?? [])].find((r) => r.id === id)
      if (fromLists) return { id, replay: fromLists.replay }

      // Otherwise fetch directly.
      const row = await fetchDailyRunById(id)
      if (row?.replay) return { id, replay: row.replay }
      return null
    },
    [lbAround, lbTop5],
  )

  // Persist + resolve the selected ghost id.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (!ghostPickId) window.localStorage.removeItem(lsKeyGhostPick)
      else window.localStorage.setItem(lsKeyGhostPick, ghostPickId)
    } catch {
      // best-effort
    }
  }, [ghostPickId, lsKeyGhostPick])

  useEffect(() => {
    let alive = true
    ;(async () => {
      if (!ghostPickId) {
        setGhostPick(null)
        return
      }
      try {
        const g = await resolvePickedGhost(ghostPickId)
        if (!alive) return
        if (g && isGhostCompatible(g.replay)) setGhostPick(g)
        else setGhostPick(null)
      } catch {
        if (!alive) return
        setGhostPick(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [ghostPickId, isGhostCompatible, resolvePickedGhost])

  const consumeTempGhost = () => {
    const g = tempGhostRef.current
    tempGhostRef.current = null
    return g
  }

  const defaultGhost = useCallback(() => {
    if (ghostPick?.replay && isGhostCompatible(ghostPick.replay)) return ghostPick.replay
    const local = typeof window !== 'undefined' ? loadBestGhost(track.id, track.trackHash) : null
    return isGhostCompatible(local) ? local : null
  }, [ghostPick?.replay, isGhostCompatible, track.id, track.trackHash])

  const startReplay = useCallback(
    (r: RankedRun) => {
      if (!isGhostCompatible(r.replay)) {
        setLbErr('Replay is for a different track version/geometry.')
        return
      }
      // Snapshot current state so Exit replay returns to where the replay was invoked.
      preReplayRef.current = { state: stateRef.current, hud, paused }

      // Start a dedicated replay mode that animates the "player" along the run samples.
      setReplayRun(r)
      setReplayEnded(false)
      replayRef.current = {
        samples: r.replay.samples,
        durationSec: Math.max(0.001, r.replay.timeMs / 1000),
        t: 0,
        lastX: r.replay.samples[0]?.x ?? track.start.p.x,
        lastY: r.replay.samples[0]?.y ?? track.start.p.y,
      }

      const prev = stateRef.current
      const s = createInitialRunState(track)
      // CRITICAL: preserve current viewport sizing so we draw/clear the whole canvas.
      if (prev) s.view = { ...prev.view }
      s.runStarted = true
      s.startPlatform.active = false
      s.input.thrust = false
      s.input.thrustPointerId = null
      s.recording.active = false
      s.bestGhost = null
      s.ghostPlayback.active = false
      s.timeMs = 0

      const p0 = r.replay.samples[0]
      if (p0) {
        s.disc.p.x = p0.x
        s.disc.p.y = p0.y
      }
      s.disc.v = { x: 0, y: 0 }
          s.disc.rot = 0

      stateRef.current = s
      setHud({
        timeMs: 0,
        energy: 1,
        coins: 0,
        coinsTotal: 0,
        bestTimeMs: s.bestTimeMs,
        dead: false,
        finished: false,
        medal: null,
      })
      handledFinishRef.current = false
      setPaused(false)
    },
    [hud, isGhostCompatible, paused, track],
  )

  const initRun = useCallback(() => {
    runTokenRef.current = newRunToken()
    setSubmittedRunToken(null)
    const prev = stateRef.current
    const s = createInitialRunState(track)
    // Preserve current viewport sizing to avoid partial-canvas renders after any reset.
    if (prev) s.view = { ...prev.view }
    s.bestTimeMs = typeof window !== 'undefined' ? loadBestTimeMs(track.id) : null
    const temp = consumeTempGhost()
    s.bestGhost = temp ?? defaultGhost()
    s.ghostPlayback.active = s.bestGhost != null
    stateRef.current = s
    setHud({
      timeMs: 0,
      energy: 1,
      coins: 0,
      coinsTotal: track.coins.length,
      bestTimeMs: s.bestTimeMs,
      dead: false,
      finished: false,
      medal: null,
    })
    handledFinishRef.current = false
    setPaused(false)
  }, [defaultGhost, newRunToken, track])

  const exitReplay = useCallback(() => {
    setReplayRun(null)
    setReplayEnded(false)
    replayRef.current = null
    const snap = preReplayRef.current
    preReplayRef.current = null
    if (snap?.state) stateRef.current = snap.state
    setHud(snap?.hud ?? hud)
    setPaused(snap?.paused ?? false)
  }, [hud])

  const startRunIfNeeded = useCallback(() => {
    const s = stateRef.current
    if (!s) return
    const started = startRun(s)
    if (!started) return
    handledFinishRef.current = false

    // Start background music when player takes control
    startBackgroundMusic()

    setHud((h) => ({
      ...h,
      timeMs: 0,
      energy: 1,
      coins: 0,
      coinsTotal: s.track.coins.length,
      dead: false,
      finished: false,
      medal: null,
    }))
  }, [])

  // Initialize and re-initialize when track changes. Doing this in an effect avoids
  // calling setState during render (which can crash in StrictMode/dev).
  const initRunRef = useRef<null | (() => void)>(null)
  useEffect(() => {
    initRunRef.current = initRun
  }, [initRun])
  useEffect(() => {
    initRunRef.current?.()
  }, [track.id, track.trackHash])

  const restart = useCallback(() => {
    const prev = stateRef.current
    if (!prev) return
    // If we're watching a replay, "Restart" should restart the replay instead of starting a new run.
    if (replayRun && replayRef.current) {
      startReplay(replayRun)
      return
    }
    runTokenRef.current = newRunToken()
    setSubmittedRunToken(null)
    const next = createInitialRunState(track)
    next.view = prev.view
    next.bestTimeMs = prev.bestTimeMs
    // Re-apply ghost selection on each restart (temp view replay applies for only one run).
    const temp = consumeTempGhost()
    next.bestGhost = temp ?? defaultGhost()
    next.ghostPlayback.active = next.bestGhost != null
    Object.assign(prev, next)
    setHud((h) => ({
      ...h,
      timeMs: 0,
      energy: 1,
      coins: 0,
      coinsTotal: prev.track.coins.length,
      dead: false,
      finished: false,
      medal: null,
    }))
    handledFinishRef.current = false
    setPaused(false)
  }, [defaultGhost, newRunToken, replayRun, startReplay, track])

  // Triple-tap restart (works while actively running; does nothing on overlays/replay).
  const tapTimesRef = useRef<number[]>([])

  // Pointer input: press anywhere to thrust; release to stop.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // Try to resume BGM after user gesture (for mobile browsers)
      tryResumeBackgroundMusicAfterGesture()

      // Allow normal UI interactions (name entry, buttons, etc).
      const t = e.target as any
      const el: HTMLElement | null = t && typeof t === 'object' && 'closest' in t ? (t as HTMLElement) : null
      if (el && el.closest('input,textarea,select,button,a,[role="button"],[contenteditable="true"]')) return

      const s = stateRef.current
      if (!s) return
      if (replayRef.current) return
      if (paused) return
      if (s.dead || s.finished) return
      if (s.input.thrustPointerId != null) return

      // Detect triple tap: three pointer downs within a short window.
      {
        const now = performance.now()
        const arr = tapTimesRef.current
        arr.push(now)
        // keep only recent taps
        while (arr.length && now - arr[0]! > 650) arr.shift()
        if (arr.length >= 3) {
          tapTimesRef.current = []
          e.preventDefault()
          restart()
          return
        }
      }

      // Only prevent defaults (text selection, scroll gestures) when we actually take over the pointer for thrust.
      e.preventDefault()
      startRunIfNeeded()
      s.input.thrustPointerId = e.pointerId
      s.input.thrust = true
    }
    const onUp = (e: PointerEvent) => {
      const s = stateRef.current
      if (!s) return
      if (s.input.thrustPointerId === e.pointerId) {
        s.input.thrustPointerId = null
        s.input.thrust = false
      }
    }
    window.addEventListener('pointerdown', onDown, { passive: false })
    window.addEventListener('pointerup', onUp, { passive: true })
    window.addEventListener('pointercancel', onUp, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onDown as any)
      window.removeEventListener('pointerup', onUp as any)
      window.removeEventListener('pointercancel', onUp as any)
    }
  }, [paused, startRunIfNeeded])

  // Keyboard fallback.
  useEffect(() => {
    const spaceTimes: number[] = []
    const onKey = (e: KeyboardEvent, isDown: boolean) => {
      if (e.key !== ' ' && e.code !== 'Space') return
      const s = stateRef.current
      if (!s) return
      if (replayRef.current) return
      if (paused) return
      if (s.dead || s.finished) return
      if (isDown) {
        // Triple-space restart: three Space keydowns within a short window.
        const now = performance.now()
        spaceTimes.push(now)
        while (spaceTimes.length && now - spaceTimes[0]! > 650) spaceTimes.shift()
        if (spaceTimes.length >= 3) {
          spaceTimes.length = 0
          e.preventDefault()
          s.input.thrust = false
          s.input.thrustPointerId = null
          restart()
          return
        }
        startRunIfNeeded()
      }
      s.input.thrust = isDown
      e.preventDefault()
    }
    const down = (e: KeyboardEvent) => onKey(e, true)
    const up = (e: KeyboardEvent) => onKey(e, false)
    window.addEventListener('keydown', down, { passive: false })
    window.addEventListener('keyup', up, { passive: false })
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [paused, restart, startRunIfNeeded])

  // Pause toggle (Escape)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setPaused((p) => !p)
      const s = stateRef.current
      if (s) {
        s.input.thrust = false
        s.input.thrustPointerId = null
      }
    }
    window.addEventListener('keydown', onKey, { passive: false })
    return () => window.removeEventListener('keydown', onKey as any)
  }, [])

  // Pause music when tab loses focus, resume when it regains focus
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        pauseBackgroundMusic()
        pauseAllSfx()
      } else {
        // Try to resume - mobile browsers may block this
        resumeBackgroundMusic()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  // Main loop (sim + draw).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let last = performance.now()
    let resizeTries = 0

    const resize = () => {
      const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1))
      const parent = canvas.parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      // On some mobile browsers during address-bar transitions / first layout,
      // getBoundingClientRect() can temporarily report ~0 height, which breaks camera/death math.
      if ((rect.width < 40 || rect.height < 40) && resizeTries < 20) {
        resizeTries++
        requestAnimationFrame(resize)
        return
      }
      resizeTries = 0
      const w = Math.max(1, rect.width)
      const h = Math.max(1, rect.height)
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      const s = stateRef.current
      if (!s) return
      s.view.dpr = dpr
      s.view.width = w
      s.view.height = h
    }

    resize()
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)

    const tick = (now: number) => {
      const s = stateRef.current
      if (!s) return
      const dtSec = Math.min(0.05, (now - last) / 1000)
      last = now

      if (!paused) {
        const r = replayRef.current
        if (r) {
          // Replay playback: advance time and place the player at the recorded positions.
          if (!replayEnded) {
            r.t = Math.min(r.durationSec, r.t + dtSec)
            if (r.t + 1e-6 >= r.durationSec) setReplayEnded(true)
          }
          const tNow = r.t
          s.timeMs = tNow * 1000
          s.input.thrust = false
          s.input.thrustPointerId = null
          const p = sampleGhostAt(r.samples as any, tNow)
          if (p) {
            // Approximate velocity for HUD/camera smoothing.
            const p2 = sampleGhostAt(r.samples as any, Math.min(r.durationSec, tNow + 1 / 60))
            if (p2) {
              s.disc.v.x = (p2.x - p.x) * 60
              s.disc.v.y = (p2.y - p.y) * 60
            } else {
              s.disc.v.x = 0
              s.disc.v.y = 0
            }

            // Roll visual during replay: integrate from actual replay displacement.
            // Match sim's distance-based approach (Δθ = Δs/r) with the same readability scale (0.6).
            const dx = p.x - r.lastX
            const dy = p.y - r.lastY
            const ds = Math.sign(dx || 0) * Math.hypot(dx, dy)
            const rr = Math.max(1e-6, s.disc.r)
            s.disc.rot += (ds / rr) * 0.6
            if (s.disc.rot > Math.PI * 2 || s.disc.rot < -Math.PI * 2) s.disc.rot = s.disc.rot % (Math.PI * 2)
            r.lastX = p.x
            r.lastY = p.y

            s.disc.p.x = p.x
            s.disc.p.y = p.y
          }
          updateRunCamera(s)
          // No camera-death during replay.
        } else {
          stepSim(s, dtSec)
          updateRunCamera(s)
          applyCameraDeath(s)
        }
      }

      // SFX management: play/stop jetpack and rolling ball sounds based on game state
      if (!paused && !replayRef.current && s.runStarted && !s.dead && !s.finished) {
        // Jetpack sound: play when thrusting, stop otherwise
        if (s.input.thrust && s.jet.energy > 0) {
          playJetpackSfx()
        } else {
          stopJetpackSfx()
        }

        // Rolling ball sound: play when grounded, stop when in air
        if (s.disc.grounded) {
          playRollingballSfx()
        } else {
          stopRollingballSfx()
        }
      } else {
        // Stop all SFX when paused, in replay, or not running
        stopJetpackSfx()
        stopRollingballSfx()
      }

      // If we finished and it’s a new best, persist best time + ghost (positions).
      // Finish handling: run exactly once per finish. If this run is the new best time,
      // persist best time + ghost. This avoids relying on transient flags.
      if (s.finished && !s.finishHandled && s.result) {
        s.finishHandled = true
        const timeMs = s.result.timeMs
        const prevBest = s.bestTimeMs
        const isNewBest = prevBest == null || timeMs < prevBest
        if (isNewBest) {
          s.bestTimeMs = timeMs
          saveBestTimeMs(s.track.id, timeMs)
          const samples = s.recording.samples.slice()
          // Ensure the finish pose is included.
          const tSec = timeMs / 1000
          if (
            samples.length === 0 ||
            Math.abs(samples[samples.length - 1]!.t - tSec) > 1 / s.recording.samplesHz
          ) {
            samples.push({ t: tSec, x: s.disc.p.x, y: s.disc.p.y })
          }
          const ghost: GhostRun = {
            version: 1,
            trackId: s.track.id,
          trackHash: s.track.trackHash,
            timeMs,
            samplesHz: s.recording.samplesHz,
            samples,
          }
          s.bestGhost = ghost
        s.ghostPlayback.active = isGhostCompatible(ghost)
          saveBestGhost(s.track.id, ghost)
        }
      }

      // Completion + high score prompt.
      if (s.finished && s.finishHandled && !handledFinishRef.current && s.result) {
        handledFinishRef.current = true
      }

      drawFrame(canvas, s)

      // HUD throttle.
      const bucket = Math.floor(now / 100)
      if (bucket !== hudBucketRef.current) {
        hudBucketRef.current = bucket
        const rr = s.result
        setHud({
          timeMs: s.timeMs,
          energy: s.jet.energy,
          coins: s.coinsCollected.size,
          coinsTotal: s.track.coins.length,
          bestTimeMs: s.bestTimeMs,
          dead: s.dead,
          finished: s.finished,
          medal: medalLabel(rr),
        })
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('resize', resize)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [paused, replayEnded, track])

  const showOverlay = hud.dead || hud.finished
  const showPause = paused && !showOverlay

  const refreshLeaderboard = useCallback(async () => {
    setLbErr(null)
    setLbLoading(true)
    try {
      const top5 = await fetchDailyTop5(dateKey)
      setLbTop5(top5)
      if (lbSubmittedId) {
        const around = await fetchDailyAround(dateKey, lbSubmittedId)
        setLbAround(around)
      } else {
        setLbAround(null)
      }
    } catch (e: any) {
      setLbErr(String(e?.message ?? e))
    } finally {
      setLbLoading(false)
    }
  }, [dateKey, lbSubmittedId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    refreshLeaderboard()
  }, [refreshLeaderboard])

  const submitToLeaderboard = useCallback(async () => {
    const s = stateRef.current
    if (!s?.result?.finished) return
    if (submittedRunToken === runTokenRef.current) return
    setLbSubmitErr(null)
    setLbSubmitting(true)
    try {
      const timeMs = s.result.timeMs
      const tSec = timeMs / 1000
      const samples = s.recording.samples.slice()
      if (samples.length === 0 || Math.abs(samples[samples.length - 1]!.t - tSec) > 1 / s.recording.samplesHz) {
        samples.push({ t: tSec, x: s.disc.p.x, y: s.disc.p.y })
      }
      const replay: GhostRun = {
        version: 1,
        trackId: s.track.id,
        trackHash: s.track.trackHash,
        timeMs,
        samplesHz: s.recording.samplesHz,
        samples,
      }
      const name = (lbName || 'Player').trim().slice(0, 16) || 'Player'
      const out = await submitDailyRun({ dateKey, name, timeMs, replay })
      setLbSubmittedId(out.id)
      saveSubmittedRunId(dateKey, out.id)
      saveLastLbName(out.name)
      setLbName(out.name)
      setSubmittedRunToken(runTokenRef.current)
      await refreshLeaderboard()
    } catch (e: any) {
      setLbSubmitErr(String(e?.message ?? e))
    } finally {
      setLbSubmitting(false)
    }
  }, [dateKey, lbName, refreshLeaderboard, submittedRunToken])

  return (
    <div className="sl-viewport">
      <div className="sl-shell">
        <main className="sl-main">
          <div className="sl-arena">
            <canvas ref={canvasRef} className="sl-canvas" />

            <div className="hudRace" aria-label="Racing HUD">
              <div className="hudTimeCard" aria-label="Timer">
                <div className="hudMajorLabel">TIME</div>
                <div className="hudMajorValue">{fmtMs(hud.timeMs)}</div>
                {hud.bestTimeMs != null && (
                  <div className="hudMinorValue" aria-label="Best time">
                    Best {fmtMs(hud.bestTimeMs)}
                  </div>
                )}
              </div>

              <div className="hudControls" aria-label="Controls">
                <button
                  type="button"
                  className="hudBtn"
                  onClick={() => setPaused(true)}
                  aria-label="Pause"
                >
                  Pause
                </button>
              </div>
            </div>

            {replayRun && (
              <div
                style={{
                  position: 'absolute',
                  top: 10,
                  right: 10,
                  zIndex: 5,
                  display: 'flex',
                  gap: '0.5rem',
                  alignItems: 'center',
                  padding: '0.45rem 0.6rem',
                  borderRadius: 999,
                  background: 'rgba(10, 8, 22, 0.55)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  color: '#fff6d5',
                  fontWeight: 800,
                }}
              >
                <span style={{ opacity: 0.9 }}>REPLAY</span>
                {replayEnded && <span style={{ opacity: 0.7, fontWeight: 700 }}>ended</span>}
                {replayEnded && (
                  <button type="button" className="hudBtn" onClick={() => startReplay(replayRun)}>
                    Replay again
                  </button>
                )}
                <button type="button" className="hudBtn" onClick={exitReplay}>
                  Exit
                </button>
              </div>
            )}

            {showOverlay && (
              <div className="overlay" role="dialog" aria-label={hud.finished ? 'Finished' : 'Crashed'}>
                <div className="panel">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                    <div className="panelTitle">{hud.finished ? 'Finished' : 'Out of bounds'}</div>
                    {hud.finished && submittedRunToken === runTokenRef.current && (
                      <div style={{ 
                        fontFamily: "'Nunito', system-ui, sans-serif",
                        fontWeight: 800,
                        fontSize: '0.85rem',
                        color: 'rgba(255, 246, 213, 0.90)',
                        textAlign: 'right',
                        maxWidth: '180px',
                        lineHeight: '1.3'
                      }}>
                        Replay to improve your rank!
                      </div>
                    )}
                  </div>
                  <div className="panelBody">
                    <div>
                      <strong>Time:</strong> {fmtMs(hud.timeMs)}
                    </div>
                    {hud.medal && (
                      <div style={{ marginTop: '0.35rem' }}>
                        <strong>Result:</strong> {hud.medal}
                      </div>
                    )}

                    {hud.finished && (
                      <div style={{ marginTop: '0.85rem' }}>
                        <strong>Daily Leaderboard</strong>
                        <div style={{ marginTop: '0.45rem', display: 'grid', gap: '0.4rem' }}>
                          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <input
                              value={lbName}
                              onChange={(e) => setLbName(e.target.value)}
                              onBlur={() => saveLastLbName((lbName || '').trim().slice(0, 16))}
                              maxLength={16}
                              placeholder="PLAYER"
                              disabled={lbSubmitting}
                              style={{
                                flex: 1,
                                borderRadius: 999,
                                border: '1px solid rgba(255,245,200,0.22)',
                                background: 'rgba(12,10,28,0.55)',
                                color: '#fff6d5',
                                padding: '0.48rem 0.8rem',
                                outline: 'none',
                                fontSize: 16,
                              }}
                            />
                            <button
                              type="button"
                              className="btn"
                              disabled={!hud.finished || lbSubmitting || submittedRunToken === runTokenRef.current}
                              onClick={submitToLeaderboard}
                            >
                              {submittedRunToken === runTokenRef.current ? 'Submitted' : lbSubmitting ? 'Submitting…' : 'Submit'}
                            </button>
                          </div>
                          {lbSubmitErr && <div style={{ color: 'rgba(255,120,120,0.95)' }}>{lbSubmitErr}</div>}

                          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', justifyContent: 'space-between' }}>
                            <button type="button" className="hudBtn" onClick={refreshLeaderboard} disabled={lbLoading}>
                              {lbLoading ? 'Refreshing…' : 'Refresh'}
                            </button>
                            {lbErr && <span style={{ color: 'rgba(255,120,120,0.95)' }}>{lbErr}</span>}
                          </div>

                          {lbTop5 && lbTop5.length > 0 && (
                            <div style={{ marginTop: '0.25rem' }}>
                              <div style={{ opacity: 0.85, fontWeight: 800 }}>Top 5</div>
                              <ol style={{ margin: '0.35rem 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '0.25rem' }}>
                                {lbTop5.map((e) => (
                                  <li
                                    key={e.id}
                                    style={{
                                      display: 'grid',
                                      gridTemplateColumns: '2.2rem 1fr auto auto auto',
                                      gap: '0.55rem',
                                      alignItems: 'baseline',
                                      opacity: ghostPickId === e.id ? 1 : 0.92,
                                    }}
                                  >
                                    <span style={{ opacity: 0.75 }}>#{e.rank}</span>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMs(e.time_ms)}</span>
                                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }} title="Use as ghost">
                                      <input
                                        type="checkbox"
                                        checked={ghostPickId === e.id}
                                        onChange={() => setGhostPickId((cur) => (cur === e.id ? null : e.id))}
                                      />
                                      <span style={{ opacity: 0.85, fontSize: '0.9rem' }}>ghost</span>
                                    </label>
                                    <button
                                      type="button"
                                      className="hudBtn"
                                      title="View Replay"
                                      onClick={() => {
                                        startReplay(e)
                                      }}
                                      style={{ paddingInline: '0.55rem' }}
                                    >
                                      👁
                                    </button>
                                  </li>
                                ))}
                              </ol>
                            </div>
                          )}

                          {lbSubmittedId && lbAround && lbAround.length > 0 && (
                            <div style={{ marginTop: '0.55rem' }}>
                              <div style={{ opacity: 0.85, fontWeight: 800 }}>You</div>
                              <ol style={{ margin: '0.35rem 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '0.25rem' }}>
                                {lbAround.map((e) => {
                                  const isMe = e.id === lbSubmittedId
                                  return (
                                    <li
                                      key={e.id}
                                      style={{
                                        display: 'grid',
                                        gridTemplateColumns: '2.2rem 1fr auto auto auto',
                                        gap: '0.55rem',
                                        alignItems: 'baseline',
                                        opacity: isMe || ghostPickId === e.id ? 1 : 0.82,
                                      }}
                                    >
                                      <span style={{ opacity: 0.75 }}>#{e.rank}</span>
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {e.name}
                                        {isMe ? ' (you)' : ''}
                                      </span>
                                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMs(e.time_ms)}</span>
                                      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }} title="Use as ghost">
                                        <input
                                          type="checkbox"
                                          checked={ghostPickId === e.id}
                                          onChange={() => setGhostPickId((cur) => (cur === e.id ? null : e.id))}
                                        />
                                        <span style={{ opacity: 0.85, fontSize: '0.9rem' }}>ghost</span>
                                      </label>
                                      <button
                                        type="button"
                                        className="hudBtn"
                                        title="View Replay"
                                        onClick={() => {
                                          startReplay(e)
                                        }}
                                        style={{ paddingInline: '0.55rem' }}
                                      >
                                        👁
                                      </button>
                                    </li>
                                  )
                                })}
                              </ol>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="panelActions">
                    <button
                      type="button"
                      className="btn"
                      onClick={restart}
                    >
                      Restart
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showPause && (
              <div className="overlay" role="dialog" aria-label="Paused">
                <div className="panel">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                    <div>
                      <div className="panelTitle" style={{ marginBottom: '0.5rem' }}>Paused</div>
                      <div>
                        <strong>Time:</strong> {fmtMs(hud.timeMs)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: '140px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <label
                          htmlFor="bgm-slider"
                          style={{
                            fontSize: '0.9rem',
                            opacity: 0.85,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          BGM
                        </label>
                        <input
                          id="bgm-slider"
                          type="range"
                          min="0"
                          max="100"
                          value={Math.round(musicVolume * 100)}
                          onChange={(e) => {
                            const vol = Number(e.target.value) / 100
                            setMusicVolume(vol)
                            setBackgroundMusicVolume(vol)
                          }}
                          style={{
                            flex: 1,
                            cursor: 'pointer',
                          }}
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <label
                          htmlFor="sfx-slider"
                          style={{
                            fontSize: '0.9rem',
                            opacity: 0.85,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          SFX
                        </label>
                        <input
                          id="sfx-slider"
                          type="range"
                          min="0"
                          max="100"
                          value={Math.round(sfxVolume * 100)}
                          onChange={(e) => {
                            const vol = Number(e.target.value) / 100
                            setSfxVolumeState(vol)
                            setSfxVolume(vol)
                          }}
                          style={{
                            flex: 1,
                            cursor: 'pointer',
                          }}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="panelBody">
                    {lbTop5 && lbTop5.length > 0 && (
                      <div style={{ marginTop: '0.85rem' }}>
                        <strong>High Scores</strong>
                        <ol style={{ margin: '0.35rem 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '0.25rem' }}>
                          {lbTop5.map((e) => (
                            <li
                              key={e.id}
                              style={{ display: 'grid', gridTemplateColumns: '2.2rem 1fr auto', gap: '0.55rem', alignItems: 'baseline' }}
                            >
                              <span style={{ opacity: 0.75 }}>#{e.rank}</span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMs(e.time_ms)}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {lbSubmittedId && lbAround && lbAround.length > 0 && (
                      <div style={{ marginTop: '0.75rem' }}>
                        <strong>You</strong>
                        <ol style={{ margin: '0.35rem 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '0.25rem' }}>
                          {lbAround.map((e) => (
                            <li
                              key={e.id}
                              style={{ display: 'grid', gridTemplateColumns: '2.2rem 1fr auto', gap: '0.55rem', alignItems: 'baseline' }}
                            >
                              <span style={{ opacity: 0.75 }}>#{e.rank}</span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {e.name}
                                {e.id === lbSubmittedId ? ' (you)' : ''}
                              </span>
                              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMs(e.time_ms)}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                  <div className="panelActions">
                    <button type="button" className="btn ghost" onClick={() => setPaused(false)}>
                      Resume
                    </button>
                    <button type="button" className="btn" onClick={restart}>
                      Restart
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}


