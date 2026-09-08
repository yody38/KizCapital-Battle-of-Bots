-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Migracion 004: bitacora de eventos
-- Run this in: Supabase Dashboard → SQL Editor, o `scripts/migrate.py --apply`.
-- Idempotent: re-runs are safe.
--
-- Que responde y snapshot.json no puede: "cuando y por que este bot dejo de
-- ser READY", "que dia se movio de maquina", "cuantas veces ha entrado y
-- salido de decay". La tabla diaria guarda ESTADOS; esta guarda TRANSICIONES,
-- que es lo unico que contesta un "por que cambio".
--
-- Solo se escribe cuando algo CAMBIA respecto del ciclo anterior
-- (data/shadow/db_state.json). Un ciclo en el que nada se movio no inserta
-- ni una fila — por eso la tabla es de crecimiento despreciable.
--
-- TIPOS DE EVENTO PERMITIDOS (contrato con scripts/publish_metrics_db.py):
--   first_seen      el bot aparece por primera vez en el censo
--   status_change   promotion_status cambio (p.ej. 'NEAR' -> 'READY')
--   seat_change     entro o salio del top de asientos (READY cap)
--   vps_move        cambio de maquina — su identidad NO cambia (ver 002)
--   dormant         dejo de aparecer en el snapshot / sin trades nuevos
--   decay_flag      decay_flag paso de false a true, o al reves
--   drift_flag      drift.flag (Page-Hinkley) paso de false a true, o al reves
--   missing         estaba en el censo y este ciclo no vino en el snapshot
--   real_promoted   paso de cuenta demo a cuenta real
-- Deliberadamente SIN check constraint: un tipo nuevo no debe poder tumbar
-- un ciclo. El contrato se valida en el escritor y en los tests.
-- =====================================================================

create table if not exists public.bot_events (
  id           bigserial primary key,
  bot_key      text not null,
  event_type   text not null,
  from_value   text,
  to_value     text,
  cycle_sha    text,
  occurred_at  timestamptz not null default now(),
  detail       jsonb
);

create index if not exists idx_bot_events_bot_time
  on public.bot_events (bot_key, occurred_at desc);
create index if not exists idx_bot_events_type_time
  on public.bot_events (event_type, occurred_at desc);

comment on table public.bot_events is
  'Bitacora de transiciones por bot. Tipos: first_seen, status_change, '
  'seat_change, vps_move, dormant, decay_flag, drift_flag, missing, '
  'real_promoted. Escrituras exclusivamente desde CI con service_role.';

alter table public.bot_events enable row level security;

drop policy if exists "whitelisted users can read bot events" on public.bot_events;
create policy "whitelisted users can read bot events"
  on public.bot_events for select
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
--   select event_type, count(*) from public.bot_events group by 1 order by 2 desc;
--   select * from public.bot_events order by occurred_at desc limit 20;
-- =====================================================================
