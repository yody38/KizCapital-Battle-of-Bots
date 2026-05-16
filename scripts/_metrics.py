"""Shared statistical + financial metric formulas for Battle of Bots.

Single source of truth for any metric computed from raw trades or daily series.
Imported by post_merge.py (downstream enrichment) and verify_live_mt5.py
(upstream audit recompute). If a number appears in two places, the formula
lives here.

Conventions:
- Daily returns / nets are lists of floats in chronological order.
- Trades are dicts with keys: time_close (ISO 8601 str), profit, swap,
  commission (all floats; commission may be 0 or negative).
- 252 trading days/year for annualization of forex daily returns.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime, timezone

TRADING_DAYS_PER_YEAR = 252


# --- Basic stats ---------------------------------------------------------

def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def stdev(xs):
    n = len(xs)
    if n < 2:
        return 0.0
    m = sum(xs) / n
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))


def percentile(sorted_xs, p: float):
    if not sorted_xs:
        return None
    if len(sorted_xs) == 1:
        return sorted_xs[0]
    k = (len(sorted_xs) - 1) * p
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return sorted_xs[lo]
    frac = k - lo
    return sorted_xs[lo] * (1 - frac) + sorted_xs[hi] * frac


def pearson(xs, ys):
    n = min(len(xs), len(ys))
    if n < 5:
        return None
    xs = xs[:n]
    ys = ys[:n]
    mx = sum(xs) / n
    my = sum(ys) / n
    num = 0.0
    dx2 = 0.0
    dy2 = 0.0
    for i in range(n):
        dx = xs[i] - mx
        dy = ys[i] - my
        num += dx * dy
        dx2 += dx * dx
        dy2 += dy * dy
    den = math.sqrt(dx2 * dy2)
    return (num / den) if den > 0 else None


# --- Frequentist confidence bounds ---------------------------------------

def wilson_lb(wins: int, n: int, z: float = 1.96) -> float:
    """Wilson lower bound (95% by default) for binomial proportion.
    Mirrors `wilsonLB` in Battle of Bots/app.js.
    Returns proportion in [0, 1]; multiply by 100 for percentage."""
    if not n or n <= 0:
        return 0.0
    p = wins / n
    denom = 1.0 + (z * z) / n
    center = p + (z * z) / (2.0 * n)
    margin = z * math.sqrt(p * (1.0 - p) / n + (z * z) / (4.0 * n * n))
    return max(0.0, min(1.0, (center - margin) / denom))


# --- Trade-derived aggregates --------------------------------------------

def trade_net(trade: dict) -> float:
    """Total $ delta of a single closed trade including swap and commission."""
    return float(trade.get("profit", 0.0) or 0.0) \
        + float(trade.get("swap", 0.0) or 0.0) \
        + float(trade.get("commission", 0.0) or 0.0)


def gross_pl(trades) -> tuple[float, float]:
    """Returns (gross_profit, gross_loss) where gross_loss is positive number."""
    gp = 0.0
    gl = 0.0
    for t in trades:
        n = trade_net(t)
        if n > 0:
            gp += n
        elif n < 0:
            gl += -n
    return gp, gl


def profit_factor(gross_profit: float, gross_loss: float):
    if gross_loss <= 0:
        return None if gross_profit <= 0 else float("inf")
    return gross_profit / gross_loss


def expectancy(net_total: float, n_trades: int):
    if not n_trades:
        return 0.0
    return net_total / n_trades


# --- Daily series construction -------------------------------------------

def _trade_close_date(trade: dict) -> str | None:
    """Extract YYYY-MM-DD from a trade's close timestamp (ISO or MT5 epoch)."""
    raw = trade.get("time_close") or trade.get("close_time") or trade.get("time")
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return datetime.fromtimestamp(float(raw), tz=timezone.utc).strftime("%Y-%m-%d")
    if isinstance(raw, str):
        # Trim TZ suffix if any; expect "YYYY-MM-DD..." or "YYYY-MM-DD HH:MM:SS".
        return raw[:10]
    return None


def daily_equity_series(trades, account_balance: float) -> list[dict]:
    """Reconstruct daily equity curve from closed trades.

    Each output row: {date, daily_net, cum_net, peak, dd_abs, dd_pct}.
    `dd_pct` is relative to account_balance (matches the project's drawdown
    definition: % of capital consumed at worst moment)."""
    by_day: dict[str, float] = defaultdict(float)
    for t in trades:
        d = _trade_close_date(t)
        if d is None:
            continue
        by_day[d] += trade_net(t)

    dates_sorted = sorted(by_day.keys())
    series = []
    cum = 0.0
    peak = 0.0
    for d in dates_sorted:
        net = by_day[d]
        cum += net
        peak = max(peak, cum)
        dd_abs = max(0.0, peak - cum)
        dd_pct = (dd_abs / account_balance * 100.0) if account_balance else 0.0
        series.append({
            "date": d,
            "daily_net": round(net, 2),
            "cum_net": round(cum, 2),
            "peak": round(peak, 2),
            "dd_abs": round(dd_abs, 2),
            "dd_pct": round(dd_pct, 4),
        })
    return series


def max_drawdown_from_series(series) -> tuple[float, float]:
    """Returns (max_dd_abs, max_dd_pct) from a daily_equity_series."""
    if not series:
        return 0.0, 0.0
    max_abs = max((r.get("dd_abs", 0.0) for r in series), default=0.0)
    max_pct = max((r.get("dd_pct", 0.0) for r in series), default=0.0)
    return float(max_abs), float(max_pct)


# --- Risk-adjusted return ratios -----------------------------------------

def sharpe_annualized(daily_nets, risk_free_daily: float = 0.0) -> float | None:
    """Annualized Sharpe using daily $ nets directly (no return normalization;
    this matches the project's convention since lots/exposure are stable
    per-bot)."""
    if len(daily_nets) < 2:
        return None
    excess = [x - risk_free_daily for x in daily_nets]
    sd = stdev(excess)
    if sd <= 0:
        return None
    return (mean(excess) / sd) * math.sqrt(TRADING_DAYS_PER_YEAR)


def sortino_annualized(daily_nets, target: float = 0.0) -> float | None:
    """Annualized Sortino: mean over downside-deviation."""
    if len(daily_nets) < 2:
        return None
    downside = [min(0.0, x - target) for x in daily_nets]
    sq = [d * d for d in downside]
    dd_var = sum(sq) / (len(daily_nets) - 1) if len(daily_nets) > 1 else 0.0
    dd_sd = math.sqrt(dd_var)
    if dd_sd <= 0:
        return None
    return ((mean(daily_nets) - target) / dd_sd) * math.sqrt(TRADING_DAYS_PER_YEAR)


def calmar(net_total: float, max_dd_abs: float, months_active: float | None = None):
    """Annualized return / |max drawdown|.

    If months_active is provided, net is annualized (net * 12 / months); otherwise
    the raw ratio is returned (matches upstream builder convention which annualizes)."""
    if max_dd_abs is None or max_dd_abs <= 0:
        return None
    if months_active and months_active > 0:
        annual_net = net_total * 12.0 / months_active
    else:
        annual_net = net_total
    return annual_net / max_dd_abs


