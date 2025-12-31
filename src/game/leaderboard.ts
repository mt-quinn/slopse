import { createClient } from '@supabase/supabase-js'
import type { GhostRun } from './state'
import { DAILY_TRACK_VERSION } from './track'

// Prefer env vars, but fall back to the provided publishable credentials.
const SUPABASE_URL =
  (import.meta as any).env?.VITE_SUPABASE_URL ??
  'https://yntlvciswhbzsgvrkshk.supabase.co'

const SUPABASE_ANON_KEY =
  (import.meta as any).env?.VITE_SUPABASE_ANON_KEY ??
  'sb_publishable_HZqoDB-pkFpwoSNBSLio9w_nQMXNcqe'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

export type DailyRunRow = {
  id: string
  date_key: string
  track_version: number
  time_ms: number
  name: string
  replay: GhostRun
  created_at: string
}

export type RankedRun = DailyRunRow & { rank: number }

const lsKeyName = `slopes-lb-name`
const lsKeySubmitted = (dateKey: string) => `slopes-lb-submitted-${dateKey}-v${DAILY_TRACK_VERSION}`

export const loadLastLbName = () => {
  try {
    return window.localStorage.getItem(lsKeyName) ?? ''
  } catch {
    return ''
  }
}

export const saveLastLbName = (name: string) => {
  try {
    window.localStorage.setItem(lsKeyName, name)
  } catch {
    // best-effort
  }
}

export const loadSubmittedRunId = (dateKey: string) => {
  try {
    return window.localStorage.getItem(lsKeySubmitted(dateKey)) ?? null
  } catch {
    return null
  }
}

export const saveSubmittedRunId = (dateKey: string, runId: string) => {
  try {
    window.localStorage.setItem(lsKeySubmitted(dateKey), runId)
  } catch {
    // best-effort
  }
}

export const submitDailyRun = async (p: { dateKey: string; name: string; timeMs: number; replay: GhostRun }) => {
  const name = p.name.trim().slice(0, 16) || 'Player'
  const payload = {
    date_key: p.dateKey,
    track_version: DAILY_TRACK_VERSION,
    time_ms: Math.max(1, Math.round(p.timeMs)),
    name,
    replay: p.replay,
  }

  const { data, error } = await supabase
    .from('daily_runs')
    .insert(payload as any)
    .select('id')
    .single()

  if (error) throw error
  return { id: data!.id as string, name }
}

export const fetchDailyTop5 = async (dateKey: string): Promise<RankedRun[]> => {
  const { data, error } = await supabase.rpc('daily_top5', { p_date_key: dateKey, p_track_version: DAILY_TRACK_VERSION })
  if (error) throw error
  return (data ?? []) as RankedRun[]
}

export const fetchDailyAround = async (dateKey: string, runId: string): Promise<RankedRun[]> => {
  const { data, error } = await supabase.rpc('daily_around', {
    p_date_key: dateKey,
    p_track_version: DAILY_TRACK_VERSION,
    p_run_id: runId,
    p_window: 2,
  })
  if (error) throw error
  return (data ?? []) as RankedRun[]
}

export const fetchDailyRunById = async (runId: string): Promise<DailyRunRow | null> => {
  const { data, error } = await supabase
    .from('daily_runs')
    .select('id,date_key,track_version,time_ms,name,replay,created_at')
    .eq('id', runId)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as any) ?? null
}


