const keyCompleted = () => `slopes-completed-tracks-v1`

export const loadCompletedTrackIds = (): Set<string> => {
  try {
    const raw = window.localStorage.getItem(keyCompleted())
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as string[]
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((x) => typeof x === 'string' && x.length > 0))
  } catch {
    return new Set()
  }
}

export const saveCompletedTrackIds = (ids: Set<string>) => {
  try {
    window.localStorage.setItem(keyCompleted(), JSON.stringify([...ids]))
  } catch {
    // best-effort
  }
}


