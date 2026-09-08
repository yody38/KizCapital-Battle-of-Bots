-- Kiz Capital LLC · Battle of Bots — Rollback de 001 (2026-09-08).
-- Borra el libro mayor. Tras esto el runner ya no sabe que hay aplicado:
-- solo tiene sentido en un proyecto de pruebas, nunca en el de produccion.
drop table if exists public.schema_migrations;
