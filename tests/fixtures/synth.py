#!/usr/bin/env python3
"""Deterministic synthetic `data/` tree for the Battle of Bots scoring engine.

Builds a COMPLETE and VALID data dir — the same shape the real pipeline produces
after `mirror.sh` merges the per-VPS snapshots — so that `post_merge.py`,
`reconcile_snapshot.py` and the frontend can be exercised in CI with zero access
to a VPS, a broker, a login or a real account.

Everything here is FAKE by construction:
  · logins are 900001..900009 (real logins are never in this repo),
  · magics are 5001..5099,
  · balances/symbols/servers are invented.

Key shape facts, verified against the real code (do not "simplify" them away):

  · `snapshot.json` bots[] are aggregated over the LAST 365 DAYS ONLY
    (upstream/snapshot_builder.vps3.py: WINDOW_DAYS = 365, aggregate_bots() is
    fed `deals` = the recent window), while `data/bots/<vps>/<login>-<magic>.json`
    carries the FULL trade history since HISTORY_START (2020-01-01).
    That asymmetry is the reason `reconcile_snapshot.py` silently converts the
    window figures into LIFETIME figures — see tests/test_reconcile_characterization.py.

  · the snapshot bot record is NET-based (net = profit + commission + swap),
    because aggregate_bots() consumes deals whose `net` already includes the
    commission. `reconcile_snapshot.py` later recomputes the same fields as
    profit + swap ONLY. Both behaviours are pinned by the characterization tests.

  · every trade dict carries the real key names emitted by
    `_trades_from_deals()`: ticket, magic, symbol, side, volume, open_time,
    close_time, open_price, close_price, pips, profit, swap, commission, net,
    duration_sec, comment — and `net == profit + commission + swap`.

  · daily_equity_series rows are {date, cum_net, daily_net, peak, dd_abs, dd_pct}
    exactly as `_build_daily_equity_series()` emits them.

Time anchoring — the reason the golden scores reproduce:
  · the last trading day is ALWAYS `today - 1` at 12:00 UTC, and trades sit on
    day offsets that are multiples of the archetype's `every_k`;
  · every `every_k` is chosen from {3, 5, 6, 9}, none of which divides 364, 89
    or 29. The engine's rolling cutoffs (30d / 90d / 365d) therefore always fall
    on a NON-trading day, so trades_30d / trades_90d / the 365-day builder window
    contain the same trades no matter what hour of the day the suite runs;
  · every winning archetype has a monthly edge many sigmas above zero and every
    loser many sigmas below, so `months_positive_pct` is 100.0 (or 0.0) whatever
    way the calendar happens to slice the history.
The only quantity that still moves with the calendar is `months_active` for the
~4-month archetypes (4 vs 5), worth <0.2 promotion points — which is why the
golden comparison uses a small tolerance rather than exact equality.

Usage:
    from fixtures.synth import build_data_dir
    data_dir = build_data_dir(tmp_path)          # returns <tmp_path>/data
"""
from __future__ import annotations

import json
import math
import os
import random
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone

# --- constants mirrored from the real builder ---------------------------------
WINDOW_DAYS = 365                      # snapshot_builder.vps3.py L36
HISTORY_START = "2020-01-01T00:00:00"  # snapshot_builder.vps3.py L37
BUILDER_VERSION = "v2-2026-05-03"
DEFAULT_SEED = 1337

FALLBACK_VPS_IDS = ["vps1", "vps2", "vps3", "vps4", "vps5", "vps6"]


def vps_ids():
    """Canonical fleet ids. Falls back to vps1..vps6 if the registry is absent."""
    try:
        from vps_registry import ids  # scripts/ is on sys.path via pytest.ini
        return list(ids())
    except Exception:  # noqa: BLE001
        return list(FALLBACK_VPS_IDS)


# --- synthetic accounts -------------------------------------------------------
# login, vps, balance, is_real. 900009 is the ONLY "real" one (trade_mode 2).
ACCOUNTS = [
    (900001, "vps1", 10000.0, False),
    (900002, "vps1", 10000.0, False),
    (900003, "vps2", 10000.0, False),
    (900004, "vps2", 10000.0, False),
    (900005, "vps4", 10000.0, False),
    (900006, "vps4", 10000.0, False),
    (900009, "vps3", 5000.0, True),
]

# --- bot archetypes -----------------------------------------------------------
# Shapes are deliberately far apart so a scoring change is visible.
#   days        : calendar span of the FULL history (per-bot file)
#   every_k     : a trading day every k days (k=5 => 20% of days => "sparse").
#                 MUST divide none of 364 / 89 / 29 — see the module docstring.
#   n_win/n_loss: trades of each sign on a normal trading day. The ranges are
#                 chosen so the WORST possible normal day is still net positive
#                 (net negative for `loser`) — that is what keeps
#                 `months_positive_pct` at a flat 100.0 / 0.0 whatever way the
#                 calendar slices the history.
#   w / l       : (min, max) of |profit| per winning / losing trade
ARCHETYPES = [
    # name,          vps,     login,  magic, symbol,   days,  k, nW, nL, w,            l
    ("old_grinder_a", "vps1", 900001, 5001, "EURUSD", 1095,  6, 2, 1, (10.0, 16.0), (3.0, 8.0)),
    ("old_grinder_b", "vps1", 900002, 5002, "GBPUSD",  960,  9, 3, 1, (7.0, 12.0), (4.0, 10.0)),
    ("old_grinder_c", "vps2", 900003, 5003, "USDJPY", 1140,  6, 1, 1, (14.0, 22.0), (3.0, 9.0)),
    ("young_hot",     "vps2", 900004, 5004, "XAUUSD",  120,  3, 2, 1, (22.0, 36.0), (8.0, 20.0)),
    ("young_hot_b",   "vps4", 900005, 5005, "AUDUSD",  117,  3, 3, 1, (12.0, 20.0), (6.0, 16.0)),
    ("sparse",        "vps4", 900006, 5006, "EURJPY",  380,  5, 2, 1, (20.0, 32.0), (6.0, 16.0)),
    ("loser",         "vps1", 900001, 5007, "NZDUSD",  402,  6, 1, 2, (3.0, 8.0), (9.0, 15.0)),
    ("real_bot",      "vps3", 900009, 5009, "EURUSD",  249,  3, 2, 1, (11.0, 18.0), (4.0, 10.0)),
]

# One trading day in every LOSING_DAY_EVERY is a full loss, so the equity curve
# has real drawdowns instead of a straight line — but never inside a month that
# a rolling window can cut in half (see PROTECTED_MARGIN_DAYS).
LOSING_DAY_EVERY = 7
PROTECTED_MARGIN_DAYS = 40
MAX_COST_PER_TRADE = 1.55  # |commission|max + |swap|max, see _gen_trades

# Rolling cutoffs the engine applies to the wall clock. A trading day must never
# coincide with one, or a score would depend on the hour the suite runs.
ENGINE_CUTOFF_DAYS = (30, 90, 365)

ARCHETYPE_BY_MAGIC = {a[3]: a[0] for a in ARCHETYPES}

_PIP_FACTOR = {"USDJPY": 100.0, "EURJPY": 100.0, "XAUUSD": 10.0}


# --- trade generation ---------------------------------------------------------

def _ts(day: date, hour: int) -> int:
    return int(datetime.combine(day, time(hour, 0), tzinfo=timezone.utc).timestamp())


def _worst_normal_day(spec):
    """Net of the worst possible normal day: > 0 for a winner, < 0 for a loser."""
    _, _, _, _, _, _, _, n_win, n_loss, w, l = spec
    return n_win * w[0] - n_loss * l[1] - (n_win + n_loss) * MAX_COST_PER_TRADE


def _gen_trades(rng, spec, anchor: date):
    """Full trade history for one archetype, chronological by close_time.

    Trading days are `anchor - off` for off = 0, k, 2k, ... < days: laid out from
    the END so every trade's distance to "now" is fixed, whatever today is.
    """
    (_name, _vps, _login, magic, symbol, days, every_k, n_win, n_loss, w, l) = spec
    offsets = sorted(range(0, days, every_k), reverse=True)   # oldest first
    max_off = offsets[0]
    floor_net = _worst_normal_day(spec)
    trades = []
    ticket = magic * 100000
    price = {"USDJPY": 148.0, "EURJPY": 160.0, "XAUUSD": 2300.0}.get(symbol, 1.1000)

    def _protected(off):
        """True near a rolling-window edge, where a calendar month can be cut in
        half: those months must stay unambiguously positive (or negative)."""
        m = PROTECTED_MARGIN_DAYS
        return off <= m or abs(off - (WINDOW_DAYS - 1)) <= m or off >= max_off - m

    for idx, off in enumerate(offsets):
        day = anchor - timedelta(days=off)
        losing_day = (floor_net > 0 and idx % LOSING_DAY_EVERY == 0
                      and not _protected(off))
        if losing_day:
            # A whole day in the red, but capped at ~1.4x a worst normal day so a
            # full calendar month still cannot flip sign.
            target = rng.uniform(0.6, 1.2) * floor_net
            amounts = [-(target / (n_win + n_loss)) * rng.uniform(0.8, 1.2)
                       for _ in range(n_win + n_loss)]
        else:
            amounts = ([rng.uniform(*w) for _ in range(n_win)]
                       + [-rng.uniform(*l) for _ in range(n_loss)])
        for j, amount in enumerate(amounts):
            ticket += 1
            profit = round(amount, 2)
            swap = round(rng.uniform(-0.35, 0.10), 2)
            commission = round(-rng.uniform(0.40, 1.20), 2)
            net = round(profit + commission + swap, 2)
            side = "BUY" if rng.random() < 0.5 else "SELL"
            volume = round(rng.choice([0.01, 0.02, 0.05, 0.10]), 2)
            open_time = _ts(day, 8)
            close_time = _ts(day, 12) + j * 60   # all closes on the SAME UTC day
            drift = round(rng.uniform(-0.0040, 0.0040) * (price / 1.1), 5)
            open_price = round(price, 5)
            close_price = round(price + drift, 5)
            diff = close_price - open_price
            if side == "SELL":
                diff = -diff
            trades.append({
                "ticket": int(ticket),
                "magic": int(magic),
                "symbol": symbol,
                "side": side,
                "volume": volume,
                "open_time": open_time,
                "close_time": close_time,
                "open_price": open_price,
                "close_price": close_price,
                "pips": round(diff * _PIP_FACTOR.get(symbol, 10000.0), 1),
                "profit": profit,
                "swap": swap,
                "commission": commission,
                "net": net,
                "duration_sec": int(close_time - open_time),
                "comment": f"synth-{magic}",
            })
    trades.sort(key=lambda t: t["close_time"])
    return trades


# --- builder-faithful statistics ---------------------------------------------
# Ports of upstream/snapshot_builder.vps3.py helpers (stdlib only). Kept here so
# the fixture produces the SAME field set the real VPS builder emits.

def _stdev_sample(values):
    if len(values) < 2:
        return 0.0
    m = sum(values) / len(values)
    return math.sqrt(sum((x - m) ** 2 for x in values) / (len(values) - 1))


def _linear_slope(xs, ys):
    n = len(xs)
    if n < 2:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = den = 0.0
    for i in range(n):
        dx = xs[i] - mx
        num += dx * (ys[i] - my)
        den += dx * dx
    return (num / den) if den > 0 else 0.0


def _risk_metrics(ordered_nets):
    if not ordered_nets:
        return {}
    equity = peak = max_dd = 0.0
    cur_loss = max_loss = cur_win = max_win = 0
    for n in ordered_nets:
        equity += n
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
        if n < 0:
            cur_loss += 1
            cur_win = 0
            max_loss = max(max_loss, cur_loss)
        elif n > 0:
            cur_win += 1
            cur_loss = 0
            max_win = max(max_win, cur_win)
    mean = sum(ordered_nets) / len(ordered_nets)
    var = sum((x - mean) ** 2 for x in ordered_nets) / len(ordered_nets)
    sd = var ** 0.5
    net = sum(ordered_nets)
    return {
        "max_drawdown": round(max_dd, 2),
        "recovery_factor": round(net / max_dd, 2) if max_dd > 0 else None,
        "max_consecutive_losses": max_loss,
        "max_consecutive_wins": max_win,
        "sharpe_like": round(mean / sd, 3) if sd > 0 else None,
        "stdev_per_trade": round(sd, 2),
    }


def _daily_from_deals(deals_sorted):
    by_day = defaultdict(float)
    for d in deals_sorted:
        day = datetime.fromtimestamp(d["time"], tz=timezone.utc).date().isoformat()
        by_day[day] += d["net"]
    return sorted(by_day.items())


def _monthly_aggregates(deals_sorted):
    by_month = defaultdict(lambda: [0.0, 0])
    for d in deals_sorted:
        ts = datetime.fromtimestamp(d["time"], tz=timezone.utc)
        key = f"{ts.year:04d}-{ts.month:02d}"
        by_month[key][0] += d["net"]
        by_month[key][1] += 1
    return [(k, v[0], v[1]) for k, v in sorted(by_month.items())]


def _consistency_metrics(deals_sorted):
    if not deals_sorted:
        return {}
    months = _monthly_aggregates(deals_sorted)
    months_active = len(months)
    nets = [m[1] for m in months]
    months_positive = sum(1 for n in nets if n > 0)
    stdev_m = _stdev_sample(nets)
    mean_m = sum(nets) / months_active if months_active else 0
    cov_m = (stdev_m / abs(mean_m)) if abs(mean_m) > 1e-6 else None
    cur = mx = 0
    for n in nets:
        if n < 0:
            cur += 1
            mx = max(mx, cur)
        else:
            cur = 0
    cum = peak = 0.0
    in_dd = False
    dd_start = None
    longest = 0.0
    for d in deals_sorted:
        cum += d["net"]
        if cum >= peak:
            peak = cum
            if in_dd and dd_start is not None:
                longest = max(longest, (d["time"] - dd_start) / 86400.0)
            in_dd = False
            dd_start = None
        elif not in_dd:
            in_dd = True
            dd_start = d["time"]
    if in_dd and dd_start is not None:
        longest = max(longest, (deals_sorted[-1]["time"] - dd_start) / 86400.0)
    return {
        "months_active": months_active,
        "months_positive": months_positive,
        "months_positive_pct": round(months_positive / months_active * 100, 1),
        "monthly_net_stdev": round(stdev_m, 2),
        "monthly_net_cov": round(cov_m, 3) if cov_m is not None else None,
        "longest_losing_streak_months": mx,
        "longest_dd_duration_days": round(longest, 1),
    }


def _risk_adjusted_metrics(deals_sorted, net_profit, max_drawdown):
    daily = _daily_from_deals(deals_sorted)
    out = {"calmar": None, "sharpe_annualized": None, "sortino": None}
    if max_drawdown and max_drawdown > 0:
        out["calmar"] = round(net_profit / max_drawdown, 2)
    if len(daily) >= 2:
        nets = [n for _, n in daily]
        mean = sum(nets) / len(nets)
        sd = _stdev_sample(nets)
        if sd > 0:
            out["sharpe_annualized"] = round((mean / sd) * math.sqrt(252), 3)
        downside = [min(0, x) for x in nets]
        if any(d < 0 for d in downside):
            dd_sd = math.sqrt(sum(d * d for d in downside) / len(downside))
            if dd_sd > 0:
                out["sortino"] = round((mean / dd_sd) * math.sqrt(252), 3)
    return out


def _decay_metrics(deals_sorted, now_ts):
    if len(deals_sorted) < 5:
        return {"net_30d": 0.0, "net_90d": 0.0, "slope_lifetime": None,
                "slope_recent_90d": None, "decay_ratio": None, "decay_flag": False}
    cutoff_30 = now_ts - 30 * 86400
    cutoff_90 = now_ts - 90 * 86400
    net_30d = round(sum(d["net"] for d in deals_sorted if d["time"] >= cutoff_30), 2)
    net_90d = round(sum(d["net"] for d in deals_sorted if d["time"] >= cutoff_90), 2)
    t0 = deals_sorted[0]["time"]
    xs, ys, cum = [], [], 0.0
    for d in deals_sorted:
        cum += d["net"]
        xs.append((d["time"] - t0) / 86400.0)
        ys.append(cum)
    slope_lifetime = _linear_slope(xs, ys)
    xs_r = [x for x in xs if (t0 + x * 86400) >= cutoff_90]
    ys_r = ys[len(xs) - len(xs_r):]
    slope_recent = _linear_slope(xs_r, ys_r) if len(xs_r) >= 3 else None
    decay_ratio, decay_flag = None, False
    if slope_lifetime and abs(slope_lifetime) > 1e-6 and slope_recent is not None:
        decay_ratio = round(slope_recent / slope_lifetime, 3)
        if slope_lifetime > 0 and (slope_recent < 0 or decay_ratio < 0.3):
            decay_flag = True
    return {
        "net_30d": net_30d,
        "net_90d": net_90d,
        "slope_lifetime": round(slope_lifetime, 4) if slope_lifetime is not None else None,
        "slope_recent_90d": round(slope_recent, 4) if slope_recent is not None else None,
        "decay_ratio": decay_ratio,
        "decay_flag": decay_flag,
    }


def _aggregate_bot(deals, login, magic, now_ts):
    """Port of aggregate_bots() for a single magic (window deals only)."""
    dd = sorted(deals, key=lambda x: x["time"])
    nets = [d["net"] for d in dd]
    wins = [n for n in nets if n > 0]
    losses = [n for n in nets if n < 0]
    total_wins = sum(wins)
    total_losses = sum(losses)
    times = [d["time"] for d in dd]
    avg_win = (total_wins / len(wins)) if wins else 0
    avg_loss = (total_losses / len(losses)) if losses else 0
    win_rate = (len(wins) / len(dd)) if dd else 0
    net_profit = round(sum(nets), 2)
    risk = _risk_metrics(nets)
    rec = {
        "magic": magic,
        "account_login": login,
        "symbols": sorted({d["symbol"] for d in dd}),
        "trades": len(dd),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_pct": round(win_rate * 100, 2),
        "net_profit": net_profit,
        "gross_profit": round(total_wins, 2),
        "gross_loss": round(total_losses, 2),
        "profit_factor": round(total_wins / abs(total_losses), 3) if total_losses else None,
        "avg_win": round(avg_win, 2),
        "avg_loss": round(avg_loss, 2),
        "expectancy": round(avg_win * win_rate + avg_loss * (1 - win_rate), 2),
        "best_trade": round(max(nets), 2) if nets else 0,
        "worst_trade": round(min(nets), 2) if nets else 0,
        "first_trade": datetime.fromtimestamp(times[0], tz=timezone.utc).isoformat() if times else None,
        "last_trade": datetime.fromtimestamp(times[-1], tz=timezone.utc).isoformat() if times else None,
    }
    rec.update(risk)
    rec.update(_risk_adjusted_metrics(dd, net_profit, risk.get("max_drawdown") or 0))
    rec.update(_consistency_metrics(dd))
    rec.update(_decay_metrics(dd, now_ts))
    return rec


def _daily_equity_series(trades, account_balance):
    """Port of _build_daily_equity_series() (per-bot file, FULL history)."""
    if not trades:
        return []
    by_day = defaultdict(float)
    for t in trades:
        day = datetime.fromtimestamp(t["close_time"], tz=timezone.utc).date().isoformat()
        by_day[day] += t["net"]
    series = []
    cum = peak_cum = 0.0
    base = max(1.0, float(account_balance or 1.0))
    peak_eq = base
    for day, net in sorted(by_day.items()):
        cum += net
        peak_cum = max(peak_cum, cum)
        bot_eq = base + cum
        peak_eq = max(peak_eq, bot_eq)
        dd_abs = max(0.0, peak_eq - bot_eq)
        series.append({
            "date": day,
            "cum_net": round(cum, 2),
            "daily_net": round(net, 2),
            "peak": round(peak_cum, 2),
            "dd_abs": round(dd_abs, 2),
            "dd_pct": round((dd_abs / base) * 100.0, 3),
        })
    return series


def _per_bot_payload(login, magic, trades, balance):
    """Port of export_per_bot_files() payload (FULL history)."""
    nets = [t["net"] for t in trades]
    cum = peak = max_dd = 0.0
    for n in nets:
        cum += n
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)
    wins = sum(1 for n in nets if n > 0)
    return {
        "login": login,
        "magic": magic,
        "account_balance": round(float(balance or 0), 2),
        "symbols": sorted({t["symbol"] for t in trades}),
        "trade_count": len(trades),
        "wins": wins,
        "losses": len(trades) - wins,
        "win_rate_pct": round((wins / len(trades)) * 100, 2) if trades else 0,
        "net_profit": round(sum(nets), 2),
        "max_drawdown_abs": round(max_dd, 2),
        "first_trade_time": trades[0]["open_time"],
        "last_trade_time": trades[-1]["close_time"],
        "daily_equity_series": _daily_equity_series(trades, balance),
        "trades": trades,
    }


# --- public API ---------------------------------------------------------------

def build_data_dir(root, seed: int = DEFAULT_SEED, anchor: date | None = None):
    """Create <root>/data/ with snapshot.json, snapshot_<vps>.json and per-bot files.

    Returns the path to the data dir. `root` should be a tmp dir: post_merge.py
    also writes SYNC_STATUS.md into `<data_dir>/..`.
    """
    root = str(root)
    now_dt = datetime.now(timezone.utc)
    # Last trading day = yesterday, so no trade is ever dated in the future and
    # `generated_at` can be the true wall clock (a future-dated snapshot would be
    # flagged stale by compute_vps_freshness: lag < -300s).
    anchor = anchor or (now_dt.date() - timedelta(days=1))
    now_ts = int(now_dt.timestamp())
    window_cutoff = now_ts - WINDOW_DAYS * 86400

    for spec in ARCHETYPES:
        k = spec[6]
        for cut in ENGINE_CUTOFF_DAYS:
            assert (cut - 1) % k, (
                f"every_k={k} lands a trading day on the {cut}d cutoff: scores "
                f"would depend on the hour the suite runs"
            )
        assert abs(_worst_normal_day(spec)) > 1.0, (
            f"{spec[0]}: a normal day is not unambiguously signed; "
            f"months_positive_pct would drift with the calendar"
        )

    data_dir = os.path.join(root, "data")
    os.makedirs(data_dir, exist_ok=True)

    balances = {login: bal for login, _v, bal, _r in ACCOUNTS}
    vps_of = {login: v for login, v, _b, _r in ACCOUNTS}

    accounts = []
    for login, vps, bal, is_real in ACCOUNTS:
        accounts.append({
            "login": login,
            "server": "SynthBroker-Demo" if not is_real else "SynthBroker-Live",
            "name": f"synthetic-{login}",
            "balance": bal,
            "equity": round(bal + 12.5, 2),
            "margin": 100.0,
            "free_margin": round(bal - 100.0, 2),
            "margin_level_pct": 1200.0,
            "profit": 12.5,
            "currency": "USD",
            "leverage": 100,
            "trade_mode": 2 if is_real else 0,
            "is_real": bool(is_real),
            "vps": vps,
        })

    bots = []
    per_bot_files = {}
    for spec in ARCHETYPES:
        name, vps, login, magic, symbol = spec[0], spec[1], spec[2], spec[3], spec[4]
        rng = random.Random(f"{seed}-{magic}")
        trades = _gen_trades(rng, spec, anchor)
        bal = balances[login]

        # per-bot file: FULL history (what post_merge/reconcile read).
        per_bot_files[(vps, login, magic)] = _per_bot_payload(login, magic, trades, bal)

        # snapshot record: LAST 365 DAYS ONLY (what the VPS builder emits).
        window_deals = [{"magic": t["magic"], "symbol": t["symbol"],
                         "time": t["close_time"], "net": t["net"]}
                        for t in trades if t["close_time"] >= window_cutoff]
        rec = _aggregate_bot(window_deals, login, magic, now_ts)
        rec["vps"] = vps
        rec["archetype"] = name  # fixture-only tag, ignored by the engine
        bots.append(rec)

    bots.sort(key=lambda b: b["net_profit"], reverse=True)

    for (vps, login, magic), payload in per_bot_files.items():
        d = os.path.join(data_dir, "bots", vps)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{login}-{magic}.json"), "w") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    generated_at = now_dt.isoformat()
    real_accounts = [a for a in accounts if a.get("is_real")]
    real_logins = {a["login"] for a in real_accounts}

    per_vps = {}
    for v in sorted({a["vps"] for a in accounts}):
        v_accounts = [a for a in accounts if a["vps"] == v]
        v_bots = [b for b in bots if b["vps"] == v]
        per_vps[v] = {
            "generated_at": generated_at,
            "account_count": len(v_accounts),
            "bot_count": len(v_bots),
            "errors": [],
            "stale": False,
        }
        # snapshot_<vps>.json — compute_vps_freshness() reads these.
        with open(os.path.join(data_dir, f"snapshot_{v}.json"), "w") as f:
            json.dump({
                "generated_at": generated_at,
                "window_days": WINDOW_DAYS,
                "history_start": HISTORY_START,
                "builder_version": BUILDER_VERSION,
                "carried_forward": False,
                "portfolio": {
                    "total_balance": round(sum(a["balance"] for a in v_accounts), 2),
                    "total_equity": round(sum(a["equity"] for a in v_accounts), 2),
                    "total_open_margin": round(sum(a["margin"] for a in v_accounts), 2),
                    "total_unrealised_pnl": round(sum(a["profit"] for a in v_accounts), 2),
                    "account_count": len(v_accounts),
                    "currency": "USD",
                },
                "accounts": v_accounts,
                "bots": v_bots,
                "open_positions": [],
                "errors": [],
            }, f, ensure_ascii=False, separators=(",", ":"))

    # VPS present in the registry but with no synthetic account: emit a fresh but
    # empty snapshot so compute_vps_freshness() does not mark the run partial.
    for v in vps_ids():
        p = os.path.join(data_dir, f"snapshot_{v}.json")
        if os.path.exists(p):
            continue
        with open(p, "w") as f:
            json.dump({
                "generated_at": generated_at, "window_days": WINDOW_DAYS,
                "history_start": HISTORY_START, "builder_version": BUILDER_VERSION,
                "carried_forward": False,
                "portfolio": {"total_balance": 0, "total_equity": 0,
                              "total_open_margin": 0, "total_unrealised_pnl": 0,
                              "account_count": 0, "currency": "USD"},
                "accounts": [], "bots": [], "open_positions": [], "errors": [],
            }, f, ensure_ascii=False, separators=(",", ":"))

    snapshot = {
        "generated_at": generated_at,
        "numbering_epoch": "2026-07-27",
        "oldest_source_generated_at": generated_at,
        "newest_source_generated_at": generated_at,
        "window_days": WINDOW_DAYS,
        "history_start": HISTORY_START,
        "builder_version": BUILDER_VERSION,
        "vps_sources": per_vps,
        "stale_vps": [],
        "portfolio": {
            "total_balance": round(sum(a["balance"] for a in accounts), 2),
            "total_equity": round(sum(a["equity"] for a in accounts), 2),
            "total_open_margin": round(sum(a["margin"] for a in accounts), 2),
            "total_unrealised_pnl": round(sum(a["profit"] for a in accounts), 2),
            "account_count": len(accounts),
            "vps_count": len(per_vps),
            "currency": "USD",
        },
        "real_portfolio": {
            "total_balance": round(sum(a["balance"] for a in real_accounts), 2),
            "total_equity": round(sum(a["equity"] for a in real_accounts), 2),
            "total_unrealised_pnl": round(sum(a["profit"] for a in real_accounts), 2),
            "total_open_margin": round(sum(a["margin"] for a in real_accounts), 2),
            "account_count": len(real_accounts),
            "accounts": real_accounts,
            "open_positions": [],
        },
        "accounts": accounts,
        "bots": bots,
        "open_positions": [],
        "top_bot": bots[0] if bots else None,
        "errors": [],
    }
    assert real_logins, "fixture must contain at least one real account"

    with open(os.path.join(data_dir, "snapshot.json"), "w") as f:
        json.dump(snapshot, f, ensure_ascii=False, separators=(",", ":"))

    return data_dir


def bot_key(bot) -> str:
    """The key the backend uses everywhere: '<vps>-<login>-<magic>'."""
    return f"{bot['vps']}-{bot['account_login']}-{bot['magic']}"


if __name__ == "__main__":  # manual smoke: python3 tests/fixtures/synth.py /tmp/x
    import sys
    out = build_data_dir(sys.argv[1] if len(sys.argv) > 1 else ".")
    snap = json.load(open(os.path.join(out, "snapshot.json")))
    print(f"wrote {out}: {len(snap['bots'])} bots, {len(snap['accounts'])} accounts")
    for b in snap["bots"]:
        print(f"  {b['archetype']:14s} {bot_key(b):22s} trades365={b['trades']:4d} "
              f"net365={b['net_profit']:9.2f} months={b.get('months_active')} "
              f"dd={b.get('max_drawdown')} pf={b.get('profit_factor')}")
