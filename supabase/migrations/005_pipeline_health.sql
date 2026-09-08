-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Migracion 005: salud del pipeline
-- Run this in: Supabase Dashboard → SQL Editor, o `scripts/migrate.py --apply`.
-- Idempotent: re-runs are safe.
--
-- Que responde y los archivos no pueden: "cuantos ciclos fallaron esta
-- semana", "desde cuando este VPS llega tarde", "el ciclo lento de ayer fue
-- un pico o una tendencia". data/pipeline_timing.json guarda percentiles de
-- las ultimas 200 corridas y se sobrescribe; los artifacts de GH Actions
-- caducan a los 90 dias. Aqui el historial es permanente y consultable.
--
-- La clave primaria es el `run_id` de GitHub Actions, que ya es unico y
-- monotono: re-ejecutar el mismo run hace UPSERT en vez de duplicar. En una
-- corrida local (sin GITHUB_RUN_ID) el escritor omite esta fila en vez de
-- inventarse un id — un numero falso aqui contamina las estadisticas.
-- =====================================================================

create table if not exists public.pipeline_health (
  run_id        bigint primary key,      -- GITHUB_RUN_ID
  started_at    timestamptz,
  finished_at   timestamptz,
  cycle_sha     text,
  ok            boolean,
  stages        jsonb,                   -- data/pipeline_timing.json -> cycle{}: *_ms por etapa
  bots          integer,
  vps_stale     integer,
  partial_data  boolean,
  verify_rc     integer
);

create index if not exists idx_pipeline_health_finished
  on public.pipeline_health (finished_at desc);

comment on table public.pipeline_health is
  'Una fila por ejecucion del pipeline (run_id de GitHub Actions). '
  'Escrituras exclusivamente desde CI con service_role.';
comment on column public.pipeline_health.stages is
  'Latencias por etapa en ms tal cual las emite scripts/emit_timing.py.';

alter table public.pipeline_health enable row level security;

drop policy if exists "whitelisted users can read pipeline health" on public.pipeline_health;
create policy "whitelisted users can read pipeline health"
  on public.pipeline_health for select
  to authenticated
  using (
    exists (
      select 1 from public.allowed_emails ae
      where lower(ae.email) = lower((auth.jwt() ->> 'email'))
    )
  );

-- Writes exclusivamente desde CI con service_role (bypassa RLS).

-- =====================================================================
-- DONE. Verify with:
--   select run_id, finished_at, ok, bots, vps_stale, partial_data
--     from public.pipeline_health order by finished_at desc limit 20;
-- =====================================================================
