"""CHARACTERIZATION of the v1 scoring norms in `scripts/post_merge.py`.

These tests do NOT say the numbers are right. They say "this is what the engine
computes TODAY". Every value below was read off the live v1 implementation, so
a refactor that changes any of them fails loudly instead of silently repricing
the fleet.

Two of the pinned behaviours are KNOWN DEFECTS. They are pinned on purpose and
named so, with the correct behaviour spelled out in the assertion message:

  · norm_oos          — `pct_folds_test_profitable` is emitted 0-100 by
                        walk_forward(), then fed to clamp01() with NO /100.
                        Any bot with >= 1% of profitable test folds scores the
                        same as one with 100%.
  · norm_significance — the lower bound of the bootstrap Sharpe CI (an
                        ANNUALIZED Sharpe) is added to 0.5, so anything with
                        lo >= 0.5 saturates at 1.0.

When the fix lands, these two tests are the ones to update (and the v2
counterparts in the engine's SCORE_CHANGELOG_V2 already describe the target).
"""
from __future__ import annotations

import pytest

import post_merge as pm

APPROX = dict(rel=0, abs=1e-9)


# --- weights ------------------------------------------------------------------

def test_weights_sum_to_one():
    assert sum(pm.WEIGHTS.values()) == pytest.approx(1.0, abs=1e-9)


def test_weight_of_each_component_is_pinned():
    assert pm.WEIGHTS == {
        "calmar": 0.15,
        "net_return": 0.15,
        "months_positive_pct": 0.11,
        "win_rate": 0.10,
        "sortino": 0.08,
        "decay": 0.08,
        "cadence": 0.06,
        "oos_robustness": 0.06,
        "safety": 0.06,
        "profit_factor": 0.05,
        "tail_quality": 0.04,
        "significance": 0.03,
        "age": 0.02,
        "trade_count": 0.01,
    }


def test_caps_are_pinned():
    assert pm.CAPS == {
        "calmar": 5.0,
        "sortino": 3.0,
        "profit_factor": 3.0,
        "age_months": 12.0,
        "trades_target": 200.0,
        "net_monthly_return_pct": 0.5,
        "win_rate_floor": 50.0,
        "win_rate_target": 90.0,
        "cadence_trades_per_month": 20.0,
    }


def test_every_weighted_component_is_produced_by_compute_score():
    """No weight may reference a component the scorer never fills (it would be
    silently worth 0)."""
    res = pm.compute_score({"magic": 1, "trades": 10}, 10000)
    assert set(pm.WEIGHTS) == set(res["components"])


# --- money / risk norms -------------------------------------------------------

@pytest.mark.parametrize("value,expected", [
    (None, 0.0), (0, 0.0), (-3.0, 0.0),
    (1.0, 0.2), (2.5, 0.5), (5.0, 1.0), (12.0, 1.0),
])
def test_norm_calmar(value, expected):
    assert pm.norm_calmar(value) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("value,expected", [
    (None, 0.0), (0, 0.0), (-1.0, 0.0),
    (0.75, 0.25), (1.5, 0.5), (3.0, 1.0), (9.0, 1.0),
])
def test_norm_sortino(value, expected):
    assert pm.norm_sortino(value) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("value,expected", [
    (None, 0.0), (0.5, 0.0), (1.0, 0.0),
    (1.5, 0.25), (2.0, 0.5), (3.0, 1.0), (10.0, 1.0),
])
def test_norm_pf(value, expected):
    """PF is shifted by 1 first: a PF of exactly 1 (break-even) is worth 0."""
    assert pm.norm_pf(value) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("value,expected", [
    (None, 0.0), (0, 0.0), (-2, 0.0),
    (3, 0.25), (6, 0.5), (12, 1.0), (36, 1.0),
])
def test_norm_age(value, expected):
    assert pm.norm_age(value) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("value,expected", [
    (None, 0.0), (0, 0.0),
    (50, 0.25), (100, 0.5), (200, 1.0), (900, 1.0),
])
def test_norm_trades(value, expected):
    assert pm.norm_trades(value) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("value,expected", [
    (None, 0.0), (0, 0.0), (55.5, 0.555), (100, 1.0), (120, 1.0),
])
def test_norm_months_pos(value, expected):
    assert pm.norm_months_pos(value) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("value,expected", [
    (None, 0.0), (0, 0.0), (49.9, 0.0), (50.0, 0.0),
    (60.0, 0.25), (70.0, 0.5), (90.0, 1.0), (99.0, 1.0),
])
def test_norm_win_rate(value, expected):
    """Floor 50 / target 90: everything at or below the floor is worth ZERO,
    so a 50%-WR bot and a 10%-WR bot are indistinguishable on this axis."""
    assert pm.norm_win_rate(value) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("bot,expected", [
    ({"trades_90d": 30}, 0.5),                                # 30/3 months = 10 tpm
    ({"trades_90d": 180}, 1.0),                               # 60 tpm, capped
    ({"trades_90d": 0}, 0.0),
    ({"trades": 100, "months_active": 10}, 0.5),              # fallback: lifetime tpm
    ({"trades": 100, "months_active": 0}, 0.0),               # < 1 month => 0
    ({"trades": 0, "months_active": 12}, 0.0),
    ({"trades_90d": 12, "trades": 9999, "months_active": 1}, 0.2),  # trades_90d wins
])
def test_norm_cadence(bot, expected):
    assert pm.norm_cadence(bot) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("ratio,flag,expected", [
    (0.9, True, 0.0),      # the flag forces 0 whatever the ratio
    (None, False, 0.5),    # unknown decay = neutral
    (0.0, False, 0.0),
    (-0.2, False, 0.0),
    (0.4, False, 0.4),
    (1.0, False, 1.0),
    (1.8, False, 1.0),
])
def test_norm_decay(ratio, flag, expected):
    assert pm.norm_decay(ratio, flag) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("net,balance,months,expected", [
    (100.0, 10000.0, 4, 0.5),      # 0.25 %/month vs the 0.5 %/month cap
    (50.0, 10000.0, 1, 1.0),       # exactly at the cap
    (10.0, 10000.0, 5, 0.04),
    (100.0, 10000.0, 0, 1.0),      # months < 1 is clamped to 1 => 1.0 %/mo => capped
    (-500.0, 10000.0, 6, 0.0),
    (None, 10000.0, 6, 0.0),
    (100.0, 0, 6, 0.0),
    (100.0, None, 6, 0.0),
])
def test_norm_net_return(net, balance, months, expected):
    assert pm.norm_net_return(net, balance, months) == pytest.approx(expected, **APPROX)


# --- quality norms ------------------------------------------------------------

@pytest.mark.parametrize("stress,expected", [
    (None, 0.5), ({}, 0.5), ({"prob_negative": None}, 0.5),
    ({"prob_negative": 0.0}, 1.0),
    ({"prob_negative": 0.25}, 0.75),
    ({"prob_negative": 1.0}, 0.0),
])
def test_norm_safety(stress, expected):
    assert pm.norm_safety(stress) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("inst,expected", [
    (None, 0.5), ({}, 0.5),
    ({"tail_ratio": 0.5}, 0.0),
    ({"tail_ratio": 1.0}, 0.5),
    ({"tail_ratio": 1.5}, 1.0),
    ({"tail_ratio": 4.0}, 1.0),
    ({"cvar_95_pct": 0.0}, 1.0),
    ({"cvar_95_pct": -0.075}, 0.5),
    ({"cvar_95_pct": -0.30}, 0.0),
    ({"tail_ratio": 1.0, "cvar_95_pct": -0.075}, 0.5),
    ({"k_ratio": 1.0}, 0.5),   # block present but no tail info => neutral
])
def test_norm_tail(inst, expected):
    assert pm.norm_tail(inst) == pytest.approx(expected, **APPROX)


@pytest.mark.parametrize("oos,expected", [
    (None, 0.3), ({}, 0.3),
    ({"oos_score": 0.4}, 0.4),
    ({"oos_score": 2.0}, 1.0),
    ({"permutation_p_value": 0.0}, 1.0),
    ({"permutation_p_value": 0.25}, 0.5),
    ({"permutation_p_value": 0.5}, 0.0),
    ({"permutation_p_value": 0.9}, 0.0),
    ({"oos_score": 0.4, "pct_folds_test_profitable": 60, "permutation_p_value": 0.1},
     (0.4 + 1.0 + 0.8) / 3),
])
def test_norm_oos(oos, expected):
    assert pm.norm_oos(oos) == pytest.approx(expected, **APPROX)


def test_norm_oos_saturates_on_pct_folds_scale_KNOWN_DEFECT():
    """`pct_folds_test_profitable` is emitted on a 0-100 scale by walk_forward()
    (see post_merge.walk_forward: round(pct_test_profitable, 1) where
    pct_test_profitable is a percentage), but norm_oos feeds it to clamp01()
    WITHOUT dividing by 100.

    Consequence: 1% of profitable test folds and 100% of them are worth exactly
    the same on this axis (weight 0.06). Correct behaviour would be
    clamp01(pct / 100.0) -> 0.01 and 1.0.
    """
    worst = pm.norm_oos({"pct_folds_test_profitable": 1})
    best = pm.norm_oos({"pct_folds_test_profitable": 100})
    assert worst == 1.0
    assert best == 1.0
    assert worst == best, "defect fixed? update this test and the golden scores"
    # And it is already saturated at the smallest non-zero percentage.
    assert pm.norm_oos({"pct_folds_test_profitable": 0.9}) == pytest.approx(0.9)


@pytest.mark.parametrize("oos,ci,expected", [
    (None, None, 0.3),
    ({}, {}, 0.3),
    ({"permutation_p_value": 0.25}, None, 0.5),
    (None, {"low_confidence": True}, 0.2),
    (None, {"low_confidence": False}, 0.8),
    (None, {"sharpe": {"lo": 0.0}}, 0.5),
    (None, {"sharpe": {"lo": -0.2}}, 0.3),
    (None, {"sharpe": {"lo": -0.9}}, 0.0),
    ({"permutation_p_value": 0.25}, {"sharpe": {"lo": 0.5}}, 0.75),
])
def test_norm_significance(oos, ci, expected):
    assert pm.norm_significance(oos, ci) == pytest.approx(expected, **APPROX)


def test_norm_significance_saturates_on_sharpe_ci_lo_KNOWN_DEFECT():
    """The Sharpe CI lower bound is an ANNUALIZED Sharpe (confidence_intervals
    annualizes by sqrt(252)), but norm_significance maps it with `0.5 + lo`.

    Consequence: every bot whose CI lower bound is >= 0.5 saturates at 1.0 —
    a genuinely exceptional lo of 3.0 is indistinguishable from a marginal 0.5
    (weight 0.03). A defined mapping (e.g. (lo + 1) / 2) would separate them.
    """
    marginal = pm.norm_significance(None, {"sharpe": {"lo": 0.5}})
    exceptional = pm.norm_significance(None, {"sharpe": {"lo": 3.0}})
    assert marginal == 1.0
    assert exceptional == 1.0
    assert marginal == exceptional, "defect fixed? update this test and the golden scores"


def test_significance_prefers_sharpe_lo_over_low_confidence_flag():
    """The `low_confidence` branch is an ELIF: it only fires when sharpe.lo is
    absent. A block with both uses sharpe.lo alone."""
    both = pm.norm_significance(None, {"sharpe": {"lo": 0.0}, "low_confidence": True})
    assert both == pytest.approx(0.5, **APPROX)
