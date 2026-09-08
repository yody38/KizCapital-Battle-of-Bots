"""CHARACTERIZATION of `scripts/reconcile_snapshot.py`.

reconcile_snapshot runs between the merge and post_merge, and it is the step
that decides what "trades", "net_profit" and "win_rate_pct" MEAN in the
published snapshot. Three of its behaviours are load-bearing defects that the
scoring engine then consumes as if they were consistent:

  1. it replaces the builder's 365-DAY aggregates with LIFETIME aggregates,
     while leaving `months_active`, `calmar`, `max_drawdown`, `profit_factor`
     (all 365-day) untouched — so a single bot record mixes two windows;
  2. it counts a win as `profit + swap > 0`, i.e. COMMISSION-BLIND, so a bot
     that loses money on every single trade after costs can publish a 100%
     win rate and a positive net_profit;
  3. it recomputes `gross_profit` / `gross_loss` but NOT `profit_factor`, so
     the published PF stops being derivable from the published grosses.

None of this is asserted to be correct. It is asserted to be TODAY'S
behaviour, so that a refactor of the scoring engine cannot change it by
accident. When a fix lands, these tests are the checklist of what changes.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

import reconcile_snapshot as rs

# The 9 fields the module's own docstring promises to refresh.
OVERWRITTEN = [
    "trades", "net_profit", "wins", "losses", "win_rate_pct",
    "gross_profit", "gross_loss", "first_trade", "last_trade",
]


@pytest.fixture
def wired(fresh_data_dir, monkeypatch):
    """Point the module's hard-coded module-level paths at the tmp data dir.

    NOTE (surprise worth knowing): reconcile_snapshot resolves DATA_DIR /
    SNAPSHOT / BOTS_DIR at import time from `__file__`, so it can only ever
    reconcile the repo's own data dir. There is no CLI argument and no
    injection point — a test (or a second data set) must monkeypatch it.
    """
    data_dir = Path(fresh_data_dir)
    monkeypatch.setattr(rs, "DATA_DIR", data_dir)
    monkeypatch.setattr(rs, "SNAPSHOT", data_dir / "snapshot.json")
    monkeypatch.setattr(rs, "BOTS_DIR", data_dir / "bots")
    return data_dir


def _snap(data_dir):
    with open(os.path.join(str(data_dir), "snapshot.json")) as f:
        return json.load(f)


def _bot(snap, magic):
    return next(b for b in snap["bots"] if b["magic"] == magic)


def _per_bot(data_dir, vps, login, magic):
    p = Path(data_dir) / "bots" / vps / f"{login}-{magic}.json"
    return json.loads(p.read_text())


def _write_per_bot(data_dir, vps, login, magic, trades):
    d = Path(data_dir) / "bots" / vps
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{login}-{magic}.json").write_text(json.dumps({
        "login": login, "magic": magic, "account_balance": 10000.0,
        "symbols": ["EURUSD"], "trade_count": len(trades),
        "daily_equity_series": [], "trades": trades,
    }))


def _trade(ticket, profit, swap, commission, close_time):
    return {
        "ticket": ticket, "magic": 5099, "symbol": "EURUSD", "side": "BUY",
        "volume": 0.01, "open_time": close_time - 3600, "close_time": close_time,
        "open_price": 1.1, "close_price": 1.1005, "pips": 5.0,
        "profit": profit, "swap": swap, "commission": commission,
        "net": round(profit + commission + swap, 2),
        "duration_sec": 3600, "comment": "synthetic",
    }


# --- 1. window mixing ---------------------------------------------------------

def test_reconcile_replaces_365d_aggregates_with_lifetime_KNOWN_DEFECT(wired):
    """The builder aggregates the LAST 365 DAYS (snapshot_builder WINDOW_DAYS=365)
    but the per-bot file holds the FULL history, so reconcile silently promotes
    a 365-day record to a lifetime one."""
    snap = _snap(wired)
    bot = _bot(snap, 5001)                      # old_grinder_a: ~36 months of history
    pb = _per_bot(wired, "vps1", 900001, 5001)

    trades_365d = bot["trades"]
    assert trades_365d < len(pb["trades"]), "fixture must have >365d of history"

    updated, reason = rs.reconcile_bot(bot)

    assert reason is None
    assert updated is True
    assert bot["trades"] == len(pb["trades"])   # now LIFETIME
    assert bot["trades"] > trades_365d


def test_window_dependent_fields_are_left_on_the_365d_window_KNOWN_DEFECT(wired):
    """After reconcile, one bot record mixes two windows: trades/net_profit are
    lifetime while months_active/max_drawdown/calmar/profit_factor are still the
    builder's 365-day values. `norm_net_return` then divides lifetime money by
    365-day months."""
    snap = _snap(wired)
    bot = _bot(snap, 5001)
    before = {k: bot.get(k) for k in
              ("months_active", "max_drawdown", "calmar", "sortino", "profit_factor")}

    rs.reconcile_bot(bot)

    for k, v in before.items():
        assert bot.get(k) == v, f"{k} unexpectedly recomputed"


def test_first_and_last_trade_become_lifetime_close_times(wired):
    snap = _snap(wired)
    bot = _bot(snap, 5001)
    pb = _per_bot(wired, "vps1", 900001, 5001)

    rs.reconcile_bot(bot)

    assert bot["first_trade"] == rs.to_iso(pb["trades"][0]["close_time"])
    assert bot["last_trade"] == rs.to_iso(pb["trades"][-1]["close_time"])
    # ... including the fact that `first_trade` is the first CLOSE, never the
    # first OPEN, even though the per-bot file carries open_time.
    assert pb["trades"][0]["open_time"] != pb["trades"][0]["close_time"]


# --- 2. commission blindness --------------------------------------------------

def test_win_rate_is_recomputed_without_commission_KNOWN_DEFECT(wired):
    """`wins` counts `profit + swap > 0`. Commission is never subtracted, so a
    bot that lost money on EVERY trade after costs publishes a 100% win rate."""
    trades = [_trade(i, profit=1.00, swap=0.0, commission=-2.50,
                     close_time=1_750_000_000 + i * 86400) for i in range(10)]
    assert all(t["net"] < 0 for t in trades), "every trade must lose after costs"

    _write_per_bot(wired, "vps1", 900001, 5099, trades)
    bot = {"vps": "vps1", "account_login": 900001, "magic": 5099,
           "trades": 0, "net_profit": 0.0, "win_rate_pct": 0.0,
           "wins": 0, "losses": 0, "gross_profit": 0.0, "gross_loss": 0.0}

    rs.reconcile_bot(bot)

    assert bot["wins"] == 10
    assert bot["losses"] == 0
    assert bot["win_rate_pct"] == 100.0
    # The honest figure, had commission been included:
    assert sum(1 for t in trades if t["net"] > 0) == 0


def test_net_profit_excludes_commission_KNOWN_DEFECT(wired):
    """net_profit = sum(profit + swap). The per-bot `net` field (which the
    builder computes as profit + commission + swap) is ignored, so the
    published net_profit overstates the money by the whole commission bill."""
    trades = [_trade(i, profit=1.00, swap=0.0, commission=-2.50,
                     close_time=1_750_000_000 + i * 86400) for i in range(10)]
    _write_per_bot(wired, "vps1", 900001, 5099, trades)
    bot = {"vps": "vps1", "account_login": 900001, "magic": 5099,
           "trades": 0, "net_profit": 0.0}

    rs.reconcile_bot(bot)

    assert bot["net_profit"] == 10.00                      # profit + swap only
    assert round(sum(t["net"] for t in trades), 2) == -15.00   # the real money
    assert bot["gross_profit"] == 10.00
    assert bot["gross_loss"] == 0.0


def test_commission_blindness_can_flip_the_sign_of_a_bot(wired):
    """This is why it matters: the gate `net_profit > 0` in post_merge.compute_score
    is evaluated on the commission-blind figure."""
    trades = [_trade(i, profit=0.50, swap=-0.10, commission=-1.00,
                     close_time=1_750_000_000 + i * 86400) for i in range(40)]
    _write_per_bot(wired, "vps1", 900001, 5099, trades)
    bot = {"vps": "vps1", "account_login": 900001, "magic": 5099,
           "trades": 0, "net_profit": 0.0}

    rs.reconcile_bot(bot)

    assert bot["net_profit"] > 0            # passes the gate
    assert sum(t["net"] for t in trades) < 0  # actually lost money


# --- 3. profit_factor left stale ---------------------------------------------

def test_profit_factor_is_not_recomputed_KNOWN_DEFECT(wired):
    """gross_profit and gross_loss ARE overwritten with lifetime values, but
    profit_factor is not, so the published PF is no longer derivable from the
    published grosses."""
    snap = _snap(wired)
    bot = _bot(snap, 5001)
    pf_before = bot["profit_factor"]
    assert pf_before is not None

    rs.reconcile_bot(bot)

    assert bot["profit_factor"] == pf_before
    derivable = round(bot["gross_profit"] / abs(bot["gross_loss"]), 3)
    assert bot["profit_factor"] != derivable, (
        "PF now happens to match the recomputed grosses — the fixture must keep "
        "a lifetime window that differs from the 365d one for this to be a test"
    )


# --- 4. the exact blast radius ------------------------------------------------

def test_only_the_nine_documented_fields_are_overwritten(wired):
    """Any PRE-EXISTING key whose value changes must be one of the 9. (The
    Fase 1-B additions — *_365d / *_lifetime / return_monthly_pct_* — are new
    keys, not overwrites, so they do not appear here.)"""
    snap = _snap(wired)
    bot = _bot(snap, 5001)
    before = dict(bot)

    rs.reconcile_bot(bot)

    changed = {k for k in before if bot.get(k) != before[k]}
    assert changed <= set(OVERWRITTEN), f"unexpected overwrite: {changed - set(OVERWRITTEN)}"
    assert "trades" in changed and "net_profit" in changed


def test_missing_per_bot_file_leaves_the_bot_untouched(wired):
    bot = {"vps": "vps1", "account_login": 900001, "magic": 5098,
           "trades": 7, "net_profit": 42.0}
    updated, reason = rs.reconcile_bot(bot)
    assert (updated, reason) == (False, "per-bot missing")
    assert bot == {"vps": "vps1", "account_login": 900001, "magic": 5098,
                   "trades": 7, "net_profit": 42.0}


def test_unreadable_per_bot_file_leaves_the_bot_untouched(wired):
    d = Path(wired) / "bots" / "vps1"
    (d / "900001-5097.json").write_text("{not json")
    bot = {"vps": "vps1", "account_login": 900001, "magic": 5097, "trades": 7}
    updated, reason = rs.reconcile_bot(bot)
    assert (updated, reason) == (False, "per-bot unreadable")


def test_bot_without_vps_or_magic_is_a_silent_noop(wired):
    """No reason string is returned, so these bots are invisible in the run log."""
    assert rs.reconcile_bot({"account_login": 900001, "magic": 5001}) == (False, None)
    assert rs.reconcile_bot({"vps": "vps1", "magic": 5001}) == (False, None)
    assert rs.reconcile_bot({"vps": "vps1", "account_login": 900001, "magic": 0}) == (False, None)


# --- 5. main() ----------------------------------------------------------------

def test_main_skips_magic_zero_sorts_by_net_profit_and_stamps_reconciled_at(wired):
    snap = _snap(wired)
    snap["bots"].append({"vps": "vps1", "account_login": 900001, "magic": 0,
                         "trades": 3, "net_profit": 999999.0})
    (Path(wired) / "snapshot.json").write_text(json.dumps(snap))

    assert rs.main() == 0

    out = _snap(wired)
    zero = _bot(out, 0)
    assert zero["trades"] == 3, "magic 0 must never be reconciled"
    nets = [b.get("net_profit", 0) for b in out["bots"]]
    assert nets == sorted(nets, reverse=True)
    assert out["reconciled_at"]


def test_reconcile_is_idempotent(wired):
    assert rs.main() == 0
    first = _snap(wired)
    assert rs.main() == 0
    second = _snap(wired)
    for a, b in zip(first["bots"], second["bots"]):
        for k in OVERWRITTEN:
            assert a.get(k) == b.get(k)
