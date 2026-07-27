"""Battle of Bots - snapshot builder with per-bot full history export.

v2 (2026-05-03): adds risk-adjusted, consistency and decay metrics per bot,
plus daily_equity_series in each per-bot file (basis for correlation matrix
and Promotion Score computed Mac-side in post_merge.py).

Runs on the VPS. For each MT5 terminal:
- Computes 365d aggregates per magic (existing behavior).
- ALSO exports per-bot full trade history (since 2020-01-01) to C:\\mt5-mcp\\bots\\<login>-<magic>.json.
  Each per-bot file is a list of closed-trade objects + a daily_equity_series.

Atomic writes via .tmp -> rename. Stale per-bot files are removed at start.
Filter: only sync bots with at least one closed trade in the current calendar
year (UTC).
"""
from __future__ import annotations

import glob
import json
import math
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import MetaTrader5 as mt5

MT5_GLOB = r"C:\Program Files\MetaTrader 5 *\terminal64.exe"
WINDOW_DAYS = 365
HISTORY_START = datetime(2020, 1, 1)
DEFAULT_OUTPUT = r"C:\mt5-mcp\snapshot.json"
BOTS_DIR = r"C:\mt5-mcp\bots"


def _current_year_cutoff_unix():
    now = datetime.now(timezone.utc)
    return int(datetime(now.year, 1, 1, tzinfo=timezone.utc).timestamp())


def discover_terminals():
    return sorted(glob.glob(MT5_GLOB))


POSITION_TYPE_NAMES = {0: "BUY", 1: "SELL"}


def _pip_factor(symbol):
    s = (symbol or "").upper()
    if "JPY" in s:
        return 100.0
    if any(k in s for k in ("XAU", "XAG", "OIL", "BTC", "ETH")):
        return 10.0
    return 10000.0


def _trades_from_deals(deals):
    """Match IN/OUT deals by position_id to reconstruct closed trades."""
    by_pos = defaultdict(list)
    for d in deals:
        by_pos[d.position_id].append(d)
    trades = []
    for pos_id, ds in by_pos.items():
        ds_sorted = sorted(ds, key=lambda x: (x.time_msc, x.ticket))
        in_deal = next((x for x in ds_sorted if x.entry == 0), None)
        out_deals = [x for x in ds_sorted if x.entry in (1, 3)]
        if in_deal is None or not out_deals:
            continue
        last_out = out_deals[-1]
        total_profit = sum(x.profit for x in out_deals)
        total_swap = sum(x.swap for x in out_deals) + (in_deal.swap or 0)
        total_comm = sum(x.commission for x in out_deals) + (in_deal.commission or 0)
        side = "BUY" if in_deal.type == 0 else "SELL"
        open_price = in_deal.price
        close_price = last_out.price
        diff = close_price - open_price
        if side == "SELL":
            diff = -diff
        pips = round(diff * _pip_factor(in_deal.symbol), 1)
        net = round(total_profit + total_swap + total_comm, 2)
        trades.append({
            "ticket": int(pos_id),
            "magic": int(in_deal.magic or 0),
            "symbol": in_deal.symbol,
            "side": side,
            "volume": round(in_deal.volume, 2),
            "open_time": int(in_deal.time),
            "close_time": int(last_out.time),
            "open_price": round(open_price, 5),
            "close_price": round(close_price, 5),
            "pips": pips,
            "profit": round(total_profit, 2),
            "swap": round(total_swap, 2),
            "commission": round(total_comm, 2),
            "net": net,
            "duration_sec": int(last_out.time - in_deal.time),
            "comment": (in_deal.comment or "")[:120],
        })
    trades.sort(key=lambda t: t["close_time"])
    return trades


def fetch_terminal(path, days):
    if not mt5.initialize(path=path):
        return None, f"init_failed: {mt5.last_error()}"
    try:
        ai = mt5.account_info()
        to_dt = datetime.now()
        from_recent = to_dt - timedelta(days=days)
        deals_full = mt5.history_deals_get(HISTORY_START, to_dt) or []
        positions = mt5.positions_get() or []
        account = None
        if ai is not None:
            tm = getattr(ai, "trade_mode", None)
            account = {
                "login": ai.login,
                "server": ai.server,
                "name": ai.name,
                "balance": round(ai.balance, 2),
                "equity": round(ai.equity, 2),
                "margin": round(ai.margin, 2),
                "free_margin": round(ai.margin_free, 2),
                "margin_level_pct": ai.margin_level,
                "profit": round(ai.profit, 2),
                "currency": ai.currency,
                "leverage": ai.leverage,
                "trade_mode": tm,
                "is_real": tm == 2,
            }
        recent_cutoff = int(from_recent.timestamp())
        deals_recent = [d for d in deals_full if d.entry in (1, 3) and d.time >= recent_cutoff]
        recent_out = [
            {"magic": d.magic, "symbol": d.symbol, "time": d.time,
             "net": d.profit + d.commission + d.swap}
            for d in deals_recent
        ]
        full_trades = _trades_from_deals(deals_full)
        positions_out = [
            {
                "ticket": p.ticket,
                "login": ai.login if ai else None,
                "symbol": p.symbol,
                "type": POSITION_TYPE_NAMES.get(p.type, str(p.type)),
                "volume": p.volume,
                "price_open": p.price_open,
                "price_current": p.price_current,
                "sl": p.sl,
                "tp": p.tp,
                "profit": round(p.profit, 2),
                "swap": round(p.swap, 2),
                "time_open": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
                "magic": p.magic,
                "comment": p.comment,
            }
            for p in positions
        ]
        return {
            "account": account,
            "deals": recent_out,
            "positions": positions_out,
            "full_trades": full_trades,
        }, None
    finally:
        mt5.shutdown()
        time.sleep(0.15)


# --- Stats helpers --------------------------------------------------------

def _stdev(values):
    if len(values) < 2:
        return 0.0
    m = sum(values) / len(values)
    var = sum((x - m) ** 2 for x in values) / (len(values) - 1)
    return math.sqrt(var)


def _linear_slope(xs, ys):
    """Least-squares slope of y ~ x. Returns 0 if degenerate."""
    n = len(xs)
    if n < 2:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = 0.0
    den = 0.0
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
        if equity > peak:
            peak = equity
        dd = peak - equity
        if dd > max_dd:
            max_dd = dd
        if n < 0:
            cur_loss += 1; cur_win = 0
            if cur_loss > max_loss: max_loss = cur_loss
        elif n > 0:
            cur_win += 1; cur_loss = 0
            if cur_win > max_win: max_win = cur_win
    mean = sum(ordered_nets) / len(ordered_nets)
    var = sum((x - mean) ** 2 for x in ordered_nets) / len(ordered_nets)
    stdev = var ** 0.5
    sharpe = (mean / stdev) if stdev > 0 else None
    net = sum(ordered_nets)
    return {
        "max_drawdown": round(max_dd, 2),
        "recovery_factor": round(net / max_dd, 2) if max_dd > 0 else None,
        "max_consecutive_losses": max_loss,
        "max_consecutive_wins": max_win,
        "sharpe_like": round(sharpe, 3) if sharpe is not None else None,
        "stdev_per_trade": round(stdev, 2),
    }


def _daily_returns_from_deals(deals_sorted):
    """Aggregate deal nets to daily returns (UTC). Returns list of (date, net)."""
    by_day = defaultdict(float)
    for d in deals_sorted:
        day = datetime.fromtimestamp(d["time"], tz=timezone.utc).date().isoformat()
        by_day[day] += d["net"]
    return sorted(by_day.items())


def _monthly_aggregates(deals_sorted):
    """Group nets by YYYY-MM. Returns list of (month, net, trade_count)."""
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
    if not months:
        return {}
    months_active = len(months)
    nets = [m[1] for m in months]
    months_positive = sum(1 for n in nets if n > 0)
    months_positive_pct = round(months_positive / months_active * 100, 1)
    stdev_m = _stdev(nets)
    mean_m = sum(nets) / months_active if months_active else 0
    cov_m = (stdev_m / abs(mean_m)) if abs(mean_m) > 1e-6 else None
    cur_streak = max_streak = 0
    for n in nets:
        if n < 0:
            cur_streak += 1
            if cur_streak > max_streak:
                max_streak = cur_streak
        else:
            cur_streak = 0
    # Longest DD duration in days (equity curve over deals)
    cum = peak = 0.0
    in_dd = False
    dd_start_t = None
    longest_dd_days = 0
    for d in deals_sorted:
        cum += d["net"]
        if cum >= peak:
            peak = cum
            if in_dd and dd_start_t is not None:
                span = (d["time"] - dd_start_t) / 86400.0
                if span > longest_dd_days:
                    longest_dd_days = span
            in_dd = False
            dd_start_t = None
        else:
            if not in_dd:
                in_dd = True
                dd_start_t = d["time"]
    if in_dd and dd_start_t is not None:
        span = (deals_sorted[-1]["time"] - dd_start_t) / 86400.0
        if span > longest_dd_days:
            longest_dd_days = span
    return {
        "months_active": months_active,
        "months_positive": months_positive,
        "months_positive_pct": months_positive_pct,
        "monthly_net_stdev": round(stdev_m, 2),
        "monthly_net_cov": round(cov_m, 3) if cov_m is not None else None,
        "longest_losing_streak_months": max_streak,
        "longest_dd_duration_days": round(longest_dd_days, 1),
    }


def _risk_adjusted_metrics(deals_sorted, net_profit, max_drawdown):
    """Annualized Sharpe/Sortino from daily returns + Calmar."""
    daily = _daily_returns_from_deals(deals_sorted)
    out = {"calmar": None, "sharpe_annualized": None, "sortino": None}
    if max_drawdown and max_drawdown > 0:
        out["calmar"] = round(net_profit / max_drawdown, 2)
    if len(daily) >= 2:
        nets = [n for _, n in daily]
        mean = sum(nets) / len(nets)
        sd = _stdev(nets)
        if sd > 0:
            out["sharpe_annualized"] = round((mean / sd) * math.sqrt(252), 3)
        downside = [min(0, x) for x in nets]
        if any(d < 0 for d in downside):
            dd_sd = math.sqrt(sum(d * d for d in downside) / len(downside))
            if dd_sd > 0:
                out["sortino"] = round((mean / dd_sd) * math.sqrt(252), 3)
    return out


def _decay_metrics(deals_sorted):
    """Lifetime vs recent-90d slope of cumulative net (USD/day)."""
    if len(deals_sorted) < 5:
        return {"net_30d": 0.0, "net_90d": 0.0,
                "slope_lifetime": None, "slope_recent_90d": None,
                "decay_ratio": None, "decay_flag": False}
    now_ts = int(datetime.now(timezone.utc).timestamp())
    cutoff_30 = now_ts - 30 * 86400
    cutoff_90 = now_ts - 90 * 86400
    net_30d = round(sum(d["net"] for d in deals_sorted if d["time"] >= cutoff_30), 2)
    net_90d = round(sum(d["net"] for d in deals_sorted if d["time"] >= cutoff_90), 2)
    # Build cumulative series in days-from-first
    t0 = deals_sorted[0]["time"]
    xs_all = []
    ys_all = []
    cum = 0.0
    for d in deals_sorted:
        cum += d["net"]
        xs_all.append((d["time"] - t0) / 86400.0)
        ys_all.append(cum)
    slope_lifetime = _linear_slope(xs_all, ys_all)
    # Recent 90d slope
    xs_r = []
    ys_r = []
    for x, y in zip(xs_all, ys_all):
        # absolute time of this point:
        if (t0 + x * 86400) >= cutoff_90:
            xs_r.append(x)
            ys_r.append(y)
    slope_recent = _linear_slope(xs_r, ys_r) if len(xs_r) >= 3 else None
    decay_ratio = None
    decay_flag = False
    if slope_lifetime and abs(slope_lifetime) > 1e-6 and slope_recent is not None:
        decay_ratio = round(slope_recent / slope_lifetime, 3)
        # Flag: profitable lifetime but recent slope <0 OR <30% of lifetime slope
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


def aggregate_bots(deals, login):
    cutoff = _current_year_cutoff_unix()
    groups = defaultdict(list)
    for d in deals:
        groups[d["magic"]].append(d)
    bots = []
    for magic, dd in groups.items():
        if max(d["time"] for d in dd) < cutoff:
            continue
        dd_sorted = sorted(dd, key=lambda x: x["time"])
        nets = [d["net"] for d in dd_sorted]
        wins = [n for n in nets if n > 0]
        losses = [n for n in nets if n < 0]
        total_wins = sum(wins)
        total_losses = sum(losses)
        symbols = sorted({d["symbol"] for d in dd})
        times = [d["time"] for d in dd_sorted]
        avg_win = (total_wins / len(wins)) if wins else 0
        avg_loss = (total_losses / len(losses)) if losses else 0
        win_rate = (len(wins) / len(dd)) if dd else 0
        expectancy = round(avg_win * win_rate + avg_loss * (1 - win_rate), 2)
        risk = _risk_metrics(nets)
        net_profit = round(sum(nets), 2)
        risk_adj = _risk_adjusted_metrics(dd_sorted, net_profit, risk.get("max_drawdown") or 0)
        consistency = _consistency_metrics(dd_sorted)
        decay = _decay_metrics(dd_sorted)
        bots.append({
            "magic": magic,
            "account_login": login,
            "symbols": symbols,
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
            "expectancy": expectancy,
            "best_trade": round(max(nets), 2) if nets else 0,
            "worst_trade": round(min(nets), 2) if nets else 0,
            "first_trade": datetime.fromtimestamp(times[0], tz=timezone.utc).isoformat() if times else None,
            "last_trade": datetime.fromtimestamp(times[-1], tz=timezone.utc).isoformat() if times else None,
            **risk,
            **risk_adj,
            **consistency,
            **decay,
        })
    return bots


def _atomic_write(path, payload):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def _build_daily_equity_series(trades, account_balance):
    """For a single bot's full trade list: per-day cum_net + dd% vs account_balance."""
    if not trades:
        return []
    by_day = defaultdict(float)
    for t in trades:
        day = datetime.fromtimestamp(t["close_time"], tz=timezone.utc).date().isoformat()
        by_day[day] += t["net"]
    days = sorted(by_day.items())
    series = []
    cum = 0.0
    peak_cum = 0.0
    base = max(1.0, float(account_balance or 1.0))
    peak_eq = base
    for day, net in days:
        cum += net
        if cum > peak_cum:
            peak_cum = cum
        bot_eq = base + cum
        if bot_eq > peak_eq:
            peak_eq = bot_eq
        dd_abs = max(0.0, peak_eq - bot_eq)
        dd_pct = (dd_abs / base) * 100.0
        series.append({
            "date": day,
            "cum_net": round(cum, 2),
            "daily_net": round(net, 2),
            "peak": round(peak_cum, 2),
            "dd_abs": round(dd_abs, 2),
            "dd_pct": round(dd_pct, 3),
        })
    return series


def export_per_bot_files(login, full_trades, bots_dir, account_balance):
    """Write one file per (login, magic) with full trade history + daily_equity_series."""
    os.makedirs(bots_dir, exist_ok=True)
    cutoff = _current_year_cutoff_unix()
    by_magic = defaultdict(list)
    for t in full_trades:
        by_magic[t["magic"]].append(t)
    written = []
    for magic, trades in by_magic.items():
        trades.sort(key=lambda x: x["close_time"])
        if not trades:
            continue
        if trades[-1]["close_time"] < cutoff:
            continue
        nets = [t["net"] for t in trades]
        cum = 0.0
        peak = 0.0
        max_dd = 0.0
        for n in nets:
            cum += n
            if cum > peak:
                peak = cum
            dd = peak - cum
            if dd > max_dd:
                max_dd = dd
        wins = sum(1 for n in nets if n > 0)
        daily_series = _build_daily_equity_series(trades, account_balance)
        payload = {
            "login": login,
            "magic": magic,
            "account_balance": round(float(account_balance or 0), 2),
            "symbols": sorted({t["symbol"] for t in trades}),
            "trade_count": len(trades),
            "wins": wins,
            "losses": len(trades) - wins,
            "win_rate_pct": round((wins / len(trades)) * 100, 2) if trades else 0,
            "net_profit": round(sum(nets), 2),
            "max_drawdown_abs": round(max_dd, 2),
            "first_trade_time": trades[0]["open_time"],
            "last_trade_time": trades[-1]["close_time"],
            "daily_equity_series": daily_series,
            "trades": trades,
        }
        path = os.path.join(bots_dir, f"{login}-{magic}.json")
        _atomic_write(path, payload)
        written.append(f"{login}-{magic}")
    return written


READY_FILENAME = ".ready"


def main():
    paths = discover_terminals()
    accounts = []
    all_bots = []
    all_positions = []
    errors = []
    bot_files_written = []

    ready_path = os.path.join(BOTS_DIR, READY_FILENAME)

    # Remove the .ready flag FIRST so any mirror cycle running during this
    # builder cycle correctly observes "in-progress" (no .ready -> fail-closed).
    for stale in (ready_path, ready_path + ".tmp"):
        if os.path.exists(stale):
            try:
                os.remove(stale)
            except OSError:
                pass

    if os.path.isdir(BOTS_DIR):
        for f in os.listdir(BOTS_DIR):
            if f.endswith(".json"):
                try:
                    os.remove(os.path.join(BOTS_DIR, f))
                except OSError:
                    pass

    for path in paths:
        data, err = fetch_terminal(path, WINDOW_DAYS)
        if err:
            errors.append({"path": path, "error": err})
            continue
        acc = data["account"]
        if not acc:
            errors.append({"path": path, "error": "no_account_info"})
            continue
        accounts.append(acc)
        all_bots.extend(aggregate_bots(data["deals"], acc["login"]))
        all_positions.extend(data.get("positions", []))
        try:
            written = export_per_bot_files(
                acc["login"], data.get("full_trades", []), BOTS_DIR, acc.get("balance", 0)
            )
            bot_files_written.extend(written)
        except Exception as e:
            errors.append({"path": path, "error": f"per_bot_export_failed: {e}"})

    all_bots.sort(key=lambda b: b["net_profit"], reverse=True)

    total_balance = round(sum(a["balance"] for a in accounts), 2)
    total_equity = round(sum(a["equity"] for a in accounts), 2)
    total_margin = round(sum(a["margin"] for a in accounts), 2)
    total_profit = round(sum(a["profit"] for a in accounts), 2)

    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": WINDOW_DAYS,
        "history_start": HISTORY_START.isoformat(),
        "builder_version": "v2-2026-05-03",
        "portfolio": {
            "total_balance": total_balance,
            "total_equity": total_equity,
            "total_open_margin": total_margin,
            "total_unrealised_pnl": total_profit,
            "account_count": len(accounts),
            "currency": accounts[0]["currency"] if accounts else None,
        },
        "accounts": accounts,
        "bots": all_bots,
        "open_positions": all_positions,
        "top_bot": all_bots[0] if all_bots else None,
        "bot_files_count": len(bot_files_written),
        "errors": errors,
    }

    if "--stdout" in sys.argv:
        json.dump(snapshot, sys.stdout, ensure_ascii=False, indent=2)
        return

    out_path = DEFAULT_OUTPUT
    tmp_path = out_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, out_path)

    # Cycle-complete marker. Mirror.sh requires this file to exist and to be
    # consistent with snapshot.json before it considers the VPS data safe to
    # consume. Written atomically AFTER snapshot.json so any reader that sees
    # the .ready file is guaranteed to also see a finalized snapshot.
    _atomic_write(ready_path, {
        "ts": snapshot["generated_at"],
        "bot_count": len(all_bots),
        "bot_files_count": len(bot_files_written),
        "builder_version": snapshot["builder_version"],
    })

    print(f"OK wrote {out_path} bots={len(all_bots)} bot_files={len(bot_files_written)} errors={len(errors)}")


if __name__ == "__main__":
    main()
