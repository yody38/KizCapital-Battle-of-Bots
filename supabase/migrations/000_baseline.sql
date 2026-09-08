-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Migracion 000: BASELINE (2026-09-08)
--
-- Este archivo NO CREA NADA. Su unico trabajo es dejar constancia, dentro
-- de `public.schema_migrations`, de que los cinco .sql que vivian sueltos
-- en `supabase/` ya fueron aplicados a mano en el SQL Editor mucho antes
-- de que existiera un runner.
--
-- Por que hace falta (2026-09-08): hasta hoy nadie sabia, MIRANDO EL REPO,
-- que tenia dentro el Postgres desplegado. La unica prueba era la memoria
-- del owner. Sembrar el baseline convierte esos cinco archivos en historia
-- verificable y garantiza que ningun runner futuro los vuelva a ejecutar
-- creyendo que estan pendientes — re-correr `schema.sql`, por ejemplo,
-- re-inserta el trigger de whitelist sobre auth.users.
--
-- Los sha256 son los de los archivos EL DIA DEL BASELINE. Si uno cambia
-- despues, el sha guardado deja de coincidir: eso es exactamente la senal
-- que queremos (el archivo evoluciono sin pasar por una migracion nueva).
--
-- BOOTSTRAP: `scripts/migrate.py --apply` aplica 001 (el libro mayor)
-- ANTES que este archivo cuando la tabla todavia no existe — un libro
-- mayor no puede registrarse a si mismo antes de existir.
-- =====================================================================

insert into public.schema_migrations (version, name, sha256) values
  ('000_legacy_schema',            'supabase/schema.sql',              '6c1fe1f7c8a57a9f566d9e9a8fecb9db84c84c8453db71f1ccd0d8ac4e440cc8'),
  ('000_legacy_snapshot_meta',     'supabase/snapshot_meta.sql',       '3c2444a0898ca80d2d1249ecf3fe32d833e8e6e2cd5312a33c846863b5f18446'),
  ('000_legacy_live_real_state',   'supabase/live_real_state.sql',     'ea3d8bd61158ee7fa477324e3504920bb478c30e2afd8788e43b50f0398af0f5'),
  ('000_legacy_live_real_history', 'supabase/live_real_history.sql',   '5120834f502eab7fb3d6ba197e2ce0364fcb28c217f1ced355496589f2f78d98'),
  ('000_legacy_publisher_heartbeat','supabase/publisher_heartbeat.sql','986e9205e59fe9e807920be8d082c02586eca52ad9cac21b5776c8640d178671')
on conflict (version) do nothing;

-- =====================================================================
-- DONE. Verify with:
--   select version, name, applied_at from public.schema_migrations
--    where version like '000_legacy_%' order by version;
-- =====================================================================
