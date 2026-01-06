import { useEffect, useMemo, useRef, useState } from 'react'
import { getGenerator, TRACK_GENERATORS, type TrackGeneratorId } from '../game/trackGenerators'
import { renderTrackImage } from '../render/trackImage'

const mul32 = (a: number, b: number) => Math.imul(a, b) >>> 0
const mixSeed = (base: number, i: number) => {
  // LCG-ish mix: stable across runs and spreads nearby seeds well enough for previews.
  let x = (base ^ mul32(i + 1, 0x9e3779b1)) >>> 0
  x = (x + 0x7f4a7c15) >>> 0
  x ^= x >>> 16
  x = mul32(x, 0x85ebca6b)
  x ^= x >>> 13
  x = mul32(x, 0xc2b2ae35)
  x ^= x >>> 16
  return x >>> 0
}

const parseSeed = (s: string) => {
  const t = s.trim().toLowerCase()
  if (t.startsWith('0x')) {
    const n = Number.parseInt(t.slice(2), 16)
    return Number.isFinite(n) ? (n >>> 0) : null
  }
  const n = Number.parseInt(t, 10)
  return Number.isFinite(n) ? (n >>> 0) : null
}

type ImgOut = { seed: number; name: string; url: string }

export const TrackGenTool = () => {
  const [algo, setAlgo] = useState<TrackGeneratorId>('daily-v1')
  const [seedStr, setSeedStr] = useState('12345')
  const [planeMode, setPlaneMode] = useState<'random' | 'flat' | 'max'>('random')
  const [imgs, setImgs] = useState<ImgOut[]>([])
  const revokeRef = useRef<string[]>([])

  const baseSeed = useMemo(() => parseSeed(seedStr), [seedStr])
  const gen = useMemo(() => getGenerator(algo), [algo])

  useEffect(() => {
    return () => {
      for (const u of revokeRef.current) URL.revokeObjectURL(u)
      revokeRef.current = []
    }
  }, [])

  const generate10 = async () => {
    // Cleanup previous URLs.
    for (const u of revokeRef.current) URL.revokeObjectURL(u)
    revokeRef.current = []

    const base = baseSeed ?? 0
    const out: ImgOut[] = []
    for (let i = 0; i < 10; i++) {
      const seed = mixSeed(base, i)
      // Match game defaults: enforced gaps + boosts.
      const planeDeg = planeMode === 'flat' ? 0 : planeMode === 'max' ? 30 : null
      const track = gen.generate(seed, { enableGaps: true, enableBoosts: true, planeDeg })

      const canvas = document.createElement('canvas')
      renderTrackImage(canvas, track, { width: 1600, height: 900, padPx: 28 })

      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
      if (!blob) continue
      const url = URL.createObjectURL(blob)
      revokeRef.current.push(url)

      const name = `track_${gen.id}_seed-${seed.toString(16).padStart(8, '0')}.png`
      out.push({ seed, name, url })
    }
    setImgs(out)
  }

  const downloadAll = async () => {
    // Browsers may block multi-download unless the user allows it; we still attempt sequential clicks.
    for (const img of imgs) {
      const a = document.createElement('a')
      a.href = img.url
      a.download = img.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0B0A16', color: '#fff6d5', padding: '1rem' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gap: '1rem' }}>
        <div>
          <div style={{ fontWeight: 950, fontSize: '1.35rem', letterSpacing: '0.02em' }}>Track Gen Tool</div>
          <div style={{ opacity: 0.75, marginTop: 6 }}>
            Generate 10 track images for quick iteration. Open via <code>?tool=trackgen</code>.
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '0.75rem 1rem',
            alignItems: 'end',
            padding: '0.9rem',
            borderRadius: 14,
            background: 'rgba(12,10,28,0.55)',
            border: '1px solid rgba(255,255,255,0.10)',
          }}
        >
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontWeight: 900, opacity: 0.9 }}>Algorithm</span>
            <select
              value={algo}
              onChange={(e) => setAlgo(e.target.value as TrackGeneratorId)}
              style={{
                borderRadius: 12,
                border: '1px solid rgba(255,245,200,0.22)',
                background: 'rgba(12,10,28,0.55)',
                color: '#fff6d5',
                padding: '0.55rem 0.7rem',
                outline: 'none',
              }}
            >
              {TRACK_GENERATORS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontWeight: 900, opacity: 0.9 }}>Base seed</span>
            <input
              value={seedStr}
              onChange={(e) => setSeedStr(e.target.value)}
              placeholder="12345 or 0xDEADBEEF"
              style={{
                borderRadius: 12,
                border: '1px solid rgba(255,245,200,0.22)',
                background: 'rgba(12,10,28,0.55)',
                color: '#fff6d5',
                padding: '0.55rem 0.7rem',
                outline: 'none',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              }}
            />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontWeight: 900, opacity: 0.9 }}>Plane tilt</span>
            <select
              value={planeMode}
              onChange={(e) => setPlaneMode(e.target.value as any)}
              style={{
                borderRadius: 12,
                border: '1px solid rgba(255,245,200,0.22)',
                background: 'rgba(12,10,28,0.55)',
                color: '#fff6d5',
                padding: '0.55rem 0.7rem',
                outline: 'none',
              }}
            >
              <option value="random">Random (1°–30°)</option>
              <option value="flat">Flat (0°)</option>
              <option value="max">Max downslope (30°)</option>
            </select>
          </label>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', userSelect: 'none', opacity: 0.85 }}>
            <span style={{ fontWeight: 900 }}>Defaults:</span>
            <span style={{ fontWeight: 850 }}>gaps enforced</span>
            <span style={{ opacity: 0.55 }}>•</span>
            <span style={{ fontWeight: 850 }}>boosters enforced</span>
          </div>

          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
            <button
              type="button"
              onClick={generate10}
              style={{
                borderRadius: 999,
                border: '1px solid rgba(255,245,200,0.26)',
                background: 'rgba(255,246,213,0.10)',
                color: '#fff6d5',
                padding: '0.55rem 0.85rem',
                fontWeight: 950,
                cursor: 'pointer',
              }}
            >
              Generate 10
            </button>
            <button
              type="button"
              disabled={imgs.length === 0}
              onClick={downloadAll}
              style={{
                borderRadius: 999,
                border: '1px solid rgba(120,180,255,0.25)',
                background: 'rgba(120,180,255,0.10)',
                color: imgs.length === 0 ? 'rgba(255,246,213,0.45)' : '#fff6d5',
                padding: '0.55rem 0.85rem',
                fontWeight: 950,
                cursor: imgs.length === 0 ? 'default' : 'pointer',
              }}
            >
              Download all
            </button>
          </div>

          <div style={{ opacity: 0.75, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>
            Base seed parsed: {baseSeed == null ? '(invalid)' : `0x${baseSeed.toString(16).padStart(8, '0')}`}
          </div>
        </div>

        {imgs.length > 0 && (
          <div style={{ display: 'grid', gap: '0.8rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'baseline' }}>
              <div style={{ fontWeight: 950 }}>Output</div>
              <div style={{ opacity: 0.7 }}>{imgs.length} images</div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.8rem' }}>
              {imgs.map((img) => (
                <div
                  key={img.url}
                  style={{
                    borderRadius: 14,
                    overflow: 'hidden',
                    border: '1px solid rgba(255,255,255,0.10)',
                    background: 'rgba(12,10,28,0.55)',
                  }}
                >
                  <div style={{ padding: '0.65rem 0.75rem', display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <div style={{ display: 'grid', gap: 2 }}>
                      <div style={{ fontWeight: 900, opacity: 0.9, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>
                        0x{img.seed.toString(16).padStart(8, '0')}
                      </div>
                      <div style={{ opacity: 0.7, fontSize: '0.85rem' }}>{img.name}</div>
                    </div>
                    <a
                      href={img.url}
                      download={img.name}
                      style={{
                        alignSelf: 'start',
                        textDecoration: 'none',
                        borderRadius: 999,
                        border: '1px solid rgba(255,245,200,0.22)',
                        padding: '0.45rem 0.7rem',
                        color: '#fff6d5',
                        fontWeight: 900,
                      }}
                    >
                      Download
                    </a>
                  </div>
                  <img src={img.url} alt={img.name} style={{ width: '100%', display: 'block' }} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


