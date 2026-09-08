-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Migracion 002: censo de bots
-- Run this in: Supabase Dashboard → SQL Editor, o `scripts/migrate.py --apply`.
-- Idempotent: re-runs are safe.
--
-- Que responde esta tabla y snapshot.json no puede: "cuando aparecio este
-- bot por primera vez", "sigue vivo", "en que maquina estaba antes". El
-- snapshot es una FOTO: se sobrescribe cada 15 min y no recuerda nada.
--
-- LA CLAVE NO LLEVA EL VPS — a proposito (2026-09-08).
-- `bot_key` = '<login>-<magic>'. El renumerado del 2026-07-27 demostro que
-- una etiqueta de VPS no es una identidad: las mismas cuentas cambiaron de
-- nombre de maquina de un dia para otro (vps5→vps3, vps3→vps1, ...). Si el
-- VPS entrara en la clave primaria, ese renumerado habria duplicado los 623
-- bots y partido su historia en dos mitades incomparables. El VPS es un
-- ATRIBUTO que se mueve (columna `vps` + evento `vps_move`), no la identidad.
-- Ojo: el backend en memoria usa '<vps>-<login>-<magic>' (tests/fixtures/
-- synth.py:bot_key) porque solo le importa el ciclo actual; aqui, donde el
-- dato sobrevive al renumerado, la clave DEBE ser mas estrecha.
-- =====================================================================

create table if not exists public.bot_registry (
  bot_key      text primary key,             -- '<login>-<magic>' — sin VPS, ver arriba
  login        bigint not null,
  magic        bigint not null,
  vps          text not null,                -- ultima maquina conocida; cambia sin partir la historia
  symbols      text[],
  is_real      boolean not null default false,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  first_trade  timestamptz,
  active       boolean not null default true,
  meta         jsonb
);

create unique index if not exists idx_bot_registry_login_magic
  on public.bot_registry (login, magic);
create index if not exists idx_bot_registry_vps
  on public.bot_registry (vps);

comment on table public.bot_registry is
  'Censo de bots por identidad estable (login+magic, SIN vps). Escrituras '
  'exclusivamente desde CI con service_role — no hay politicas de insert/update.';
comment on column public.bot_registry.bot_key is
  'login-magic. Excluye el VPS a proposito: un bot puede cambiar de maquina '
  '(renumerado 2026-07-27) sin dejar de ser el mismo bot.';

alter table public.bot_registry enable row level security;

-- Mismo gate de lectura que snapshot_meta / live_real_history.
drop policy if exists "whitelisted users can read bot registry" on public.bot_registry;
create policy "whitelisted users can read bot registry"
  on public.bot_registry for select
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
--   select count(*), count(*) filter (where is_real) as reales,
--          count(*) filter (where not active) as dormidos
--     from public.bot_registry;
-- =====================================================================
