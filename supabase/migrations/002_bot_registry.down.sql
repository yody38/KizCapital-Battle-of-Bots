-- Kiz Capital LLC · Battle of Bots — Rollback de 002 (2026-09-08).
-- Destruye el censo (y con el, first_seen de cada bot: es historia que el
-- snapshot NO puede reconstruir). Solo para proyectos de prueba.
drop table if exists public.bot_registry;
