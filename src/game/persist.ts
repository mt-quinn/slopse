import type { GhostRun } from './state'

const keyBestTime = (trackId: string) => `slopes-best-time-${trackId}`
const keyBestGhost = (trackId: string) => `slopes-best-ghost-${trackId}`

export const loadBestTimeMs = (trackId: string): number | null => {
  try {
    const raw = window.localStorage.getItem(keyBestTime(trackId))
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export const saveBestTimeMs = (trackId: string, timeMs: number) => {
  try {
    window.localStorage.setItem(keyBestTime(trackId), String(Math.max(0, Math.round(timeMs))))
  } catch {
    // best-effort
  }
}

export const loadBestGhost = (trackId: string, trackHash?: string): GhostRun | null => {
  try {
    const raw = window.localStorage.getItem(keyBestGhost(trackId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as GhostRun
    if (!parsed || parsed.version !== 1) return null
    if (parsed.trackId !== trackId) return null
    if (trackHash && parsed.trackHash !== trackHash) return null
    if (!Array.isArray(parsed.samples)) return null
    return parsed
  } catch {
    return null
  }
}

export const saveBestGhost = (trackId: string, run: GhostRun) => {
  try {
    window.localStorage.setItem(keyBestGhost(trackId), JSON.stringify(run))
  } catch {
    // best-effort
  }
}


