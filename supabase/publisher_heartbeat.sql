-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Heartbeat activo del live publisher
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run
-- Idempotent: re-runs are safe.
--
-- Purpose: cada ciclo (~3s) live_publisher.py upserta una fila por publisher.
-- Permite distinguir causa raíz cuando el live stream se enfría:
--   heartbeat fresco + published vacío  → MT5/broker caído (publisher vivo)
--   heartbeat viejo                     → proceso/SSH/Railway caído
-- Leído por integrity_watchdog.py (service key) y opcionalmente el dashboard.
-- =====================================================================

create table if not exists public.publisher_heartbeat (
  publisher_id     text primary key,
  vps              text not null,
  ts               timestamptz not null default now(),
  cycle_ms         integer,
  published_logins jsonb,
  missing_streak   jsonb,
  interval_secs    numeric(6,2)
);

-- Server-side timestamp (mismo patrón que live_real_state): inmune al clock
-- skew del Windows VPS y a replays.
create or replace function public.publisher_heartbeat_set_ts() returns trigger as $$
begin
  new.ts := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_publisher_heartbeat_ts on public.publisher_heartbeat;
create trigger trg_publisher_heartbeat_ts
  before insert or update on public.publisher_heartbeat
  for each row execute function public.publisher_heartbeat_set_ts();

alter table public.publisher_heartbeat enable row level security;

drop policy if exists "whitelisted users can read publisher heartbeat" on public.publisher_heartbeat;
create policy "whitelisted users can read publisher heartbeat"
  on public.publisher_heartbeat for select
  to authenticated
  using (
    exists (
      select 1 from public.allowed_emails ae
      where lower(ae.email) = lower((auth.jwt() ->> 'email'))
    )
  );

-- Writes exclusivamente desde el publisher con service_role (bypassa RLS).

-- =====================================================================
-- DONE. Verify with:
--   select publisher_id, vps, ts, cycle_ms,
--          extract(epoch from (now() - ts)) as age_seconds
--     from public.publisher_heartbeat;
-- age_seconds < 10 en operación normal.
-- =====================================================================
