"""Implementacion canonica de cada metrica, con la ventana siempre explicita.

Reutiliza las formulas de `_metrics.py` (que hasta hoy no llamaba nadie salvo
por `clamp01`) en vez de escribir unas nuevas: el objetivo de la Fase 1-B es
que deje de haber varias definiciones, no anadir una mas.

Convencion de dinero, fijada aqui de una vez:
  net = profit + commission + swap        (comision INCLUIDA)
El builder ya usa esa convencion; `reconcile_snapshot` usaba `profit + swap`
(sin comision) y sobrescribia la del builder, de modo que el win-rate
publicado era mas optimista que el real. Los campos `*_lifetime` que produce
este modulo son siempre con comision.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import _metrics  # noqa: E402  (fuente unica de las formulas)
from kiz import windows  # noqa: E402

trade_net = _metrics.trade_net
profit_factor = _metrics.profit_factor
daily_equity_series = _metrics.daily_equity_series
max_drawdown_from_series = _metrics.max_drawdown_from_series
sharpe_annualized = _metrics.sharpe_annualized
sortino_annualized = _metrics.sortino_annualized
calmar = _metrics.calmar


def _round(value, digits=2):
    return None if value is None else round(value, digits)


def daily_nets(trades):
    """Lista de netos diarios en orden cronologico (con comision)."""
    series = _metrics.daily_equity_series(trades, 0.0)
    return [row["daily_net"] for row in series]


def aggregates(trades, balance=None, suffix="lifetime", series=None):
    """Agregados canonicos de una lista de trades ya filtrada por ventana.

    Devuelve un dict con las claves ya sufijadas, listo para fusionar en el
    objeto bot del snapshot. `series` permite reutilizar el
    `daily_equity_series` que el builder ya escribio en el archivo per-bot en
    vez de recalcularlo.
    """
    trades = list(trades or [])
    n = len(trades)
    nets = [trade_net(t) for t in trades]
    wins = sum(1 for v in nets if v > 0)
    losses = sum(1 for v in nets if v < 0)
    gross_profit = sum(v for v in nets if v > 0)
    gross_loss = -sum(v for v in nets if v < 0)  # positivo
    net_total = sum(nets)
    months = windows.months_active(trades)

    if series is None:
        series = _metrics.daily_equity_series(trades, balance or 0.0)
    max_dd_abs, _ = _metrics.max_drawdown_from_series(series)
    dnets = [row["daily_net"] for row in series]

    pf = _metrics.profit_factor(gross_profit, gross_loss)
    if pf == float("inf"):
        pf = None  # el frontend no sabe pintar Infinity

    out = {
        f"trades_{suffix}": n,
        f"wins_{suffix}": wins,
        f"losses_{suffix}": losses,
        f"win_rate_pct_{suffix}": _round((wins / n * 100.0) if n else 0.0),
        f"gross_profit_{suffix}": _round(gross_profit),
        f"gross_loss_{suffix}": _round(-gross_loss),  # negativo, como el builder
        f"net_after_commission_{suffix}": _round(net_total),
        f"months_active_{suffix}": months,
        f"max_drawdown_{suffix}": _round(max_dd_abs),
        f"profit_factor_{suffix}": _round(pf),
        f"calmar_{suffix}": _round(_metrics.calmar(net_total, max_dd_abs, months)),
        f"sharpe_{suffix}": _round(_metrics.sharpe_annualized(dnets)),
        f"sortino_{suffix}": _round(_metrics.sortino_annualized(dnets)),
    }
    if balance:
        out[f"dd_pct_of_balance_{suffix}"] = _round(max_dd_abs / balance * 100.0)
        out[f"return_monthly_pct_{suffix}"] = _round(
            (net_total / balance) / months * 100.0 if months else 0.0, 4
        )
    return out


def return_monthly_pct(net_after_commission, balance, months):
    """Metrica canonica `return_monthly_pct_<ventana>`.

    Retorno mensual neto sobre balance, en %. Numerador y denominador DEBEN
    venir de la misma ventana: mezclarlos era el defecto que inflaba el score
    de los bots viejos por un factor aproximado a su edad en anos.
    """
    if not balance or not months:
        return None
    return (float(net_after_commission) / float(balance)) / float(months) * 100.0
