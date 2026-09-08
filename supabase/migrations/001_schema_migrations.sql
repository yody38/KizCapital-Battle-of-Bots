-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Migracion 001: libro mayor de esquema
-- Run this in: Supabase Dashboard → SQL Editor, o `scripts/migrate.py --apply`.
-- Idempotent: re-runs are safe.
--
-- Por que (2026-09-08): el esquema desplegado y el repo llevaban meses sin
-- forma de compararse. Esta tabla es la respuesta a "que hay realmente en
-- Postgres": cada archivo de `supabase/migrations/` deja aqui su version,
-- su nombre y el sha256 del texto EXACTO que se ejecuto. Con eso, un drift
-- (alguien edito el .sql despues de aplicarlo, o lo aplico a mano y lo
-- cambio) deja de ser invisible.
--
-- El sha256 no es decorativo: es la unica prueba de que la fila describe
-- el mismo SQL que hoy vive en el repo.
-- =====================================================================

create table if not exists public.schema_migrations (
  version     text primary key,
  name        text,
  sha256      text not null,
  applied_at  timestamptz not null default now()
);

comment on table public.schema_migrations is
  'Libro mayor de migraciones. Escrituras SOLO desde CI con service_role; '
  'sin politicas de select — ni siquiera un usuario whitelisted lo lee.';

-- RLS activa y SIN politicas a proposito: nadie con un JWT de usuario tiene
-- por que ver la historia del esquema. service_role bypasea RLS, asi que el
-- runner sigue pudiendo escribir y leer.
alter table public.schema_migrations enable row level security;

-- =====================================================================
-- DONE. Verify with:
--   select version, name, applied_at from public.schema_migrations
--    order by version;
-- =====================================================================
