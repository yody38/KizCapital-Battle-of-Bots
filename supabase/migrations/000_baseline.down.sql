-- Kiz Capital LLC · Battle of Bots — Rollback de 000_baseline (2026-09-08).
-- Solo borra las filas de constancia. No toca ningun objeto: el baseline
-- nunca creo nada, asi que revertirlo no puede destruir datos.
delete from public.schema_migrations where version like '000_legacy_%';
