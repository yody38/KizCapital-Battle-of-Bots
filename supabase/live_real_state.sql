-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Live equity stream for REAL accounts
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run
-- Idempotent: re-runs are safe.
--
-- Purpose: <5s push of equity / balance / floating P&L / open positions
-- for the 2 real accounts on VPS5 (#25425 and #32081). Written by
-- C:\mt5-mcp\live_publisher.py via service_role key. Read by the dashboard
-- via Supabase Realtime subscription using the anon key + RLS.
-- =====================================================================

create table if not exists public.live_real_state (
  login         bigint primary key,
  vps           text not null,
  ts            timestamptz not null default now(),
  balance       numeric(14,2),
  equity        numeric(14,2),
  margin        numeric(14,2),
  free_margin   numeric(14,2),
  profit        numeric(14,2),
  positions     jsonb,
  source_age_ms integer,
  publisher_id  text
);

create index if not exists idx_live_real_state_ts on public.live_real_state (ts desc);

alter table public.live_real_state enable row level security;

-- Whitelisted authenticated users can read (same gate as the dashboard data bucket).
drop policy if exists "whitelisted users can read live state" on public.live_real_state;
create policy "whitelisted users can read live state"
  on public.live_real_state for select
  to authenticated
  using (
    exists (
      select 1 from public.allowed_emails ae
      where lower(ae.email) = lower((auth.jwt() ->> 'email'))
    )
  );

-- Writes happen exclusively from the VPS publisher with the service_role key.
-- service_role bypasses RLS, so no insert/update policies are needed.

-- Realtime: broadcast row changes to subscribed clients.
alter publication supabase_realtime add table public.live_real_state;

-- =====================================================================
-- DONE. Verify with:
--   select login, vps, ts, balance, equity, profit,
--          extract(epoch from (now() - ts)) as age_seconds
--     from public.live_real_state;
--
-- The publisher should keep age_seconds < 8 at all times.
-- =====================================================================
