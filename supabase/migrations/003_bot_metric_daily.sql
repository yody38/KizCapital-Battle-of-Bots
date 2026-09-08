-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Migracion 003: metricas por bot y dia
-- Run this in: Supabase Dashboard → SQL Editor, o `scripts/migrate.py --apply`.
-- Idempotent: re-runs are safe.
--
-- Que responde y snapshot.json no puede: "como evoluciono el score de este
-- bot en los ultimos 90 dias", "cuando empezo a caer su profit factor",
-- "que bots mejoraron desde el cambio de formula". El snapshot solo sabe
-- el AHORA; esto es la serie temporal.
--
-- LA CLAVE ES (bot_key, as_of) — a proposito (2026-09-08).
-- refresh.yml corre cada 15 min = 96 ciclos por dia. Si la clave llevara el
-- ciclo, cada bot dejaria 96 filas diarias casi identicas. Con (bot_key,
-- as_of) el ciclo hace UPSERT sobre la MISMA fila todo el dia: la ultima
-- lectura del dia gana y la tabla crece 1 fila/bot/dia. Ese es el factor 96
-- entre una tabla que cabe en el plan y una que no (ver estimacion abajo).
--
-- COLUMNAS ESCALARES TIPADAS, NO UN BLOB jsonb — tambien a proposito. Un
-- jsonb obliga a castear en cada consulta, no indexa por columna y deja que
-- el productor cambie de forma en silencio. Una columna tipada rompe fuerte
-- el dia que el campo del snapshot cambie de nombre, que es justo lo que
-- queremos que pase.
--
-- ---------------------------------------------------------------------
-- TAMANO DE FILA Y CRECIMIENTO ANUAL (estimacion, 2026-09-08)
-- ---------------------------------------------------------------------
-- Ancho por fila: 2 text de 64 chars (cycle_sha, metrics_hash) = ~130 B,
-- bot_key ~15 B, promotion_status ~7 B, 11 numeric ~10 B c/u = ~110 B,
-- 3 int + 1 date + 2 bool + 1 timestamptz = ~25 B, cabecera de tupla +
-- mapa de nulos + alineacion = ~35 B  ->  ~350 B de heap.
-- La entrada del indice primario (bot_key, as_of) anade ~30 B  ->  ~380 B
-- por fila en disco. Redondeamos a 400 B para tener margen.
--
--   623 bots (flota de hoy):   623 x 365 = 227.400 filas/ano  ~=  91 MB/ano
--  2000 bots (techo previsto): 2000 x 365 = 730.000 filas/ano  ~= 292 MB/ano
--
-- Con la clave por ciclo en vez de por dia serian ~8,7 GB/ano a 623 bots.
-- Por eso la clave es (bot_key, as_of) y no (bot_key, cycle_sha).
--
-- Cuando 292 MB/ano incomode: comprimir a 1 fila/semana mas alla de 400 dias
-- (mismo patron de retencion que prune_live_real_history). Hoy NO hace falta.
-- ---------------------------------------------------------------------
-- =====================================================================

create table if not exists public.bot_metric_daily (
  bot_key                        text not null,
  as_of                          date not null,   -- fecha UTC de snapshot.generated_at

  cycle_sha                      text,            -- sha256 del snapshot.json que produjo esta lectura

  -- Dinero y actividad. `_lifetime` incluye comision (net = profit+commission+swap),
  -- `net_profit_lifetime` es el legado sin comision — kiz/metrics.py fija la convencion.
  trades_lifetime                integer,
  net_profit_lifetime            numeric(16,2),
  net_after_commission_lifetime  numeric(16,2),
  net_365d                       numeric(16,2),
  net_30d                        numeric(16,2),

  -- Calidad
  win_rate_pct_lifetime          numeric(6,2),
  profit_factor_lifetime         numeric(10,3),
  max_drawdown_lifetime          numeric(16,2),
  max_drawdown_365d              numeric(16,2),
  dd_pct_of_balance              numeric(8,2),
  calmar_365d                    numeric(10,3),
  sortino_365d                   numeric(10,3),

  -- Ventanas explicitas (el defecto mas caro del sistema nacia de mezclarlas)
  months_active_lifetime         integer,
  months_active_365d             integer,
  return_monthly_pct_365d        numeric(10,4),

  -- Decision
  promotion_score                numeric(6,1),
  promotion_score_v2             numeric(6,1),
  promotion_status               text,
  decay_flag                     boolean,
  drift_flag                     boolean,

  balance                        numeric(16,2),

  -- sha256 de los valores metricos de ESTA fila (sin cycle_sha ni updated_at).
  -- Un bot que no cambio produce el mismo hash: el UPSERT no altera nada
  -- observable y se puede detectar "este bot lleva N dias congelado".
  metrics_hash                   text not null,
  updated_at                     timestamptz not null default now(),

  primary key (bot_key, as_of)
);

comment on table public.bot_metric_daily is
  'Serie diaria por bot. 1 fila por bot y por dia UTC: el ciclo de 15 min '
  'hace UPSERT sobre la misma fila (96 ciclos/dia -> 1 fila). Escrituras '
  'exclusivamente desde CI con service_role.';
comment on column public.bot_metric_daily.metrics_hash is
  'sha256 de los valores metricos de la fila. Igual = el bot no se movio.';

create index if not exists idx_bot_metric_daily_as_of
  on public.bot_metric_daily (as_of desc);
create index if not exists idx_bot_metric_daily_bot_asof
  on public.bot_metric_daily (bot_key, as_of desc);

alter table public.bot_metric_daily enable row level security;

drop policy if exists "whitelisted users can read bot metrics" on public.bot_metric_daily;
create policy "whitelisted users can read bot metrics"
  on public.bot_metric_daily for select
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
--   select as_of, count(*) from public.bot_metric_daily
--    group by as_of order by as_of desc limit 10;
--   select pg_size_pretty(pg_total_relation_size('public.bot_metric_daily'));
-- =====================================================================
