-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Señal de push del snapshot (auto-refresh)
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run
-- Idempotent: re-runs are safe.
--
-- Purpose: fila única (id=1) que upload_to_supabase.py upserta al final de
-- cada ciclo de CI con el sha256 de snapshot.json. El dashboard se suscribe
-- vía Realtime (+ poll de respaldo de 1 fila/min) y recarga el snapshot solo
-- cuando el sha cambia — sin reload manual ni esperar al próximo boot.
-- =====================================================================

create table if not exists public.snapshot_meta (
  id            smallint primary key default 1 check (id = 1),
  ts            timestamptz not null default now(),
  manifest_sha  text not null
);

-- Server-side timestamp (mismo patrón que live_real_state).
create or replace function public.snapshot_meta_set_ts() returns trigger as $$
begin
  new.ts := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_snapshot_meta_ts on public.snapshot_meta;
create trigger trg_snapshot_meta_ts
  before insert or update on public.snapshot_meta
  for each row execute function public.snapshot_meta_set_ts();

alter table public.snapshot_meta enable row level security;

drop policy if exists "whitelisted users can read snapshot meta" on public.snapshot_meta;
create policy "whitelisted users can read snapshot meta"
  on public.snapshot_meta for select
  to authenticated
  using (
    exists (
      select 1 from public.allowed_emails ae
      where lower(ae.email) = lower((auth.jwt() ->> 'email'))
    )
  );

-- Writes exclusivamente desde CI con service_role (bypassa RLS).

-- Realtime: broadcast del cambio de sha a los dashboards abiertos.
do $$ begin
  alter publication supabase_realtime add table public.snapshot_meta;
exception when duplicate_object then null;  -- ya estaba en la publication
end $$;

-- =====================================================================
-- DONE. Verify with:
--   select id, ts, manifest_sha,
--          extract(epoch from (now() - ts)) as age_seconds
--     from public.snapshot_meta;
-- age_seconds < ~2100 (35 min) en operación normal.
-- =====================================================================
