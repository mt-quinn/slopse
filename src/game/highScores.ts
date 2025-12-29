export type TimeEntry = {
  name: string
  timeMs: number
  ts: number
}

const keyScores = (trackId: string) => `slopes-times-top5-${trackId}`
const keyLastName = () => `slopes-player-name`

export const loadLastPlayerName = (): string => {
  try {
    return window.localStorage.getItem(keyLastName()) ?? ''
  } catch {
    return ''
  }
}

export const saveLastPlayerName = (name: string) => {
  try {
    window.localStorage.setItem(keyLastName(), name)
  } catch {
    // best-effort
  }
}

export const loadTopTimes = (trackId: string): TimeEntry[] => {
  try {
    const raw = window.localStorage.getItem(keyScores(trackId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as TimeEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e) => e && typeof e.name === 'string' && typeof e.timeMs === 'number' && typeof e.ts === 'number')
      .filter((e) => Number.isFinite(e.timeMs) && e.timeMs > 0)
      .sort((a, b) => a.timeMs - b.timeMs || a.ts - b.ts)
      .slice(0, 5)
  } catch {
    return []
  }
}

export const saveTopTimes = (trackId: string, entries: TimeEntry[]) => {
  try {
    window.localStorage.setItem(keyScores(trackId), JSON.stringify(entries.slice(0, 5)))
  } catch {
    // best-effort
  }
}

export const qualifiesTop5 = (trackId: string, timeMs: number): boolean => {
  if (!Number.isFinite(timeMs) || timeMs <= 0) return false
  const cur = loadTopTimes(trackId)
  if (cur.length < 5) return true
  const worst = cur[cur.length - 1]!
  return timeMs < worst.timeMs
}

export const addTopTime = (trackId: string, entry: Omit<TimeEntry, 'ts'> & { ts?: number }) => {
  const ts = entry.ts ?? Date.now()
  const next: TimeEntry[] = [...loadTopTimes(trackId), { name: entry.name, timeMs: entry.timeMs, ts }]
    .sort((a, b) => a.timeMs - b.timeMs || a.ts - b.ts)
    .slice(0, 5)
  saveTopTimes(trackId, next)
  return next
}


