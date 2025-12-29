import { useEffect, useMemo, useRef, useState } from 'react'
import './editor.css'
import {
  ALL_TRACK_SOURCES,
  compileTrack,
  getTrackSourceById,
  nodesFromCatmullCtrl,
  type TrackPath,
  type TrackPathNode,
  type TrackSource,
} from '../game/track'
import { createInitialRunState, type RunState } from '../game/state'
import { stepSim } from '../game/sim'
import { drawFrame } from '../render/draw'
import { deriveMedalsFromAuthorTime } from '../game/medals'
import { applyCameraDeath, updateRunCamera } from '../game/camera'
import { startRun } from '../game/runControl'

type Tool = 'select' | 'draw' | 'pan' | 'start' | 'finish'
type DragTarget =
  | { kind: 'pan' }
  | { kind: 'node'; pathId: string; nodeIdx: number }
  | { kind: 'in'; pathId: string; nodeIdx: number }
  | { kind: 'out'; pathId: string; nodeIdx: number }
  | { kind: 'finish' }
  | { kind: 'startP' }
  | { kind: 'startV' }

type EdgeSel = { pathId: string; aIdx: number } // edge between aIdx and aIdx+1 (or wrap if closed)

const fmtMs = (ms: number) => {
  const t = Math.max(0, Math.round(ms))
  const m = Math.floor(t / 60000)
  const s = Math.floor((t % 60000) / 1000)
  const cs = Math.floor((t % 1000) / 10)
  return `${String(m).padStart(1, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

const fmtSec2 = (ms: number) => {
  const s = (Math.max(0, ms) / 1000).toFixed(2)
  return s.length < 5 ? s.padStart(5, '0') : s
}

// Parses "00.00" seconds into ms (centisecond resolution). Returns null on invalid.
const parseSec2ToMs = (raw: string): number | null => {
  const t = raw.trim()
  if (!t) return 0
  // Allow digits + one dot.
  if (!/^\d*\.?\d*$/.test(t)) return null
  const f = Number(t)
  if (!Number.isFinite(f)) return null
  // Store as centiseconds (0.01s) => 10ms ticks.
  const cs = Math.round(Math.max(0, f) * 100)
  return cs * 10
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const dist2 = (ax: number, ay: number, bx: number, by: number) => {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

const newId = (prefix: string) => `${prefix}-${Math.random().toString(16).slice(2)}`

export default function TrackEditor() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const stateRef = useRef<RunState | null>(null)
  const lastTickRef = useRef<number>(performance.now())

  const [selectedTrackId, setSelectedTrackId] = useState(ALL_TRACK_SOURCES[0]?.id ?? 'track-001')
  const [src, setSrc] = useState<TrackSource>(() => {
    const t = getTrackSourceById(selectedTrackId) ?? ALL_TRACK_SOURCES[0]!
    return structuredClone(t)
  })

  useEffect(() => {
    const t = getTrackSourceById(selectedTrackId)
    if (!t) return
    setSrc(structuredClone(t))
    setSelectedPathId(t.paths[0]?.id ?? '')
    setSelectedNode(null)
    setSelectedEdge(null)
  }, [selectedTrackId])

  const [tool, setTool] = useState<Tool>('select')
  const [selectedPathId, setSelectedPathId] = useState<string>(() => src.paths[0]?.id ?? '')
  const [selectedNode, setSelectedNode] = useState<{ pathId: string; nodeIdx: number } | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<EdgeSel | null>(null)
  const [playtest, setPlaytest] = useState(false)

  const [camera, setCamera] = useState(() => ({ x: 0, y: 0, zoom: 0.9 }))

  // Medal authoring / validation modal
  const [showMedals, setShowMedals] = useState(false)
  const [authorMs, setAuthorMs] = useState<number>(0)
  const [goldMs, setGoldMs] = useState<number>(0)
  const [silverMs, setSilverMs] = useState<number>(0)
  const [bronzeMs, setBronzeMs] = useState<number>(0)
  const [goldText, setGoldText] = useState('00.00')
  const [silverText, setSilverText] = useState('00.00')
  const [bronzeText, setBronzeText] = useState('00.00')

  const [medalEdit, setMedalEdit] = useState<{ gold: string; silver: string; bronze: string }>({
    gold: '00.00',
    silver: '00.00',
    bronze: '00.00',
  })

  type Snapshot = {
    src: TrackSource
    selectedPathId: string
    selectedNode: { pathId: string; nodeIdx: number } | null
    selectedEdge: EdgeSel | null
  }
  const historyRef = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] })

  const makeSnapshot = (): Snapshot => ({
    src: structuredClone(src),
    selectedPathId,
    selectedNode,
    selectedEdge,
  })

  const applyEdit = (fn: (draft: TrackSource) => TrackSource) => {
    historyRef.current.past.push(makeSnapshot())
    historyRef.current.future = []
    setSrc((prev) => fn(structuredClone(prev)))
  }

  const undo = () => {
    const h = historyRef.current
    const prev = h.past.pop()
    if (!prev) return
    h.future.push(makeSnapshot())
    setSrc(prev.src)
    setSelectedPathId(prev.selectedPathId)
    setSelectedNode(prev.selectedNode)
    setSelectedEdge(prev.selectedEdge)
  }

  const redo = () => {
    const h = historyRef.current
    const next = h.future.pop()
    if (!next) return
    h.past.push(makeSnapshot())
    setSrc(next.src)
    setSelectedPathId(next.selectedPathId)
    setSelectedNode(next.selectedNode)
    setSelectedEdge(next.selectedEdge)
  }

  // Center camera on load.
  useEffect(() => {
    const compiled = compileTrack(src)
    // Camera centers around start point by default.
    setCamera({ x: compiled.start.p.x + 220, y: compiled.start.p.y - 180, zoom: 0.9 })
  }, [])

  const compiled = useMemo(() => compileTrack(src), [src])

  const playtestRef = useRef(false)
  const showMedalsRef = useRef(false)
  const cameraRef = useRef(camera)
  const compiledRef = useRef(compiled)
  const srcRef = useRef(src)
  const selectedPathIdRef = useRef(selectedPathId)
  const selectedNodeRef = useRef(selectedNode)
  const selectedEdgeRef = useRef(selectedEdge)

  // Keep refs synced for the single RAF loop (avoids drift due to effect re-creation).
  useEffect(() => {
    playtestRef.current = playtest
    lastTickRef.current = performance.now()
  }, [playtest])
  useEffect(() => {
    showMedalsRef.current = showMedals
  }, [showMedals])
  useEffect(() => {
    cameraRef.current = camera
  }, [camera])
  useEffect(() => {
    compiledRef.current = compiled
  }, [compiled])
  useEffect(() => {
    srcRef.current = src
  }, [src])
  useEffect(() => {
    selectedPathIdRef.current = selectedPathId
  }, [selectedPathId])
  useEffect(() => {
    selectedNodeRef.current = selectedNode
  }, [selectedNode])
  useEffect(() => {
    selectedEdgeRef.current = selectedEdge
  }, [selectedEdge])

  // Keep sidebar medal text in sync when switching tracks / loading.
  useEffect(() => {
    setMedalEdit({
      gold: fmtSec2(src.medals.goldMs),
      silver: fmtSec2(src.medals.silverMs),
      bronze: fmtSec2(src.medals.bronzeMs),
    })
  }, [selectedTrackId, src.medals.bronzeMs, src.medals.goldMs, src.medals.silverMs])

  const worldToScreen = (p: { x: number; y: number }, w: number, h: number) => {
    const z = camera.zoom
    return { x: (p.x - camera.x) * z + w / 2, y: (p.y - camera.y) * z + h / 2 }
  }
  const screenToWorld = (p: { x: number; y: number }, w: number, h: number) => {
    const z = camera.zoom
    return { x: (p.x - w / 2) / z + camera.x, y: (p.y - h / 2) / z + camera.y }
  }

  const resetPlaytest = () => {
    const s = createInitialRunState(compiled)
    const canvas = canvasRef.current
    if (canvas) {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1))
      s.view.width = rect.width
      s.view.height = rect.height
      s.view.dpr = dpr
    }
    // Start immediately in playtest? Keep tap-to-start behavior (author can stage).
    stateRef.current = s
  }

  useEffect(() => {
    if (!playtest) {
      stateRef.current = null
      return
    }
    resetPlaytest()
  }, [playtest, compiled.id])

  // Canvas sizing
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let tries = 0
    const resize = () => {
      const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1))
      const parent = canvas.parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      if ((rect.width < 40 || rect.height < 40) && tries < 20) {
        tries++
        requestAnimationFrame(resize)
        return
      }
      tries = 0
      canvas.width = Math.floor(rect.width * dpr)
      canvas.height = Math.floor(rect.height * dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      const s = stateRef.current
      if (s) {
        s.view.width = rect.width
        s.view.height = rect.height
        s.view.dpr = dpr
      }
    }
    resize()
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('resize', resize)
    }
  }, [])

  // Prevent browser back/forward swipe while editing (best-effort; varies by browser).
  useEffect(() => {
    const root = document.documentElement
    const prevX = root.style.overscrollBehaviorX
    const prevY = root.style.overscrollBehaviorY
    root.style.overscrollBehaviorX = 'none'
    root.style.overscrollBehaviorY = 'none'

    const canvas = canvasRef.current
    if (!canvas) return

    const onWheelCapture = (e: WheelEvent) => {
      // We always handle wheel inside the editor (pan or pinch-zoom), so prevent the browser
      // from interpreting it as history navigation.
      e.preventDefault()
    }

    canvas.addEventListener('wheel', onWheelCapture, { passive: false, capture: true })
    return () => {
      canvas.removeEventListener('wheel', onWheelCapture, { capture: true } as any)
      root.style.overscrollBehaviorX = prevX
      root.style.overscrollBehaviorY = prevY
    }
  }, [])

  // Main render loop (single stable RAF: matches game loop behavior)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastTickRef.current) / 1000)
      lastTickRef.current = now

      if (playtestRef.current) {
        const s = stateRef.current
        if (s) {
          stepSim(s, dt)
          updateRunCamera(s)
          applyCameraDeath(s)
          drawFrame(canvas, s)
          if (s.finished && s.result && !showMedalsRef.current) {
            const aMs = s.result.timeMs
            const m = deriveMedalsFromAuthorTime(aMs)
            setAuthorMs(aMs)
            setGoldMs(m.goldMs)
            setSilverMs(m.silverMs)
            setBronzeMs(m.bronzeMs)
            setGoldText(fmtSec2(m.goldMs))
            setSilverText(fmtSec2(m.silverMs))
            setBronzeText(fmtSec2(m.bronzeMs))
            showMedalsRef.current = true
            setShowMedals(true)
          }
        }
      } else {
        const cam = cameraRef.current
        const comp = compiledRef.current
        const srcNow = srcRef.current
        const selPathId = selectedPathIdRef.current
        const selNode = selectedNodeRef.current
        const selEdge = selectedEdgeRef.current

        // Editor draw (unchanged logic, but reads from refs)
        const ctx = canvas.getContext('2d')!
        const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1))
        const w = canvas.width / dpr
        const h = canvas.height / dpr
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)

        ctx.fillStyle = 'rgba(0,0,0,0.12)'
        ctx.fillRect(0, 0, w, h)
        const z = cam.zoom
        const grid = 80
        const gx0 = Math.floor((cam.x - w / (2 * z)) / grid) * grid
        const gy0 = Math.floor((cam.y - h / (2 * z)) / grid) * grid
        ctx.strokeStyle = 'rgba(255,255,255,0.05)'
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let x = gx0; x < cam.x + w / (2 * z) + grid; x += grid) {
          const sx = ((x - cam.x) * z + w / 2)
          ctx.moveTo(sx, 0)
          ctx.lineTo(sx, h)
        }
        for (let y = gy0; y < cam.y + h / (2 * z) + grid; y += grid) {
          const sy = ((y - cam.y) * z + h / 2)
          ctx.moveTo(0, sy)
          ctx.lineTo(w, sy)
        }
        ctx.stroke()

        ctx.save()
        ctx.strokeStyle = 'rgba(255,246,213,0.9)'
        ctx.lineWidth = 3
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        for (const seg of comp.segments) {
          const ax = (seg.a.x - cam.x) * z + w / 2
          const ay = (seg.a.y - cam.y) * z + h / 2
          const bx = (seg.b.x - cam.x) * z + w / 2
          const by = (seg.b.y - cam.y) * z + h / 2
          ctx.moveTo(ax, ay)
          ctx.lineTo(bx, by)
        }
        ctx.stroke()
        ctx.restore()

        // Finish line
        {
          const fx = comp.finishX
          const ax = (fx - cam.x) * z + w / 2
          ctx.strokeStyle = 'rgba(255, 120, 210, 0.72)'
          ctx.lineWidth = 2
          ctx.setLineDash([8, 6])
          ctx.beginPath()
          ctx.moveTo(ax, (cam.y - 2000 - cam.y) * z + h / 2)
          ctx.lineTo(ax, (cam.y + 2000 - cam.y) * z + h / 2)
          ctx.stroke()
          ctx.setLineDash([])
        }

        // Start point + velocity arrow
        {
          const sp = comp.start.p
          const sv = comp.start.v
          const sx = (sp.x - cam.x) * z + w / 2
          const sy = (sp.y - cam.y) * z + h / 2
          ctx.fillStyle = 'rgba(130, 90, 255, 0.9)'
          ctx.beginPath()
          ctx.arc(sx, sy, 7, 0, Math.PI * 2)
          ctx.fill()

          const tip = { x: sp.x + sv.x * 0.6, y: sp.y + sv.y * 0.6 }
          const tx = (tip.x - cam.x) * z + w / 2
          const ty = (tip.y - cam.y) * z + h / 2
          ctx.strokeStyle = 'rgba(130, 90, 255, 0.9)'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(sx, sy)
          ctx.lineTo(tx, ty)
          ctx.stroke()
        }

        const path = srcNow.paths.find((p) => p.id === selPathId) ?? srcNow.paths[0]
        if (path) {
          if (selEdge && selEdge.pathId === path.id) {
            const nodes = path.nodes
            const closed = !!path.closed
            const count = nodes.length
            const edgeCount = closed ? count : count - 1
            if (count >= 2 && selEdge.aIdx >= 0 && selEdge.aIdx < edgeCount) {
              const a = nodes[selEdge.aIdx]!
              const b = nodes[(selEdge.aIdx + 1) % count]!
              const p0 = a.p
              const p3 = b.p
              const c1 = { x: p0.x + (a.out?.x ?? 0), y: p0.y + (a.out?.y ?? 0) }
              const c2 = { x: p3.x + (b.in?.x ?? 0), y: p3.y + (b.in?.y ?? 0) }
              const steps = 28
              ctx.strokeStyle = 'rgba(255, 120, 210, 0.88)'
              ctx.lineWidth = 6
              ctx.lineCap = 'round'
              ctx.beginPath()
              for (let k = 0; k <= steps; k++) {
                const t = k / steps
                const u = 1 - t
                const tt = t * t
                const uu = u * u
                const uuu = uu * u
                const ttt = tt * t
                const wp = {
                  x: uuu * p0.x + 3 * uu * t * c1.x + 3 * u * tt * c2.x + ttt * p3.x,
                  y: uuu * p0.y + 3 * uu * t * c1.y + 3 * u * tt * c2.y + ttt * p3.y,
                }
                const sx = (wp.x - cam.x) * z + w / 2
                const sy = (wp.y - cam.y) * z + h / 2
                if (k === 0) ctx.moveTo(sx, sy)
                else ctx.lineTo(sx, sy)
              }
              ctx.stroke()
            }
          }

          const nodeRadius = 6
          for (let i = 0; i < path.nodes.length; i++) {
            const n = path.nodes[i]!
            const nsx = (n.p.x - cam.x) * z + w / 2
            const nsy = (n.p.y - cam.y) * z + h / 2
            const isSel = selNode?.pathId === path.id && selNode.nodeIdx === i

            const hin = n.in ?? { x: 0, y: 0 }
            const hout = n.out ?? { x: 0, y: 0 }
            const pin = { x: n.p.x + hin.x, y: n.p.y + hin.y }
            const pout = { x: n.p.x + hout.x, y: n.p.y + hout.y }
            const sinx = (pin.x - cam.x) * z + w / 2
            const siny = (pin.y - cam.y) * z + h / 2
            const soutx = (pout.x - cam.x) * z + w / 2
            const souty = (pout.y - cam.y) * z + h / 2

            ctx.strokeStyle = 'rgba(255,255,255,0.12)'
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(nsx, nsy)
            ctx.lineTo(sinx, siny)
            ctx.moveTo(nsx, nsy)
            ctx.lineTo(soutx, souty)
            ctx.stroke()

            ctx.fillStyle = 'rgba(255, 245, 200, 0.65)'
            ctx.beginPath()
            ctx.arc(sinx, siny, 4, 0, Math.PI * 2)
            ctx.fill()
            ctx.beginPath()
            ctx.arc(soutx, souty, 4, 0, Math.PI * 2)
            ctx.fill()

            ctx.fillStyle = isSel ? 'rgba(255, 120, 210, 0.92)' : 'rgba(255,246,213,0.92)'
            ctx.beginPath()
            ctx.arc(nsx, nsy, nodeRadius, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Editor interactions
  const dragRef = useRef<{ target: DragTarget; startW: { x: number; y: number }; startCam: typeof camera } | null>(null)
  const drawRef = useRef<{ active: boolean; pts: Array<{ x: number; y: number }>; pathId: string } | null>(null)

  const onWheel = (e: React.WheelEvent) => {
    if (playtest) return
    const canvas = canvasRef.current
    if (!canvas) return
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    const p = { x: e.clientX - rect.left, y: e.clientY - rect.top }

    // Mac trackpad:
    // - Two-finger scroll -> wheel with deltaX/deltaY (pan)
    // - Pinch -> wheel event with ctrlKey=true (zoom)
    if (e.ctrlKey) {
      const before = screenToWorld(p, w, h)
      // More sensitive zoom (trackpad pinch / ctrl-wheel).
      const zoom = clamp(camera.zoom * Math.exp(-e.deltaY * 0.0042), 0.08, 4.0)
      const afterCam = { ...camera, zoom }
      const after = ((pp: { x: number; y: number }) => {
        const z = afterCam.zoom
        return { x: (pp.x - w / 2) / z + afterCam.x, y: (pp.y - h / 2) / z + afterCam.y }
      })(p)
      setCamera((c) => ({ ...c, zoom, x: c.x + (before.x - after.x), y: c.y + (before.y - after.y) }))
    } else {
      // Pan in the same direction as the gesture (content follows fingers).
      setCamera((c) => ({
        ...c,
        x: c.x - e.deltaX / Math.max(0.0001, c.zoom),
        y: c.y - e.deltaY / Math.max(0.0001, c.zoom),
      }))
    }
  }

  const pick = (wpt: { x: number; y: number }): DragTarget | null => {
    const path = src.paths.find((p) => p.id === selectedPathId) ?? src.paths[0]
    if (!path) return null
    const r2 = (10 / camera.zoom) ** 2
    // Handles first
    for (let i = 0; i < path.nodes.length; i++) {
      const n = path.nodes[i]!
      const hin = n.in ?? { x: 0, y: 0 }
      const hout = n.out ?? { x: 0, y: 0 }
      const pin = { x: n.p.x + hin.x, y: n.p.y + hin.y }
      const pout = { x: n.p.x + hout.x, y: n.p.y + hout.y }
      if (dist2(wpt.x, wpt.y, pin.x, pin.y) < r2) return { kind: 'in', pathId: path.id, nodeIdx: i } as const
      if (dist2(wpt.x, wpt.y, pout.x, pout.y) < r2) return { kind: 'out', pathId: path.id, nodeIdx: i } as const
    }
    for (let i = 0; i < path.nodes.length; i++) {
      const n = path.nodes[i]!
      if (dist2(wpt.x, wpt.y, n.p.x, n.p.y) < r2) return { kind: 'node', pathId: path.id, nodeIdx: i } as const
    }
    return null
  }

  const pickEdge = (wpt: { x: number; y: number }): EdgeSel | null => {
    const path = src.paths.find((p) => p.id === selectedPathId) ?? src.paths[0]
    if (!path) return null
    const nodes = path.nodes
    const closed = !!path.closed
    const count = nodes.length
    if (count < 2) return null

    // Hit test against the cubic curves by sampling.
    const maxDist = 12 / camera.zoom
    const maxD2 = maxDist * maxDist
    let best: { aIdx: number; d2: number } | null = null

    const evalCubic = (p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, t: number) => {
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

    const segDist2 = (ax: number, ay: number, bx: number, by: number) => {
      const abx = bx - ax
      const aby = by - ay
      const apx = wpt.x - ax
      const apy = wpt.y - ay
      const ab2 = Math.max(1e-9, abx * abx + aby * aby)
      const t = clamp((apx * abx + apy * aby) / ab2, 0, 1)
      const qx = ax + abx * t
      const qy = ay + aby * t
      return dist2(wpt.x, wpt.y, qx, qy)
    }

    const edgeCount = closed ? count : count - 1
    for (let i = 0; i < edgeCount; i++) {
      const a = nodes[i]!
      const b = nodes[(i + 1) % count]!
      const p0 = a.p
      const p3 = b.p
      const c1 = { x: p0.x + (a.out?.x ?? 0), y: p0.y + (a.out?.y ?? 0) }
      const c2 = { x: p3.x + (b.in?.x ?? 0), y: p3.y + (b.in?.y ?? 0) }

      const steps = 18
      let prev = p0
      for (let k = 1; k <= steps; k++) {
        const t = k / steps
        const p = evalCubic(p0, c1, c2, p3, t)
        const d2 = segDist2(prev.x, prev.y, p.x, p.y)
        if (d2 < (best?.d2 ?? Infinity)) best = { aIdx: i, d2 }
        prev = p
      }
    }

    if (!best || best.d2 > maxD2) return null
    return { pathId: path.id, aIdx: best.aIdx }
  }

  const deleteSelectedVertex = () => {
    if (!selectedNode) return
    const { pathId, nodeIdx } = selectedNode

    applyEdit((draft) => {
      const pIdx = draft.paths.findIndex((p) => p.id === pathId)
      if (pIdx < 0) return draft
      const path = draft.paths[pIdx]!
      if (nodeIdx < 0 || nodeIdx >= path.nodes.length) return draft
      if (path.nodes.length <= 2) {
        // Keep at least 2 nodes for a meaningful segment; delete becomes "clear path".
        const nextPath: TrackPath = { ...path, nodes: [] }
        const paths = draft.paths.slice()
        paths[pIdx] = nextPath
        const nextDraft = { ...draft, paths }
        // selection cleared by caller after state update; safe here.
        return nextDraft
      }

      const nodes = path.nodes.slice()
      nodes.splice(nodeIdx, 1)

      // Re-stitch neighbor handles for a smooth-ish cubic between neighbors.
      const newIdx = clamp(nodeIdx, 0, nodes.length - 1)

      const isStart = newIdx === 0
      const isEnd = newIdx === nodes.length - 1
      if (isStart) {
        // First node has no incoming handle.
        const n0 = nodes[0]!
        nodes[0] = { ...n0, in: { x: 0, y: 0 } }
      } else if (isEnd) {
        // Last node has no outgoing handle.
        const nN = nodes[nodes.length - 1]!
        nodes[nodes.length - 1] = { ...nN, out: { x: 0, y: 0 } }
      } else {
        const a = nodes[newIdx - 1]!
        const b = nodes[newIdx]!
        const vx = b.p.x - a.p.x
        const vy = b.p.y - a.p.y
        const k = 1 / 3
        const outA = { x: vx * k, y: vy * k }
        const inB = { x: -vx * k, y: -vy * k }
        nodes[newIdx - 1] = { ...a, out: outA }
        nodes[newIdx] = { ...b, in: inB }
      }

      const nextPath: TrackPath = { ...path, nodes }
      const paths = draft.paths.slice()
      paths[pIdx] = nextPath
      return { ...draft, paths }
    })

    // Update selection after delete.
    setSelectedNode((sel) => {
      if (!sel) return null
      if (sel.pathId !== pathId) return sel
      return null
    })
    setSelectedEdge(null)
  }

  const deleteSelectedEdge = () => {
    if (!selectedEdge) return
    const { pathId, aIdx } = selectedEdge

    applyEdit((draft) => {
      const pIdx = draft.paths.findIndex((p) => p.id === pathId)
      if (pIdx < 0) return draft
      const path = draft.paths[pIdx]!
      const nodes = path.nodes
      const closed = !!path.closed
      const count = nodes.length
      if (count < 2) return draft

      const edgeCount = closed ? count : count - 1
      if (aIdx < 0 || aIdx >= edgeCount) return draft

      if (closed) {
        // Break loop into one open path by choosing the edge's "next" as new start.
        const bIdx = (aIdx + 1) % count
        const reordered = [...nodes.slice(bIdx), ...nodes.slice(0, bIdx)]
        if (reordered.length > 0) {
          reordered[0] = { ...reordered[0]!, in: { x: 0, y: 0 } }
          reordered[reordered.length - 1] = { ...reordered[reordered.length - 1]!, out: { x: 0, y: 0 } }
        }
        const nextPath: TrackPath = { ...path, closed: false, nodes: reordered }
        const paths = draft.paths.slice()
        paths[pIdx] = nextPath
        return { ...draft, paths }
      }

      // Open path: split into two discontiguous paths at the edge (aIdx -> aIdx+1).
      const leftNodes = nodes.slice(0, aIdx + 1)
      const rightNodes = nodes.slice(aIdx + 1)
      if (leftNodes.length > 0) {
        leftNodes[leftNodes.length - 1] = { ...leftNodes[leftNodes.length - 1]!, out: { x: 0, y: 0 } }
      }
      if (rightNodes.length > 0) {
        rightNodes[0] = { ...rightNodes[0]!, in: { x: 0, y: 0 } }
      }

      const left: TrackPath = { ...path, nodes: leftNodes, closed: false }
      const right: TrackPath = { id: newId('path'), nodes: rightNodes, closed: false }

      const paths = draft.paths.slice()
      paths[pIdx] = left
      paths.splice(pIdx + 1, 0, right)
      return { ...draft, paths }
    })

    setSelectedEdge(null)
    setSelectedNode(null)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.setPointerCapture(e.pointerId)

    // Playtest input goes to game sim state directly.
    if (playtest) {
      const s = stateRef.current
      if (!s) return
      if (!s.dead && !s.finished && s.input.thrustPointerId == null) {
        s.input.thrustPointerId = e.pointerId
        s.input.thrust = true
        startRun(s)
      }
      return
    }

    const rect = canvas.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    const spt = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const wpt = screenToWorld(spt, w, h)

    if (e.button === 1 || tool === 'pan' || e.buttons === 4) {
      dragRef.current = { target: { kind: 'pan' }, startW: wpt, startCam: camera }
      return
    }

    if (tool === 'finish') {
      historyRef.current.past.push(makeSnapshot())
      historyRef.current.future = []
      dragRef.current = { target: { kind: 'finish' }, startW: wpt, startCam: camera }
      return
    }
    if (tool === 'start') {
      historyRef.current.past.push(makeSnapshot())
      historyRef.current.future = []
      // If near velocity handle, drag velocity; else drag start point.
      const sp = src.start.p
      const sv = src.start.v
      const vtip = { x: sp.x + sv.x * 0.6, y: sp.y + sv.y * 0.6 }
      const r2 = (12 / camera.zoom) ** 2
      if (dist2(wpt.x, wpt.y, vtip.x, vtip.y) < r2) {
        dragRef.current = { target: { kind: 'startV' }, startW: wpt, startCam: camera }
      } else {
        dragRef.current = { target: { kind: 'startP' }, startW: wpt, startCam: camera }
      }
      return
    }

    if (tool === 'draw') {
      const pathId = newId('path')
      drawRef.current = { active: true, pts: [{ x: wpt.x, y: wpt.y }], pathId }
      return
    }

    // Select tool
    const hit = pick(wpt)
    if (hit) {
      if (hit.kind === 'node' || hit.kind === 'in' || hit.kind === 'out') {
        setSelectedNode({ pathId: hit.pathId, nodeIdx: hit.nodeIdx })
      }
      setSelectedEdge(null)
      // Push history once at drag start for mutating drags.
      if (hit.kind !== 'pan') {
        historyRef.current.past.push(makeSnapshot())
        historyRef.current.future = []
      }
      dragRef.current = { target: hit, startW: wpt, startCam: camera }
    } else {
      setSelectedNode(null)
      const edge = pickEdge(wpt)
      if (edge) setSelectedEdge(edge)
      else setSelectedEdge(null)
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    const spt = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const wpt = screenToWorld(spt, w, h)

    // Drawing
    if (drawRef.current?.active) {
      const pts = drawRef.current.pts
      const last = pts[pts.length - 1]!
      const minD2 = (8 / camera.zoom) ** 2
      if (dist2(wpt.x, wpt.y, last.x, last.y) > minD2) pts.push({ x: wpt.x, y: wpt.y })
      return
    }

    const drag = dragRef.current
    if (!drag) return

    const dx = wpt.x - drag.startW.x
    const dy = wpt.y - drag.startW.y
    const tgt = drag.target
    if (tgt.kind === 'pan') {
      setCamera({ ...drag.startCam, x: drag.startCam.x - dx, y: drag.startCam.y - dy })
      return
    }
    if (tgt.kind === 'finish') {
      setSrc((s) => ({ ...s, finishX: wpt.x }))
      return
    }
    if (tgt.kind === 'startP') {
      setSrc((s) => ({ ...s, start: { ...s.start, p: { x: wpt.x, y: wpt.y } } }))
      return
    }
    if (tgt.kind === 'startV') {
      setSrc((s) => {
        const sp = s.start.p
        const vx = (wpt.x - sp.x) / 0.6
        const vy = (wpt.y - sp.y) / 0.6
        return { ...s, start: { ...s.start, v: { x: vx, y: vy } } }
      })
      return
    }

    if (tgt.kind === 'node' || tgt.kind === 'in' || tgt.kind === 'out') {
      setSrc((s) => {
        const paths = s.paths.map((p) => {
          if (p.id !== tgt.pathId) return p
          const nodes = p.nodes.map((n, i) => {
            if (i !== tgt.nodeIdx) return n
            if (tgt.kind === 'node') {
              return { ...n, p: { x: wpt.x, y: wpt.y } }
            }
            if (tgt.kind === 'in') {
              const inv = { x: wpt.x - n.p.x, y: wpt.y - n.p.y }
              // Keep symmetric by default (high-end software feel: smooth handles).
              return { ...n, in: inv, out: { x: -inv.x, y: -inv.y } }
            }
            const outv = { x: wpt.x - n.p.x, y: wpt.y - n.p.y }
            return { ...n, out: outv, in: { x: -outv.x, y: -outv.y } }
          })
          return { ...p, nodes }
        })
        return { ...s, paths }
      })
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (canvas) canvas.releasePointerCapture(e.pointerId)

    if (playtest) {
      const s = stateRef.current
      if (s && s.input.thrustPointerId === e.pointerId) {
        s.input.thrustPointerId = null
        s.input.thrust = false
      }
      return
    }

    if (drawRef.current?.active) {
      const { pts, pathId } = drawRef.current
      drawRef.current = null
      if (pts.length >= 2) {
        // Commit draw stroke as one undoable action.
        historyRef.current.past.push(makeSnapshot())
        historyRef.current.future = []
        const ctrl = pts.map((p) => ({ x: p.x, y: p.y }))
        const nodes = nodesFromCatmullCtrl(ctrl)
        const path: TrackPath = { id: pathId, nodes }
        setSrc((s) => ({ ...s, paths: [...s.paths, path] }))
        setSelectedPathId(pathId)
        setSelectedNode({ pathId, nodeIdx: Math.max(0, nodes.length - 1) })
      }
    }

    dragRef.current = null
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // ignore
    }
  }

  const exportTs = () => {
    const safeId = src.id.replace(/[^a-zA-Z0-9_-]/g, '_')
    const name = `TRACK_${safeId.toUpperCase().replace(/-/g, '_')}`
    const payload = JSON.stringify(src, null, 2)
      .replaceAll('"x"', 'x')
      .replaceAll('"y"', 'y') // cosmetic only
    const ts = `// Paste into src/game/track.ts\n// Ensure TrackSource is imported/available.\nexport const ${name}: TrackSource = ${payload} as any;\n`
    void copyText(ts)
  }

  const [saveStatus, setSaveStatus] = useState<string>('')
  const saveToGameFiles = async () => {
    if (!import.meta.env.DEV || (typeof window !== 'undefined' && window.location.hostname !== 'localhost')) {
      setSaveStatus('Save is only available on localhost dev server.')
      return
    }
    setSaveStatus('Saving…')
    try {
      const res = await fetch('/__editor/saveTrack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: src }),
      })
      const json = (await res.json()) as any
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      setSaveStatus(`Saved (${json.count} edited tracks). Reloading…`)
      // Vite will full-reload; keep status briefly.
      setTimeout(() => setSaveStatus(''), 1500)
    } catch (e: any) {
      setSaveStatus(`Save failed: ${String(e?.message ?? e)}`)
    }
  }

  const saveMedalsToTrack = () => {
    applyEdit((draft) => ({
      ...draft,
      medals: { goldMs: Math.round(goldMs), silverMs: Math.round(silverMs), bronzeMs: Math.round(bronzeMs) },
    }))
    setShowMedals(false)
  }

  const tracks = ALL_TRACK_SOURCES
  const canWriteFiles = import.meta.env.DEV && (typeof window === 'undefined' || window.location.hostname === 'localhost')

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't steal shortcuts from text fields.
      const t = e.target as HTMLElement | null
      const tag = t?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (t as any)?.isContentEditable) return

      // Playtest controls: Space toggles thrust (and should NOT activate focused buttons).
      if (playtest) {
        if (e.key === ' ' || e.code === 'Space') {
          const s = stateRef.current
          if (!s) return
          e.preventDefault()
          e.stopPropagation()
          s.input.thrust = true
          if (!s.dead && !s.finished) startRun(s)
        }
        return
      }
      if (showMedals) return

      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()
      if (mod && k === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && k === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        if (selectedNode) deleteSelectedVertex()
        else if (selectedEdge) deleteSelectedEdge()
      }
    }
    window.addEventListener('keydown', onKeyDown, { passive: false })
    return () => window.removeEventListener('keydown', onKeyDown as any)
  }, [deleteSelectedEdge, deleteSelectedVertex, playtest, redo, selectedEdge, selectedNode, showMedals, undo])

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (!playtest) return
      if (e.key === ' ' || e.code === 'Space') {
        const s = stateRef.current
        if (!s) return
        e.preventDefault()
        e.stopPropagation()
        s.input.thrust = false
      }
    }
    window.addEventListener('keyup', onKeyUp, { passive: false })
    return () => window.removeEventListener('keyup', onKeyUp as any)
  }, [playtest])

  return (
    <div className="edRoot">
      <div className="edSidebar">
        <div className="edSidebarHeader">
          <div className="edTitle">Track Editor</div>
        </div>
        <div className="edSidebarBody">
          <div className="edCol">
            <div className="edRow" style={{ justifyContent: 'space-between' }}>
              <button className="edBtn" onClick={() => setPlaytest((x) => !x)}>
                {playtest ? 'Back to Edit' : 'Playtest'}
              </button>
              {playtest && (
                <button className="edBtn edBtnDanger" onClick={() => resetPlaytest()}>
                  Restart
                </button>
              )}
            </div>

            <div className="edRow" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
              {(['select', 'draw', 'pan', 'start', 'finish'] as Tool[]).map((t) => (
                <button
                  key={t}
                  className={`edBtn ${tool === t ? 'edBtnToggleActive' : ''}`}
                  onClick={() => setTool(t)}
                  disabled={playtest}
                >
                  {t}
                </button>
              ))}
            </div>

            <div style={{ marginTop: '0.65rem' }}>
              <div className="edLabel">Track</div>
              <div className="edRow" style={{ justifyContent: 'space-between' }}>
                <button
                  className="edBtn"
                  onClick={() => {
                    const id = `track-${String(Math.floor(Math.random() * 900) + 100)}`
                    const blank: TrackSource = {
                      id,
                      name: 'New Track',
                      start: { p: { x: 40, y: 260 }, v: { x: 220, y: 0 } },
                      finishX: 1200,
                      medals: { bronzeMs: 0, silverMs: 0, goldMs: 0 },
                      coins: [],
                      paths: [{ id: 'p1', nodes: nodesFromCatmullCtrl([{ x: 0, y: 320 }, { x: 1200, y: 320 }]) }],
                      sampleStepPx: 16,
                    }
                    historyRef.current.past.push(makeSnapshot())
                    historyRef.current.future = []
                    setSelectedTrackId(id)
                    setSrc(blank)
                    setSelectedPathId('p1')
                    setSelectedNode(null)
                  }}
                  disabled={playtest}
                >
                  New Track
                </button>
              </div>
              {canWriteFiles && (
                <div className="edRow" style={{ justifyContent: 'space-between', marginTop: '0.4rem' }}>
                  <button className="edBtn edBtnPrimary" onClick={() => void saveToGameFiles()} disabled={playtest}>
                    Save to Game Files
                  </button>
                </div>
              )}
              {saveStatus && (
                <div style={{ marginTop: '0.35rem', fontSize: '0.85rem', opacity: 0.85 }}>{saveStatus}</div>
              )}
              <div className="edList">
                {tracks.map((t) => (
                  <div
                    key={t.id}
                    className={`edListItem ${t.id === selectedTrackId ? 'edListItemActive' : ''}`}
                    onClick={() => setSelectedTrackId(t.id)}
                  >
                    <div style={{ fontWeight: 800 }}>{t.name}</div>
                    <div style={{ opacity: 0.7, fontSize: '0.78rem' }}>{t.id}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: '0.75rem' }}>
              <div className="edLabel">Track meta</div>
              <div className="edCol">
                <label className="edCol">
                  <span className="edLabel">Name</span>
                  <input
                    className="edInput"
                    value={src.name}
                    onChange={(e) => setSrc((s) => ({ ...s, name: e.target.value }))}
                    disabled={playtest}
                  />
                </label>
                <label className="edCol">
                  <span className="edLabel">ID</span>
                  <input
                    className="edInput"
                    value={src.id}
                    onChange={(e) => setSrc((s) => ({ ...s, id: e.target.value }))}
                    disabled={playtest}
                  />
                </label>
              </div>
            </div>

            <div style={{ marginTop: '0.75rem' }}>
              <div className="edLabel">Paths</div>
              <div className="edRow" style={{ justifyContent: 'space-between' }}>
                <button
                  className="edBtn"
                  onClick={() => {
                    const id = newId('path')
                    const p: TrackPath = { id, nodes: [] }
                    applyEdit((draft) => ({ ...draft, paths: [...draft.paths, p] }))
                    setSelectedPathId(id)
                    setSelectedNode(null)
                  }}
                  disabled={playtest}
                >
                  New Path
                </button>
                <button className="edBtn" onClick={() => exportTs()} disabled={playtest}>
                  Copy TS Snippet
                </button>
              </div>

              <div className="edList">
                {src.paths.map((p) => (
                  <div
                    key={p.id}
                    className={`edListItem ${p.id === selectedPathId ? 'edListItemActive' : ''}`}
                    onClick={() => setSelectedPathId(p.id)}
                  >
                    <div style={{ fontWeight: 800 }}>Path</div>
                    <div style={{ opacity: 0.7, fontSize: '0.78rem' }}>{p.id}</div>
                    <div style={{ opacity: 0.6, fontSize: '0.78rem' }}>{p.nodes.length} nodes</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: '0.75rem' }}>
              <div className="edLabel">Medals (authored)</div>
              <div className="edCol">
                <div className="edRow">
                  <span style={{ width: 70, opacity: 0.8 }}>Gold</span>
                  <input
                    className="edInput"
                    type="text"
                    inputMode="decimal"
                    placeholder="00.00"
                    value={medalEdit.gold}
                    onChange={(e) => setMedalEdit((m) => ({ ...m, gold: e.target.value }))}
                    onBlur={() => {
                      const v = parseSec2ToMs(medalEdit.gold)
                      if (v == null) {
                        setMedalEdit((m) => ({ ...m, gold: fmtSec2(src.medals.goldMs) }))
                        return
                      }
                      applyEdit((d) => ({ ...d, medals: { ...d.medals, goldMs: v } }))
                    }}
                    disabled={playtest}
                  />
                </div>
                <div className="edRow">
                  <span style={{ width: 70, opacity: 0.8 }}>Silver</span>
                  <input
                    className="edInput"
                    type="text"
                    inputMode="decimal"
                    placeholder="00.00"
                    value={medalEdit.silver}
                    onChange={(e) => setMedalEdit((m) => ({ ...m, silver: e.target.value }))}
                    onBlur={() => {
                      const v = parseSec2ToMs(medalEdit.silver)
                      if (v == null) {
                        setMedalEdit((m) => ({ ...m, silver: fmtSec2(src.medals.silverMs) }))
                        return
                      }
                      applyEdit((d) => ({ ...d, medals: { ...d.medals, silverMs: v } }))
                    }}
                    disabled={playtest}
                  />
                </div>
                <div className="edRow">
                  <span style={{ width: 70, opacity: 0.8 }}>Bronze</span>
                  <input
                    className="edInput"
                    type="text"
                    inputMode="decimal"
                    placeholder="00.00"
                    value={medalEdit.bronze}
                    onChange={(e) => setMedalEdit((m) => ({ ...m, bronze: e.target.value }))}
                    onBlur={() => {
                      const v = parseSec2ToMs(medalEdit.bronze)
                      if (v == null) {
                        setMedalEdit((m) => ({ ...m, bronze: fmtSec2(src.medals.bronzeMs) }))
                        return
                      }
                      applyEdit((d) => ({ ...d, medals: { ...d.medals, bronzeMs: v } }))
                    }}
                    disabled={playtest}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="edMain">
        <canvas
          ref={canvasRef}
          className="edCanvas"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />

        {showMedals && (
          <div className="edModalScrim">
            <div className="edModal" role="dialog" aria-modal="true">
              <div className="edModalTitle">Validation: set author/medal times</div>
              <div style={{ marginTop: '0.55rem', opacity: 0.9 }}>
                Finished time (author run): <b>{fmtMs(authorMs)}</b>
              </div>

              <div className="edCol" style={{ marginTop: '0.65rem' }}>
                <div className="edRow">
                  <span style={{ width: 86 }}>Gold</span>
                  <input
                    className="edInput"
                    type="text"
                    inputMode="decimal"
                    placeholder="00.00"
                    value={goldText}
                    onChange={(e) => {
                      const t = e.target.value
                      setGoldText(t)
                      const v = parseSec2ToMs(t)
                      if (v != null) setGoldMs(v)
                    }}
                  />
                  <span style={{ width: 70, opacity: 0.75 }}>{goldText}</span>
                </div>
                <div className="edRow">
                  <span style={{ width: 86 }}>Silver</span>
                  <input
                    className="edInput"
                    type="text"
                    inputMode="decimal"
                    placeholder="00.00"
                    value={silverText}
                    onChange={(e) => {
                      const t = e.target.value
                      setSilverText(t)
                      const v = parseSec2ToMs(t)
                      if (v != null) setSilverMs(v)
                    }}
                  />
                  <span style={{ width: 70, opacity: 0.75 }}>{silverText}</span>
                </div>
                <div className="edRow">
                  <span style={{ width: 86 }}>Bronze</span>
                  <input
                    className="edInput"
                    type="text"
                    inputMode="decimal"
                    placeholder="00.00"
                    value={bronzeText}
                    onChange={(e) => {
                      const t = e.target.value
                      setBronzeText(t)
                      const v = parseSec2ToMs(t)
                      if (v != null) setBronzeMs(v)
                    }}
                  />
                  <span style={{ width: 70, opacity: 0.75 }}>{bronzeText}</span>
                </div>
              </div>

              <div className="edModalActions">
                <button
                  className="edBtn"
                  onClick={() => {
                    setShowMedals(false)
                    resetPlaytest()
                  }}
                >
                  Restart
                </button>
                <button className="edBtn" onClick={() => setShowMedals(false)}>
                  Keep Playing
                </button>
                <button className="edBtn edBtnPrimary" onClick={() => saveMedalsToTrack()}>
                  Save to Track
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="edOverlayTopRight">
          <a className="edBtn" href="/">
            Game
          </a>
        </div>
      </div>
    </div>
  )
}


