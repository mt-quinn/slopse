import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './app.css'
import { ALL_TRACKS, getTrackById } from './game/track'
import { createInitialRunState, type GhostRun, type RunResult, type RunState } from './game/state'
import { loadBestGhost, loadBestTimeMs, saveBestGhost, saveBestTimeMs } from './game/persist'
import { clamp, lerp } from './game/math'
import { stepSim } from './game/sim'
import { drawFrame } from './render/draw'
import { addTopTime, loadLastPlayerName, loadTopTimes, qualifiesTop5, saveLastPlayerName } from './game/highScores'
import { loadCompletedTrackIds, saveCompletedTrackIds } from './game/progression'
import { applyCameraDeath, updateRunCamera } from './game/camera'
import { startRun } from './game/runControl'

const DevEditorGate = () => {
  const [Editor, setEditor] = useState<null | React.ComponentType>(null)
  useEffect(() => {
    let alive = true
    import('./editor/TrackEditor').then((m) => {
      if (!alive) return
      setEditor(() => m.default as any)
    })
    return () => {
      alive = false
    }
  }, [])
  if (!Editor) {
    return (
      <div className="sl-viewport">
        <div className="sl-shell" style={{ padding: '1rem' }}>
          <div className="panel">
            <div className="panelTitle">Loading editor…</div>
          </div>
        </div>
      </div>
    )
  }
  return <Editor />
}

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
  const isEditor = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('editor')
  // Editor is a local-only dev tool.
  if (isEditor) {
    if (!import.meta.env.DEV) {
      // On production (e.g. Vercel), ignore the editor flag and run the game.
    } else if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
      // Avoid exposing editor on non-local hosts even in dev server mode.
      return (
        <div className="sl-viewport">
          <div className="sl-shell" style={{ padding: '1rem' }}>
            <div className="panel">
              <div className="panelTitle">Editor disabled</div>
              <div className="panelBody">The track editor is only available on localhost.</div>
            </div>
          </div>
        </div>
      )
    } else {
      return <DevEditorGate />
    }
  }

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const hudBucketRef = useRef<number>(-1)

  const firstTrackId = useMemo(() => ALL_TRACKS[0]!.id, [])
  const [currentTrackId, setCurrentTrackId] = useState<string>(firstTrackId)
  const [showTrackSelect, setShowTrackSelect] = useState(false)
  const [paused, setPaused] = useState(false)

  const completedIds = useMemo(() => (typeof window !== 'undefined' ? loadCompletedTrackIds() : new Set<string>()), [])
  const [completedToken, setCompletedToken] = useState(0)

  const getUnlockedSet = useCallback(() => {
    // Unlock rule: track 0 is always unlocked; any completed track is unlocked;
    // and completing a track unlocks the next one in ALL_TRACKS order.
    const done = typeof window !== 'undefined' ? loadCompletedTrackIds() : new Set<string>()
    const unlocked = new Set<string>()
    if (ALL_TRACKS.length > 0) unlocked.add(ALL_TRACKS[0]!.id)
    for (const id of done) unlocked.add(id)
    for (let i = 0; i < ALL_TRACKS.length - 1; i++) {
      const a = ALL_TRACKS[i]!
      const b = ALL_TRACKS[i + 1]!
      if (done.has(a.id)) unlocked.add(b.id)
    }
    return { done, unlocked }
  }, [])

  const track = useMemo(() => getTrackById(currentTrackId) ?? ALL_TRACKS[0]!, [currentTrackId])

  const stateRef = useRef<RunState | null>(null)

  const [hud, setHud] = useState(() => ({
    timeMs: 0,
    energy: 1,
    speedMph: 0,
    coins: 0,
    coinsTotal: track.coins.length,
    bestTimeMs: typeof window !== 'undefined' ? loadBestTimeMs(track.id) : null,
    dead: false,
    finished: false,
    medal: null as string | null,
  }))

  const [topTimes, setTopTimes] = useState(() =>
    typeof window !== 'undefined' ? loadTopTimes(track.id) : [],
  )
  const [nameDraft, setNameDraft] = useState(() =>
    typeof window !== 'undefined' ? loadLastPlayerName() : '',
  )
  const [showNamePrompt, setShowNamePrompt] = useState(false)
  const [pendingScoreMs, setPendingScoreMs] = useState<number | null>(null)
  const handledFinishRef = useRef(false)

  const initRunForTrack = useCallback(
    (trackId: string) => {
      const t = getTrackById(trackId)
      if (!t) return
      const s = createInitialRunState(t)
      s.bestTimeMs = typeof window !== 'undefined' ? loadBestTimeMs(t.id) : null
      s.bestGhost = typeof window !== 'undefined' ? loadBestGhost(t.id) : null
      s.ghostPlayback.active = s.bestGhost != null
      stateRef.current = s
      setHud({
        timeMs: 0,
        energy: 1,
        speedMph: 0,
        coins: 0,
        coinsTotal: t.coins.length,
        bestTimeMs: s.bestTimeMs,
        dead: false,
        finished: false,
        medal: null,
      })
      setShowNamePrompt(false)
      setPendingScoreMs(null)
      handledFinishRef.current = false
      setPaused(false)
    },
    [],
  )

  const startRunIfNeeded = useCallback(() => {
    const s = stateRef.current
    if (!s) return
    const started = startRun(s)
    if (!started) return
    handledFinishRef.current = false

    setHud((h) => ({
      ...h,
      timeMs: 0,
      energy: 1,
      speedMph: 0,
      coins: 0,
      coinsTotal: s.track.coins.length,
      dead: false,
      finished: false,
      medal: null,
    }))
  }, [])

  // Initialize and re-initialize when track changes. Doing this in an effect avoids
  // calling setState during render (which can crash in StrictMode/dev).
  useEffect(() => {
    initRunForTrack(currentTrackId)
    if (typeof window !== 'undefined') setTopTimes(loadTopTimes(currentTrackId))
  }, [currentTrackId, initRunForTrack])

  const restart = useCallback(() => {
    const prev = stateRef.current
    if (!prev) return
    const next = createInitialRunState(getTrackById(prev.track.id) ?? track)
    next.view = prev.view
    next.bestTimeMs = prev.bestTimeMs
    next.bestGhost = prev.bestGhost
    next.ghostPlayback.active = next.bestGhost != null
    Object.assign(prev, next)
    setHud((h) => ({
      ...h,
      timeMs: 0,
      energy: 1,
      speedMph: 0,
      coins: 0,
      coinsTotal: prev.track.coins.length,
      dead: false,
      finished: false,
      medal: null,
    }))
    setShowNamePrompt(false)
    setPendingScoreMs(null)
    handledFinishRef.current = false
    setPaused(false)
  }, [track])

  const nextTrack = useCallback(() => {
    const idx = ALL_TRACKS.findIndex((t) => t.id === currentTrackId)
    if (idx < 0) return
    const next = ALL_TRACKS[(idx + 1) % ALL_TRACKS.length]!
    // Allow going to next if unlocked, otherwise stay.
    const { unlocked } = getUnlockedSet()
    if (!unlocked.has(next.id)) return
    setCurrentTrackId(next.id)
    setPaused(false)
  }, [currentTrackId, getUnlockedSet, initRunForTrack])

  const selectTrack = useCallback(
    (id: string) => {
      const { unlocked } = getUnlockedSet()
      if (!unlocked.has(id)) return
      setCurrentTrackId(id)
      setShowTrackSelect(false)
      setPaused(false)
    },
    [getUnlockedSet, initRunForTrack],
  )

  // Pointer input: press anywhere to thrust; release to stop.
  // Also detect triple-tap for quick restart.
  useEffect(() => {
    const tapTimes: number[] = []
    const TRIPLE_TAP_WINDOW_MS = 500
    
    const onDown = (e: PointerEvent) => {
      e.preventDefault()
      const s = stateRef.current
      if (!s) return
      if (paused) return
      
      // Triple-tap restart detection (during active gameplay only)
      if (!s.dead && !s.finished && s.timeMs > 0) {
        const now = Date.now()
        tapTimes.push(now)
        // Keep only recent taps within the time window
        while (tapTimes.length > 0 && now - tapTimes[0]! > TRIPLE_TAP_WINDOW_MS) {
          tapTimes.shift()
        }
        // If we have 3 taps within the window, restart
        if (tapTimes.length >= 3) {
          tapTimes.length = 0
          restart()
          return
        }
      }
      
      if (s.dead || s.finished) return
      if (s.input.thrustPointerId != null) return
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
  }, [paused, startRunIfNeeded, restart])

  // Keyboard fallback.
  useEffect(() => {
    const onKey = (e: KeyboardEvent, isDown: boolean) => {
      if (e.key !== ' ' && e.code !== 'Space') return
      const s = stateRef.current
      if (!s) return
      if (paused) return
      if (s.dead || s.finished) return
      if (isDown) startRunIfNeeded()
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
  }, [paused, startRunIfNeeded])

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
        stepSim(s, dtSec)
        updateRunCamera(s)
        applyCameraDeath(s)
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
            timeMs,
            samplesHz: s.recording.samplesHz,
            samples,
          }
          s.bestGhost = ghost
          s.ghostPlayback.active = true
          saveBestGhost(s.track.id, ghost)
        }
      }

      // Completion + high score prompt.
      if (s.finished && s.finishHandled && !handledFinishRef.current && s.result) {
        handledFinishRef.current = true
        const timeMs = s.result.timeMs
        setPendingScoreMs(timeMs)

        // Mark track complete + unlock next.
        if (typeof window !== 'undefined') {
          const done = loadCompletedTrackIds()
          done.add(s.track.id)
          saveCompletedTrackIds(done)
          setCompletedToken((x) => x + 1)
        }

        // Prompt for top-5 name entry.
        if (typeof window !== 'undefined' && qualifiesTop5(s.track.id, timeMs)) {
          setShowNamePrompt(true)
        }
      }

      drawFrame(canvas, s)

      // HUD throttle.
      const bucket = Math.floor(now / 100)
      if (bucket !== hudBucketRef.current) {
        hudBucketRef.current = bucket
        const r = s.result
        const speedPxPerSec = Math.hypot(s.disc.v.x, s.disc.v.y)
        const speedMph = Math.round(speedPxPerSec / 10)
        setHud({
          timeMs: s.timeMs,
          energy: s.jet.energy,
          speedMph,
          coins: s.coinsCollected.size,
          coinsTotal: s.track.coins.length,
          bestTimeMs: s.bestTimeMs,
          dead: s.dead,
          finished: s.finished,
          medal: medalLabel(r),
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
  }, [paused, track])

  // Keep top times in sync when track changes.
  useEffect(() => {
    if (typeof window === 'undefined') return
    setTopTimes(loadTopTimes(track.id))
  }, [track.id, completedToken])

  const showOverlay = (hud.dead || hud.finished) && !showTrackSelect
  const showPause = paused && !showTrackSelect && !showOverlay

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
              </div>

              <div className="hudSpeedCard" aria-label="Speed">
                <div className="hudMajorLabel">SPEED</div>
                <div className="hudSpeedValue">
                  <span className="hudSpeedNum">{hud.speedMph}</span>
                  <span className="hudSpeedUnit">mph</span>
                </div>
              </div>

              <div className="hudMetaCard" aria-label="Meta">
                <div className="hudMetaRow">
                  <span className="hudMetaKey">Track</span>
                  <span className="hudMetaVal" title={track.name}>
                    {track.name}
                  </span>
                </div>
                {hud.bestTimeMs != null && (
                  <div className="hudMetaRow">
                    <span className="hudMetaKey">Best</span>
                    <span className="hudMetaVal">{fmtMs(hud.bestTimeMs)}</span>
                  </div>
                )}
                {hud.coinsTotal > 0 && (
                  <div className="hudMetaRow">
                    <span className="hudMetaKey">Coins</span>
                    <span className="hudMetaVal">
                      {hud.coins}/{hud.coinsTotal}
                    </span>
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

            {showOverlay && (
              <div className="overlay" role="dialog" aria-label={hud.finished ? 'Finished' : 'Crashed'}>
                <div className="panel">
                  <div className="panelTitle">{hud.finished ? 'Finished' : 'Out of bounds'}</div>
                  <div className="panelBody">
                    <div>
                      <strong>Time:</strong> {fmtMs(hud.timeMs)}
                    </div>
                    <div>
                      <strong>Coins:</strong> {hud.coins}/{hud.coinsTotal}
                    </div>
                    {hud.medal && (
                      <div style={{ marginTop: '0.35rem' }}>
                        <strong>Result:</strong> {hud.medal}
                      </div>
                    )}
                    {topTimes.length > 0 && (
                      <div style={{ marginTop: '0.8rem' }}>
                        <strong>Top Times</strong>
                        <ol style={{ margin: '0.35rem 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '0.25rem' }}>
                          {topTimes.map((e, i) => (
                            <li
                              key={`${e.ts}-${i}`}
                              style={{ display: 'grid', gridTemplateColumns: '1.5rem 1fr auto', gap: '0.55rem', alignItems: 'baseline' }}
                            >
                              <span style={{ opacity: 0.75 }}>{i + 1}</span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMs(e.timeMs)}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {showNamePrompt && pendingScoreMs != null && (
                      <div style={{ marginTop: '0.8rem' }}>
                        <strong>New Top 5 — enter your name</strong>
                        <div style={{ marginTop: '0.45rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                          <input
                            value={nameDraft}
                            onChange={(e) => setNameDraft(e.target.value)}
                            maxLength={16}
                            placeholder="PLAYER"
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
                            onClick={() => {
                              const name = (nameDraft || 'Player').trim().slice(0, 16) || 'Player'
                              const timeMs = pendingScoreMs
                              const next = addTopTime(track.id, { name, timeMs })
                              setTopTimes(next)
                              saveLastPlayerName(name)
                              setShowNamePrompt(false)
                            }}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    )}
                    <div style={{ marginTop: '0.6rem', opacity: 0.85, fontSize: '0.92rem' }}>
                      Gold medal is the time target. The top rating is <strong>Gold + all coins</strong> in one run.
                    </div>
                  </div>
                  <div className="panelActions">
                    <button
                      type="button"
                      className="btn"
                      onClick={restart}
                    >
                      Restart
                    </button>
                    <button type="button" className="btn" onClick={nextTrack}>
                      Next
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setShowTrackSelect(true)}>
                      Tracks
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showPause && (
              <div className="overlay" role="dialog" aria-label="Paused">
                <div className="panel">
                  <div className="panelTitle">Paused</div>
                  <div className="panelBody">
                    <div>
                      <strong>Time:</strong> {fmtMs(hud.timeMs)}
                    </div>
                    {hud.coinsTotal > 0 && (
                      <div>
                        <strong>Coins:</strong> {hud.coins}/{hud.coinsTotal}
                      </div>
                    )}
                    {topTimes.length > 0 && (
                      <div style={{ marginTop: '0.8rem' }}>
                        <strong>Top Times</strong>
                        <ol style={{ margin: '0.35rem 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: '0.25rem' }}>
                          {topTimes.map((e, i) => (
                            <li
                              key={`${e.ts}-${i}`}
                              style={{ display: 'grid', gridTemplateColumns: '1.5rem 1fr auto', gap: '0.55rem', alignItems: 'baseline' }}
                            >
                              <span style={{ opacity: 0.75 }}>{i + 1}</span>
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMs(e.timeMs)}</span>
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
                    <button type="button" className="btn" onClick={nextTrack}>
                      Next
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setShowTrackSelect(true)}>
                      Tracks
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showTrackSelect && (
              <div className="overlay" role="dialog" aria-label="Track select">
                <div className="panel">
                  <div className="panelTitle">Tracks</div>
                  <div className="panelBody">
                    {(() => {
                      const { done, unlocked } = getUnlockedSet()
                      return (
                        <div style={{ display: 'grid', gap: '0.4rem', marginTop: '0.4rem' }}>
                          {ALL_TRACKS.map((t, idx) => {
                            const isUnlocked = unlocked.has(t.id)
                            const isDone = done.has(t.id)
                            const best = loadBestTimeMs(t.id)
                            return (
                              <button
                                key={t.id}
                                type="button"
                                className="hudBtn"
                                style={{
                                  width: '100%',
                                  textAlign: 'left',
                                  opacity: isUnlocked ? 1 : 0.45,
                                  cursor: isUnlocked ? 'pointer' : 'not-allowed',
                                }}
                                disabled={!isUnlocked}
                                onClick={() => selectTrack(t.id)}
                              >
                                {idx + 1}. {t.name}
                                {isDone ? ' ✓' : ''}
                                {best != null ? ` — Best ${fmtMs(best)}` : ''}
                              </button>
                            )
                          })}
                        </div>
                      )
                    })()}

                  </div>
                  <div className="panelActions">
                    <button type="button" className="btn ghost" onClick={() => setShowTrackSelect(false)}>
                      Close
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


