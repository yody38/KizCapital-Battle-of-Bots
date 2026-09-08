"""Pins the SIX hard gates of `compute_score()` and the TRUST classification
that decides who may hold a READY/NEAR (real-money) seat.

A gate is not a score: failing one sends a bot to "NO" no matter how good it
looks. These are the rules that stand between a synthetic edge and real money,
so they are pinned by value AND by the exact reason string the UI shows.
"""
from __future__ import annotations

import inspect
import re

import pytest

import post_merge as pm

BALANCE = 10000.0


def bot(**over):
    """A bot that passes all six gates; override one field to break one gate."""
    base = {
        "vps": "vps1", "account_login": 900001, "magic": 5001,
        "trades": 100, "months_active": 12, "max_drawdown": 100.0,
        "net_profit": 500.0, "decay_flag": False, "decay_ratio": 0.9,
        "win_rate_pct": 65.0, "profit_factor": 2.0, "calmar": 2.0,
        "sortino": 1.5, "months_positive_pct": 90.0, "trades_90d": 30,
    }
    base.update(over)
    return base


# --- the six gates ------------------------------------------------------------

def test_gating_config_is_pinned():
    assert pm.GATING == {
        "min_trades": 30,
        "min_months_active": 3,
        "max_drawdown_pct_of_balance": 10.0,
        "min_net_profit": 0.0,
        "exclude_decay_flag": True,
        "exclude_magic_zero": True,
    }


def test_a_clean_bot_passes_all_six_gates():
    res = pm.compute_score(bot(), BALANCE)
    assert res["gating"] == {
        "min_trades": True, "min_months_active": True, "dd_under_cap": True,
        "net_profitable": True, "no_decay_flag": True, "valid_magic": True,
    }
    assert res["fails"] == []
    # SURPRISE worth knowing: passing every gate does NOT mean "not NO".
    # compute_score runs BEFORE the per-bot enrichments exist, so net_return /
    # oos_robustness / safety / tail_quality / significance are still 0.0
    # placeholders (36% of the weight). A gate-clean bot therefore scores low
    # here and is re-scored in main()'s pass 5b.
    assert res["status"] == next(s for s, t in pm.STATUS if res["score"] >= t)


@pytest.mark.parametrize("override,gate,reason", [
    ({"trades": 29}, "min_trades", "trades < 30"),
    ({"trades": 0}, "min_trades", "trades < 30"),
    ({"months_active": 2}, "min_months_active", "meses activo < 3"),
    ({"months_active": None}, "min_months_active", "meses activo < 3"),
    ({"max_drawdown": 1001.0}, "dd_under_cap", "DD 10.0% > 10.0%"),
    ({"net_profit": 0.0}, "net_profitable", "net profit ≤ 0"),
    ({"net_profit": -1.0}, "net_profitable", "net profit ≤ 0"),
    ({"decay_flag": True}, "no_decay_flag", "decay detectado"),
    ({"magic": 0}, "valid_magic", "magic = 0"),
])
def test_each_gate_fails_alone_and_forces_status_NO(override, gate, reason):
    res = pm.compute_score(bot(**override), BALANCE)
    assert res["gating"][gate] is False
    assert res["status"] == "NO"
    assert reason in res["fails"]
    assert len(res["fails"]) == 1, f"expected only {gate} to fail: {res['fails']}"


def test_drawdown_gate_is_a_percentage_of_ACCOUNT_BALANCE():
    """Same absolute DD, different account: the gate is relative."""
    assert pm.compute_score(bot(max_drawdown=900.0), 10000.0)["gating"]["dd_under_cap"] is True
    assert pm.compute_score(bot(max_drawdown=900.0), 5000.0)["gating"]["dd_under_cap"] is False


def test_drawdown_gate_is_fail_OPEN_when_it_cannot_be_computed():
    """No balance, or no max_drawdown => dd_pct is None => the gate PASSES and
    `dd_pct_of_balance` is None. An un-measurable drawdown does not block a seat."""
    for b, bal in ((bot(max_drawdown=None), BALANCE), (bot(), 0), (bot(), None)):
        res = pm.compute_score(b, bal)
        assert res["gating"]["dd_under_cap"] is True
        assert res["dd_pct_of_balance"] is None


def test_net_profit_gate_is_strictly_greater_than_zero():
    assert pm.compute_score(bot(net_profit=0.01), BALANCE)["gating"]["net_profitable"] is True
    assert pm.compute_score(bot(net_profit=0.0), BALANCE)["gating"]["net_profitable"] is False


def test_net_profit_gate_reads_the_commission_BLIND_field_KNOWN_DEFECT():
    """compute_score gates on `net_profit`, which reconcile_snapshot recomputes as
    profit+swap (no commission). The commission-honest figure
    (`net_after_commission`) is only applied later, in main()'s candidate pool."""
    src = inspect.getsource(pm.compute_score)
    assert 'bot.get("net_profit", 0)' in src
    # (the identifier appears in a comment inside compute_score; what matters is
    # that the field is never READ here)
    assert 'get("net_after_commission"' not in src


# --- status thresholds and seat caps -----------------------------------------

def test_status_thresholds_are_pinned():
    assert pm.STATUS == [("READY", 75), ("NEAR", 60), ("WATCH", 40), ("NO", 0)]


def test_status_rank_caps_are_pinned():
    assert pm.STATUS_RANK_CAPS == {"READY": 3, "NEAR": 5, "WATCH": 15}


@pytest.mark.parametrize("score,expected", [
    (100.0, "READY"), (75.0, "READY"), (74.9, "NEAR"),
    (60.0, "NEAR"), (59.9, "WATCH"), (40.0, "WATCH"), (39.9, "NO"), (0.0, "NO"),
])
def test_threshold_status_is_the_first_bucket_at_or_below_the_score(score, expected):
    assert next(s for s, t in pm.STATUS if score >= t) == expected


# --- TRUST: who may hold a real-money seat -----------------------------------

def test_trust_thresholds_are_pinned():
    assert pm.TRUST == {
        "min_shrunk": 58.0,
        "min_cohort_n": 3,
        "min_months_evidence": 4,
        "max_shrink_delta": 12.0,
        "min_win_rate": 50.0,
        "max_dormant_days": 14,
        "max_corr_vs_real": 0.7,
        "enforce_sqn_malo": True,
    }


def _seat_block_source():
    """`_seat_block` is a CLOSURE inside main() (it captures _shrunk and the env
    flag), so it cannot be imported and called. Its classification is pinned by
    reading the source — which still fails loudly if a reason is moved between
    the HARD and the SOFT bucket."""
    src = inspect.getsource(pm.main)
    m = re.search(r"def _seat_block\(b\):(.*?)return \(len\(hard\) == 0\)", src, re.S)
    assert m, "_seat_block no longer exists in main() — the seating rules moved"
    return m.group(1)


def test_hard_seat_blocks_are_exactly_dormant_clones_real_and_sqn_malo():
    body = _seat_block_source()
    hard = set(re.findall(r'hard\.append\("([^"]+)"\)', body))
    assert hard == {"dormant", "clones_real", "sqn_malo"}, (
        "a HARD block can NEVER hold a READY/NEAR seat — moving one here or out "
        "of here changes which bots can be proposed for real money"
    )


def test_soft_seat_blocks_only_downgrade_to_provisional():
    body = _seat_block_source()
    soft = set(re.findall(r'soft\.append\("([^"]+)"\)', body))
    assert {"shrunk<min", "no_evidence", "inflated", "wr<min"} <= soft
    # gap_contradice is SOFT but only when GAP_CONTRADICE_ENFORCE=1 (shadow flip).
    assert "gap_contradice" in soft
    assert 'os.environ.get("GAP_CONTRADICE_ENFORCE") == "1"' in body


def test_evidence_is_cohort_size_OR_months_not_AND():
    """A genuine grinder with a tiny peer cohort must not be expelled for that
    alone — the two evidence sources are alternatives."""
    body = _seat_block_source()
    assert re.search(r'cohort_n.*\n?.*min_cohort_n.*\n?.*or.*\n?.*min_months_evidence',
                     body), "evidence check is no longer an OR"


def test_dormancy_uses_days_since_last_trade_and_the_14_day_threshold():
    body = _seat_block_source()
    assert 'b.get("days_since_last_trade")' in body
    assert 'TRUST["max_dormant_days"]' in body
