-- Slopes Daily Leaderboard
-- Paste into Supabase SQL editor and run.

-- 1) Table
create table if not exists public.daily_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  date_key text not null,
  track_version integer not null,
  time_ms integer not null check (time_ms > 0),
  name text not null,
  replay jsonb not null
);

create index if not exists daily_runs_date_idx on public.daily_runs (date_key, track_version, time_ms asc, created_at asc);

-- 2) RLS
alter table public.daily_runs enable row level security;

-- Anyone can read runs (required for global leaderboard + replay viewing)
drop policy if exists "public read daily_runs" on public.daily_runs;
create policy "public read daily_runs"
on public.daily_runs for select
using (true);

-- Anyone can submit a run (anon is OK for now)
drop policy if exists "public insert daily_runs" on public.daily_runs;
create policy "public insert daily_runs"
on public.daily_runs for insert
with check (true);

-- 3) RPC: top 5 with rank
create or replace function public.daily_top5(p_date_key text, p_track_version integer)
returns table (
  id uuid,
  date_key text,
  track_version integer,
  time_ms integer,
  name text,
  replay jsonb,
  created_at timestamptz,
  rank integer
)
language sql
stable
as $$
  with ranked as (
    select
      r.*,
      row_number() over (order by r.time_ms asc, r.created_at asc, r.id asc) as rank
    from public.daily_runs r
    where r.date_key = p_date_key
      and r.track_version = p_track_version
  )
  select
    ranked.id,
    ranked.date_key,
    ranked.track_version,
    ranked.time_ms,
    ranked.name,
    ranked.replay,
    ranked.created_at,
    ranked.rank
  from ranked
  order by ranked.rank asc
  limit 5;
$$;

-- 4) RPC: around a specific run (2 above + self + 2 below)
create or replace function public.daily_around(
  p_date_key text,
  p_track_version integer,
  p_run_id uuid,
  p_window integer
)
returns table (
  id uuid,
  date_key text,
  track_version integer,
  time_ms integer,
  name text,
  replay jsonb,
  created_at timestamptz,
  rank integer
)
language sql
stable
as $$
  with ranked as (
    select
      r.*,
      row_number() over (order by r.time_ms asc, r.created_at asc, r.id asc) as rank
    from public.daily_runs r
    where r.date_key = p_date_key
      and r.track_version = p_track_version
  ),
  me as (
    select rank from ranked where id = p_run_id
  )
  select
    ranked.id,
    ranked.date_key,
    ranked.track_version,
    ranked.time_ms,
    ranked.name,
    ranked.replay,
    ranked.created_at,
    ranked.rank
  from ranked
  cross join me
  where ranked.rank between me.rank - p_window and me.rank + p_window
  order by ranked.rank asc;
$$;


