-- =====================================================================
-- Kiz Capital LLC · Battle of Bots — Historia intradía PERSISTENTE de las
-- cuentas reales (F1). Run in: Supabase Dashboard → SQL Editor → Run.
-- Idempotent: re-runs are safe.
--
-- Written by live_publisher.py (service_role) — 1 punto cada ~30s por login
-- (1 de cada 10 ticks del stream de 3s). Read by the dashboard via the RPC
-- real_equity_history() (bucketized, ≤1000 rows per call, RLS-gated).
--
-- Retención (free tier para siempre):
--   resolución 30s   → últimas 48 h
--   compactado 5 min → 48 h ... 7 d
--   compactado 30 min→ 7 d ... 30 d
--   > 30 d           → borrado
-- El publisher llama prune_live_real_history() una vez por hora.
-- =====================================================================

create table if not exists public.live_real_history (
  id            bigint generated always as identity primary key,
  login         bigint not null,
  ts            timestamptz not null default now(),
  equity        numeric(14,2),
  balance       numeric(14,2),
  floating_pnl  numeric(14,2),
  margin_level  numeric(14,2)
);

create index if not exists idx_live_real_history_login_ts
  on public.live_real_history (login, ts desc);
create index if not exists idx_live_real_history_ts
  on public.live_real_history (ts);

alter table public.live_real_history enable row level security;

-- Same read gate as live_real_state: whitelisted authenticated users.
drop policy if exists "whitelisted users can read live history" on public.live_real_history;
create policy "whitelisted users can read live history"
  on public.live_real_history for select
  to authenticated
  using (
    exists (
      select 1 from public.allowed_emails ae
      where lower(ae.email) = lower((auth.jwt() ->> 'email'))
    )
  );

-- Writes happen exclusively from the VPS publisher with the service_role key
-- (bypasses RLS) — no insert/update policies needed.

-- ---------------------------------------------------------------------
-- Lectura bucketizada para el chart (1h/24h/7d/30d). SECURITY INVOKER:
-- la RLS de la tabla aplica con el JWT del caller, así que no hace falta
-- duplicar el gate de whitelist aquí. Buckets elegidos para que el total
-- de filas quede < 1000 (max_rows de PostgREST) con 5 cuentas reales:
--   1h → 60s (≤300) · 24h → 10min (≤720) · 7d → 1h (≤840) · 30d → 4h (≤900)
-- ---------------------------------------------------------------------
create or replace function public.real_equity_history(win text)
returns table (login bigint, bucket timestamptz, equity numeric, balance numeric)
language sql
stable
as $$
  with cfg as (
    select case win
             when '1h'  then interval '1 hour'
             when '24h' then interval '24 hours'
             when '7d'  then interval '7 days'
             when '30d' then interval '30 days'
             else interval '24 hours'
           end as span,
           case win
             when '1h'  then interval '60 seconds'
             when '24h' then interval '10 minutes'
             when '7d'  then interval '1 hour'
             when '30d' then interval '4 hours'
             else interval '10 minutes'
           end as step
  )
  select h.login,
         date_bin(cfg.step, h.ts, timestamptz '2020-01-01') as bucket,
         avg(h.equity)  as equity,
         avg(h.balance) as balance
    from public.live_real_history h, cfg
   where h.ts >= now() - cfg.span
   group by h.login, bucket
   order by bucket asc, h.login asc;
$$;

grant execute on function public.real_equity_history(text) to authenticated;
revoke execute on function public.real_equity_history(text) from anon;

-- ---------------------------------------------------------------------
-- Serie SEMANAL para el chart "Ingreso de la semana" del War Room:
-- equity TOTAL (suma de todas las cuentas reales, con forward-fill por
-- login) en buckets de 15 min desde la apertura del mercado (week_open =
-- domingo 17:00 America/New_York) hasta now() o el cierre del viernes
-- (week_open + 5 días), lo que llegue primero. ≤480 filas (< max_rows).
-- SECURITY INVOKER: la RLS whitelist de live_real_history aplica al caller.
-- Nota: el LATERAL ignora logins sin datos aún en ese bucket (una cuenta
-- que entró a mitad de semana suma desde su primer punto).
-- ---------------------------------------------------------------------
create or replace function public.real_weekly_history(week_open timestamptz)
returns table (bucket timestamptz, total_equity numeric)
language sql
stable
as $$
  with logins as (
    select distinct h.login from public.live_real_history h
     where h.ts >= week_open
  ),
  buckets as (
    select generate_series(
             week_open,
             least(now(), week_open + interval '5 days'),
             interval '15 minutes'
           ) as b
  )
  select bk.b as bucket,
         sum(ff.equity) as total_equity
    from buckets bk
    cross join logins lg
    join lateral (
      select h.equity
        from public.live_real_history h
       where h.login = lg.login
         and h.ts >= week_open
         and h.ts <= bk.b
       order by h.ts desc
       limit 1
    ) ff on true
   group by bk.b
   order by bk.b asc;
$$;

grant execute on function public.real_weekly_history(timestamptz) to authenticated;
revoke execute on function public.real_weekly_history(timestamptz) from anon;

-- ---------------------------------------------------------------------
-- Retención/compactado. Solo el publisher (service_role) puede ejecutarla.
-- min(id) como representante del bucket es correcto porque id (identity)
-- crece con el tiempo de inserción.
-- ---------------------------------------------------------------------
create or replace function public.prune_live_real_history()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 48h..7d → 1 punto por bucket de 5 min por login
  delete from public.live_real_history h
   where h.ts <  now() - interval '48 hours'
     and h.ts >= now() - interval '7 days'
     and h.id not in (
       select min(id) from public.live_real_history
        where ts <  now() - interval '48 hours'
          and ts >= now() - interval '7 days'
        group by login, date_bin(interval '5 minutes', ts, timestamptz '2020-01-01')
     );

  -- 7d..30d → 1 punto por bucket de 30 min por login
  delete from public.live_real_history h
   where h.ts <  now() - interval '7 days'
     and h.ts >= now() - interval '30 days'
     and h.id not in (
       select min(id) from public.live_real_history
        where ts <  now() - interval '7 days'
          and ts >= now() - interval '30 days'
        group by login, date_bin(interval '30 minutes', ts, timestamptz '2020-01-01')
     );

  -- > 30d → fuera
  delete from public.live_real_history where ts < now() - interval '30 days';
end;
$$;

revoke execute on function public.prune_live_real_history() from public, anon, authenticated;

-- =====================================================================
-- DONE. Verify with:
--   select login, count(*), min(ts), max(ts)
--     from public.live_real_history group by login;
--   select * from public.real_equity_history('1h') limit 20;
-- =====================================================================
