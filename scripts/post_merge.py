"""Post-merge enrichment for Battle of Bots.

Reads merged snapshot.json + per-bot files (with daily_equity_series), and:
  1. Promotion Score (0-100) + status (READY/NEAR/WATCH/NO) per bot,
     transparent weights + hard gating + rank-based caps (top 5/5/10).
  2. Monte Carlo stress test (bootstrap of trade returns) → stress block.
  3. Walk-Forward / OOS validation → oos block.
  4. Regime / temporal robustness (Herfindahl by DoW/Hour/Duration) → regime.
  5. Page-Hinkley drift detection on daily_net → drift block.
  6. Capacity forecaster (USD before slippage degrades) → capacity block.
  7. Institutional metrics (CVaR, Ulcer, Martin, K-Ratio, SQN, Tail, Autocorr).
  8. Underwater analysis (top-10 drawdowns + recovery) → underwater.
  9. Bootstrap 95% CI (Sharpe/Sortino/Calmar/PF/WR) → confidence_intervals.
 10. Historical event stress (replay COVID/Ukraine/Banking/etc) → event_stress.
 11. Bayesian shrinkage of promotion_score toward cohort prior → shrinkage_meta.
 12. Forward Tracker (append-only history of READY/NEAR bots → candidates_history.jsonl).
 13. Promotion Radar (8-axis percentile-rank vs gating-eligible cohort).
 14. Trade-PnL Distribution stats (Fisher-Pearson moments + tail-contribution).
 15. Adversarial Pair Finder (top-3 portfolio partners per READY/NEAR).
 16. Correlation matrix (Pearson on daily returns) → data/correlations.json.
 17. Portfolio Optimizer (risk-parity / inverse-vol / equal / score-weighted)
     → data/portfolio.json.
 18. Survival Curve / Kaplan-Meier (cohort mortality with Greenwood log-log CI)
     → data/survival.json.

Run with: python3 post_merge.py <data_dir>
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
import re
import sys
from datetime import datetime, timezone, timedelta

from _metrics import clamp01, pearson, percentile, stdev

# gate_lib del Ultra Tribunal (fuente única del gate de dominancia — 12 ejes).
# Fail-open: sin tribunal/ el gate continuo simplemente no corre.
_TRIBUNAL_SCRIPTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tribunal", "scripts")
try:
    sys.path.insert(0, _TRIBUNAL_SCRIPTS)
    import gate_lib as _gate_lib
except Exception:
    _gate_lib = None

# --- Configuration -------------------------------------------------------

# Hybrid weights (2026-06-30): "gana dinero CON bajo drawdown". net_return makes
# money an EXPLICIT factor (was only implicit via Calmar). Real accounts are tiny
# ($5K/$10K, leveraged — 10% own capital), so capital preservation (Calmar/DD) and
# raw profit lead; scalability/capacity is irrelevant at this size → not weighted.
WEIGHTS = {
    "calmar": 0.15,           # net / maxDD — núcleo "gana con bajo DD"
    "net_return": 0.15,       # rentabilidad mensual neta honesta — "ganar dinero"
    "months_positive_pct": 0.11,
    "win_rate": 0.10,         # perfil del owner (2026-07-01): alto win rate — subordinado a DD/SQN/PF
    "sortino": 0.08,
    "decay": 0.08,            # 1.0 - decay penalty
    "cadence": 0.06,          # perfil del owner: opera CONSTANTEMENTE (trades/mes reciente)
    # --- Quality factors (2026-06-30b): ya se calculaban (oos/stress/institutional/CI)
    # pero NO entraban en la selección. Entran como SCORE (nunca gates → la sección
    # SIEMPRE muestra los 3 mejores) + insignias. Suben a los robustos/seguros.
    "oos_robustness": 0.06,   # Walk-Forward: edge sobrevive datos no vistos (anti curve-fit)
    "safety": 0.06,           # 1 - prob_negative (Monte Carlo) — preservación de capital
    "profit_factor": 0.05,
    "tail_quality": 0.04,     # tail_ratio / CVaR — sin cola de pérdidas que mata cuentas
    "significance": 0.03,     # robustez estadística (permutation p / CI) — no es suerte
    "age": 0.02,              # months_active vs 12
    "trade_count": 0.01,      # trades vs 200 (volumen total; cadence mide el ritmo reciente)
}
assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9, "WEIGHTS must sum to 1.0"

# Normalization caps (bot at cap = 1.0; above = 1.0; negative = 0.0).
CAPS = {
    "calmar": 5.0,            # net 5x maxDD = perfect
    "sortino": 3.0,           # annualized sortino
    "profit_factor": 3.0,     # PF 3 = perfect
    "age_months": 12.0,
    "trades_target": 200.0,
    "net_monthly_return_pct": 0.5,  # 0.5%/mes neto = perfecto (calibrado a la cohorte real:
                                    # max≈1.0%/mo, P90≈0.31%; a 5.0 el dinero no diferenciaba)
    "win_rate_floor": 50.0,         # WR ≤ floor → 0 en el eje; escala floor→target = 0→1
    "win_rate_target": 90.0,
    "cadence_trades_per_month": 20.0,  # ≈1 trade/día hábil = "opera constante" perfecto
}

# Hard gating filters: failing any one => promotion_status = "NO".
# DD cap tightened 15→10 (2026-06-30): real accounts are leveraged $5-10K where the
# owner's own money is ~10% — a 10% account DD already threatens the funded arrangement.
GATING = {
    "min_trades": 30,
    "min_months_active": 3,
    "max_drawdown_pct_of_balance": 10.0,
    "min_net_profit": 0.0,    # must be net profitable
    "exclude_decay_flag": True,
    "exclude_magic_zero": True,
}

# Status thresholds (kept for compatibility; superseded by rank-based assignment below).
STATUS = [
    ("READY", 75),
    ("NEAR", 60),
    ("WATCH", 40),
    ("NO", 0),
]

# Rank-based status caps: SIEMPRE garantizan top5/top5/top10 entre los bots que pasan gating,
# ordenados por promotion_score. Cualquier bot que pasa gating pero queda fuera del top 20 → NO.
# Preservation caps (Tribunal del Capital): READY is a REAL-money recommendation on
# 2 accounts (~$12K) — each extra slot lowers the bar where winner's-curse contaminates.
# An empty slot costs $0; a badly-filled one can cost a real account. WATCH wide for discovery.
STATUS_RANK_CAPS = {"READY": 3, "NEAR": 5, "WATCH": 15}

# Trust-eligibility for a REAL-money seat (READY/NEAR) — owner decisions 2026-07-01.
# READY must be "los 3 mejores Y de suma confianza, siempre". The seat ranking uses the
# CONFIDENCE-ADJUSTED score (promotion_score_shrunk), and a bot only holds a READY/NEAR
# seat if it clears absolute-evidence + freshness + profile + hard-safety checks.
# Two tiers:
#   · HARD  (never seat in READY/NEAR): dormant, clones a real bot (corr>0.7), SQN "MALO".
#   · SOFT  (seatable only as flagged provisional backfill when the field is thin):
#           low shrunk score, no evidence, luck-inflated score, low win rate.
# ALWAYS 3 seats: if fewer than 3 fully-trusted bots exist, the remaining seats are
# backfilled by shrunk score and flagged provisional_low_confidence for the UI.
# NOTE: confidence here = ABSOLUTE evidence, NOT the cohort-relative LOW/MEDIUM/HIGH label
# (that label would expel genuine grinders whose only "fault" is a small peer cohort).
TRUST = {
    "min_shrunk": 58.0,          # confidence-adjusted score floor [SOFT]. Calibrado 2026-07-01
                                 # tras añadir win_rate+cadence a WEIGHTS (comprimió la escala
                                 # ~10pts): 58 ≈ +3 sobre global_prior, separa el top-3 genuino
                                 # (59-62) del pack; el fluke igual cae por 'inflated' (delta>12).
    "min_cohort_n": 3,           # peer support OR ...                                   [SOFT]
    "min_months_evidence": 4,    #   ... enough live history (alternative to cohort)     [SOFT]
    "max_shrink_delta": 12.0,    # |raw-shrunk|: reject scores heavily inflated by luck  [SOFT]
    "min_win_rate": 50.0,        # owner profile: high win rate (subordinate to gates)   [SOFT]
    "max_dormant_days": 14,      # freshness: no trade in > N days → not competing        [HARD]
    "max_corr_vs_real": 0.7,     # do not clone what already runs in real                 [HARD]
    "enforce_sqn_malo": True,    # exclude SQN == "MALO"                                   [HARD]
}

# Ultra Tribunal sync (2026-07-13) — veredictos versionados en tribunal/data/.
# El veredicto NUNCA mueve asientos (visual-only, decisión owner): decora bots,
# emite doble-firma READY∧podio y corre el gate de dominancia en continuo.
TRIBUNAL_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tribunal", "data")
TRIBUNAL_FRESH_DAYS = 7        # veredicto vigente
TRIBUNAL_EXPIRED_DAYS = 14     # > N días: la doble firma se degrada en la UI
TRIBUNAL_STALE_DD_PTS = 2.0    # dd_pct empeoró > N pts vs el veredicto → obsoleto
TRIBUNAL_STALE_PF_DROP = 0.3   # PF cayó > N vs el veredicto → obsoleto

MIN_CORR_TRADES = 25          # min trades to be in correlation matrix
MAX_CORR_BOTS = 60            # cap matrix size
NEW_BOTS_DAYS = 30           # bots with first_trade within this window live only in the Bots Nuevos view


def _is_new_bot(b, now):
    """True while a bot's first_trade is within the last NEW_BOTS_DAYS (moving window)."""
    ft = b.get("first_trade")
    if not ft:
        return False
    try:
        dt = datetime.fromisoformat(str(ft).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (now - dt) < timedelta(days=NEW_BOTS_DAYS)


def _days_since_last_trade(b, now):
    """Days since the bot's last CLOSED trade. None if unknown. Freshness signal for the
    'competencia siempre activa' gate — a dormant bot does not compete for READY/NEAR."""
    lt = b.get("last_trade")
    if not lt:
        return None
    try:
        dt = datetime.fromisoformat(str(lt).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (now - dt).days

# --- Monte Carlo / OOS / Portfolio config -------------------------------

MC_RUNS = 2000                # bootstrap iterations
MC_HORIZON_TRADES = None      # None = same length as historical trades
MC_MIN_TRADES = 30            # below this, skip Monte Carlo
MC_SEED = 42                  # deterministic across runs

OOS_FOLDS_MAX = 5             # rolling walk-forward splits (cap)
OOS_MIN_TRADES = 40           # below this, skip OOS
OOS_MIN_FOLD_SIZE = 6         # min train/test rows per fold
OOS_PERM_TRIALS = 1000        # permutation test resamples

PORTFOLIO_MAX_BOTS = 10       # cap allocator at top N
PORTFOLIO_CAPITALS = [25000, 50000, 100000]
PORTFOLIO_MIN_STATUS = ("READY", "NEAR")

# --- Bayesian shrinkage (cohort-adjusted) -------------------------------
SHRINKAGE_K0 = 50.0           # prior strength (n_eff at which weight = 0.5)
SHRINKAGE_MIN_COHORT = 3      # min bots in a cohort to trust its prior
SHRINKAGE_AGE_BUCKETS = (3, 6, 12, 24)  # months_active buckets

# --- Drift Watchdog (Page-Hinkley) --------------------------------------
PH_DELTA = 0.005              # tolerance (in $/day units of daily_net)
PH_LAMBDA_FACTOR = 4.0        # lambda = factor × stdev(daily_net)
PH_MIN_DAYS = 30              # below this, no drift evaluation
PH_RESET_AFTER_DAYS = 0       # 0 = first breakpoint sticky; >0 = reset window

# --- Capacity Forecaster ------------------------------------------------
LIQUIDITY_TIER = {            # primary symbol → tier (1=major, 2=minor, 3=exotic)
    # Tier 1 — majors
    "EURUSD": 1, "GBPUSD": 1, "USDJPY": 1, "USDCHF": 1, "AUDUSD": 1,
    "USDCAD": 1, "NZDUSD": 1,
    # Tier 2 — minors / crosses
    "EURJPY": 2, "GBPJPY": 2, "EURGBP": 2, "AUDJPY": 2, "CHFJPY": 2,
    "CADJPY": 2, "AUDNZD": 2, "EURAUD": 2, "EURCAD": 2, "EURCHF": 2,
    "EURNZD": 2, "GBPAUD": 2, "GBPCAD": 2, "GBPCHF": 2, "GBPNZD": 2,
    "AUDCAD": 2, "AUDCHF": 2, "NZDJPY": 2, "NZDCAD": 2, "NZDCHF": 2,
    "CADCHF": 2,
    # Tier 3 — metals / exotics (XAU, XAG, oil etc.)
}
TIER_BASE_CAPACITY = {1: 250000.0, 2: 80000.0, 3: 25000.0}
TIER_LIQUIDITY_FACTOR = {1: 1.0, 2: 0.55, 3: 0.20}

# --- Historical event windows (real macro regimes for replay) -----------
EVENT_WINDOWS = [
    {"id": "covid",      "name": "COVID Crash",            "icon": "🦠", "start": "2020-02-20", "end": "2020-04-30"},
    {"id": "ukraine",    "name": "Russia–Ukraine War",     "icon": "🪖", "start": "2022-02-24", "end": "2022-04-30"},
    {"id": "banking",    "name": "Banking Crisis SVB/CS",  "icon": "🏦", "start": "2023-03-08", "end": "2023-04-15"},
    {"id": "fed_pivot",  "name": "Fed Pivot 2024",         "icon": "💸", "start": "2024-08-01", "end": "2024-12-15"},
]

# --- Bootstrap CI config ------------------------------------------------
CI_RUNS = 1000
CI_LEVEL = 0.95
CI_MIN_DAYS = 30
CI_MIN_TRADES = 30
CI_SEED = 4242



# --- Helpers -------------------------------------------------------------
# clamp01, pearson, percentile, stdev come from _metrics (shared with
# verify_live_mt5.py). norm_* below stay here because they consume the
# promotion-scoring CAPS dict above.


def norm_calmar(c):
    if c is None or c <= 0:
        return 0.0
    return clamp01(c / CAPS["calmar"])


def norm_sortino(s):
    if s is None or s <= 0:
        return 0.0
    return clamp01(s / CAPS["sortino"])


def norm_pf(pf):
    if pf is None or pf <= 1:
        return 0.0
    return clamp01((pf - 1) / (CAPS["profit_factor"] - 1))


def norm_age(months):
    if months is None or months <= 0:
        return 0.0
    return clamp01(months / CAPS["age_months"])


def norm_trades(n):
    if not n:
        return 0.0
    return clamp01(n / CAPS["trades_target"])


def norm_months_pos(pct):
    if pct is None:
        return 0.0
    return clamp01(pct / 100.0)


def norm_win_rate(pct):
    """Owner profile: high win rate. WR ≤ floor → 0; scales floor→target = 0→1.
    Subordinate to DD/SQN/PF gates (a high WR bot with hidden tail risk still fails those)."""
    if pct is None:
        return 0.0
    floor, target = CAPS["win_rate_floor"], CAPS["win_rate_target"]
    if pct <= floor:
        return 0.0
    return clamp01((pct - floor) / (target - floor))


def norm_cadence(bot):
    """Owner profile: 'opera constantemente'. Rewards RECENT trade cadence (trades/month).
    Prefers trades_90d (continuous & recent) if snapshot_builder emits it; else falls back
    to lifetime trades / months_active."""
    t90 = bot.get("trades_90d")
    if t90 is not None:
        tpm = t90 / 3.0
    else:
        m = bot.get("months_active") or 0
        if m < 1:
            return 0.0
        tpm = (bot.get("trades") or 0) / m
    if tpm <= 0:
        return 0.0
    return clamp01(tpm / CAPS["cadence_trades_per_month"])


def norm_decay(decay_ratio, decay_flag):
    """1.0 = healthy (recent ≈ lifetime). 0 = dead. Flag forces 0."""
    if decay_flag:
        return 0.0
    if decay_ratio is None:
        return 0.5
    if decay_ratio <= 0:
        return 0.0
    if decay_ratio >= 1.0:
        return 1.0
    return clamp01(decay_ratio)


def norm_net_return(net_after_commission, balance, months_active):
    """Money factor: commission-honest MONTHLY net return on the account balance,
    normalized to CAPS['net_monthly_return_pct']. Monthly (not lifetime) so age is
    not double-counted (age has its own weighted term). None/invalid/≤0 → 0.0."""
    if net_after_commission is None or not balance or balance <= 0:
        return 0.0
    m = months_active or 0
    if m < 1:
        m = 1  # gating already requires ≥3 months; guard sub-month edge cases
    monthly_pct = (net_after_commission / balance) / m * 100.0
    if monthly_pct <= 0:
        return 0.0
    return clamp01(monthly_pct / CAPS["net_monthly_return_pct"])


# --- Quality-factor norms (consume Pass-2 enrichments; filled in re-scoring pass) ---
# All return 0..1; missing data → a neutral-low default so a bot is not over-rewarded
# for an UNKNOWN, yet the section still fills 3 (these are score factors, never gates).

def norm_oos(oos):
    """Out-of-sample robustness from walk-forward. Blends fraction of test folds
    profitable, oos_score, and (1 - permutation p-value). Missing OOS → 0.3."""
    if not oos:
        return 0.3
    parts = []
    if oos.get("oos_score") is not None:
        parts.append(clamp01(oos["oos_score"]))
    if oos.get("pct_folds_test_profitable") is not None:
        parts.append(clamp01(oos["pct_folds_test_profitable"]))
    p = oos.get("permutation_p_value")
    if p is not None:
        parts.append(clamp01(1.0 - (p / 0.5)))  # p=0 →1.0, p≥0.5 →0
    return sum(parts) / len(parts) if parts else 0.3


def norm_safety(stress):
    """Capital preservation = 1 - prob_negative (Monte Carlo bootstrap probability the
    bot ends net-negative). prob_ruin is ~0 for all demo bots, so prob_negative is the
    discriminating safety signal. Missing → 0.5."""
    if not stress or stress.get("prob_negative") is None:
        return 0.5
    return clamp01(1.0 - stress["prob_negative"])


def norm_tail(inst):
    """Downside-tail quality. tail_ratio≥1 = upside ≥ downside extremes; map 0.5→0,
    1.5→1.0. Penalize a very negative CVaR (worse than -15% per-trade). Missing → 0.5."""
    if not inst:
        return 0.5
    parts = []
    tr = inst.get("tail_ratio")
    if tr is not None:
        parts.append(clamp01((tr - 0.5) / 1.0))
    cvar = inst.get("cvar_95_pct")  # negative; closer to 0 = better
    if cvar is not None:
        parts.append(clamp01(1.0 + (cvar / 0.15)))  # cvar 0→1.0, -0.15→0
    return sum(parts) / len(parts) if parts else 0.5


def norm_significance(oos, ci):
    """Is the edge statistically real (not small-sample luck)? Uses OOS permutation
    p-value (primary) and the bootstrap-CI stability of Sharpe. Missing → 0.3."""
    parts = []
    p = (oos or {}).get("permutation_p_value")
    if p is not None:
        parts.append(clamp01(1.0 - (p / 0.5)))
    sh = (ci or {}).get("sharpe") or {}
    if sh.get("lo") is not None:
        # reward a CI lower bound that is >0 (stable edge); scale around 0
        parts.append(clamp01(0.5 + sh["lo"]))
    elif ci is not None and ci.get("low_confidence") is not None:
        parts.append(0.2 if ci.get("low_confidence") else 0.8)
    return sum(parts) / len(parts) if parts else 0.3


def compute_score(bot, account_balance):
    """Returns (score_0_100, components_dict, gating_pass_dict, fails_list)."""
    components = {
        "calmar": norm_calmar(bot.get("calmar")),
        "months_positive_pct": norm_months_pos(bot.get("months_positive_pct")),
        "win_rate": norm_win_rate(bot.get("win_rate_pct")),
        "sortino": norm_sortino(bot.get("sortino")),
        "decay": norm_decay(bot.get("decay_ratio"), bot.get("decay_flag")),
        "cadence": norm_cadence(bot),
        "profit_factor": norm_pf(bot.get("profit_factor")),
        "age": norm_age(bot.get("months_active")),
        "trade_count": norm_trades(bot.get("trades")),
        # Placeholders: net_after_commission + the quality enrichments (oos/stress/
        # institutional/CI) aren't available at this stage; all are filled in the
        # re-scoring pass (see "5b)" in the pipeline) once Pass 2 has run.
        "net_return": 0.0,
        "oos_robustness": 0.0,
        "safety": 0.0,
        "tail_quality": 0.0,
        "significance": 0.0,
    }
    raw = sum(components[k] * WEIGHTS[k] for k in WEIGHTS)
    score = round(raw * 100, 1)

    fails = []
    gating = {}
    g = GATING
    gating["min_trades"] = (bot.get("trades", 0) or 0) >= g["min_trades"]
    if not gating["min_trades"]:
        fails.append(f"trades < {g['min_trades']}")
    gating["min_months_active"] = (bot.get("months_active", 0) or 0) >= g["min_months_active"]
    if not gating["min_months_active"]:
        fails.append(f"meses activo < {g['min_months_active']}")
    dd_pct = None
    if account_balance and bot.get("max_drawdown"):
        dd_pct = (bot["max_drawdown"] / account_balance) * 100
    gating["dd_under_cap"] = (dd_pct is None) or (dd_pct <= g["max_drawdown_pct_of_balance"])
    if not gating["dd_under_cap"]:
        fails.append(f"DD {dd_pct:.1f}% > {g['max_drawdown_pct_of_balance']}%")
    gating["net_profitable"] = (bot.get("net_profit", 0) or 0) > g["min_net_profit"]
    if not gating["net_profitable"]:
        fails.append("net profit ≤ 0")
    gating["no_decay_flag"] = not (g["exclude_decay_flag"] and bot.get("decay_flag"))
    if not gating["no_decay_flag"]:
        fails.append("decay detectado")
    gating["valid_magic"] = not (g["exclude_magic_zero"] and (bot.get("magic", 0) == 0))
    if not gating["valid_magic"]:
        fails.append("magic = 0")

    all_pass = all(gating.values())
    if not all_pass:
        status = "NO"
    else:
        status = next(s for s, t in STATUS if score >= t)

    return {
        "score": score,
        "components": {k: round(v, 3) for k, v in components.items()},
        "gating": gating,
        "fails": fails,
        "status": status,
        "dd_pct_of_balance": round(dd_pct, 2) if dd_pct is not None else None,
    }


def load_per_bot_series(data_dir, vps, login, magic):
    path = os.path.join(data_dir, "bots", vps, f"{login}-{magic}.json")
    try:
        with open(path) as f:
            return json.load(f).get("daily_equity_series", [])
    except (OSError, json.JSONDecodeError):
        return []


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


def build_correlation_matrix(snapshot, data_dir, real_accounts=None):
    """Build correlation matrix from daily_equity_series of qualifying bots.

    Real-account bots are excluded — they live only in the Real Accounts section,
    not in the demo competition views.
    """
    real_accounts = real_accounts or set()
    now = datetime.now(timezone.utc)
    bots = snapshot.get("bots", [])
    candidates = [b for b in bots
                  if (b.get("trades") or 0) >= MIN_CORR_TRADES
                  and b.get("magic")
                  and (b.get("promotion_score") is not None)
                  and (b.get("vps"), b.get("account_login")) not in real_accounts
                  and not _is_new_bot(b, now)]
    candidates.sort(key=lambda b: -(b.get("promotion_score") or 0))
    candidates = candidates[:MAX_CORR_BOTS]

    series_by_bot = {}
    for b in candidates:
        key = f"{b['vps']}-{b['account_login']}-{b['magic']}"
        sr = load_per_bot_series(data_dir, b["vps"], b["account_login"], b["magic"])
        if not sr:
            continue
        # Build per-day daily_net dict.
        series_by_bot[key] = {row["date"]: row.get("daily_net", 0.0) for row in sr}

    keys = list(series_by_bot.keys())
    # All unique dates in union
    all_dates = sorted({d for sr in series_by_bot.values() for d in sr})

    # Build aligned vectors (zeroes for missing days)
    vectors = {}
    for k in keys:
        sr = series_by_bot[k]
        vectors[k] = [sr.get(d, 0.0) for d in all_dates]

    matrix = {}
    for i, ki in enumerate(keys):
        matrix[ki] = {}
        for j, kj in enumerate(keys):
            if i == j:
                matrix[ki][kj] = 1.0
            elif kj in matrix and ki in matrix[kj]:
                matrix[ki][kj] = matrix[kj][ki]
            else:
                c = pearson(vectors[ki], vectors[kj])
                matrix[ki][kj] = round(c, 3) if c is not None else None

    bot_meta = {}
    for b in candidates:
        key = f"{b['vps']}-{b['account_login']}-{b['magic']}"
        if key in series_by_bot:
            bot_meta[key] = {
                "vps": b["vps"],
                "login": b["account_login"],
                "magic": b["magic"],
                "symbols": b.get("symbols", []),
                "promotion_score": b.get("promotion_score"),
                "promotion_status": b.get("promotion_status"),
                "net_profit": b.get("net_profit"),
                "trades": b.get("trades"),
            }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bot_count": len(bot_meta),
        "min_trades": MIN_CORR_TRADES,
        "max_bots": MAX_CORR_BOTS,
        "bots": bot_meta,
        "matrix": matrix,
    }


def load_per_bot(data_dir, vps, login, magic):
    path = os.path.join(data_dir, "bots", vps, f"{login}-{magic}.json")
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def percentile(sorted_xs, p):
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


def stdev(xs):
    n = len(xs)
    if n < 2:
        return 0.0
    m = sum(xs) / n
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))


# --- 1. Monte Carlo bootstrap stress test --------------------------------

def _bootstrap_paths(nets, horizon, runs, seed):
    """Run `runs` bootstrap simulations of length `horizon` and return
    (sorted final_nets, sorted max_dds). Uses replacement-sampling.
    """
    rng = random.Random(seed)
    final_nets = []
    max_dds = []
    for _ in range(runs):
        cum = 0.0
        peak = 0.0
        run_max_dd = 0.0
        for _ in range(horizon):
            n = nets[rng.randrange(len(nets))]
            cum += n
            if cum > peak:
                peak = cum
            dd = peak - cum
            if dd > run_max_dd:
                run_max_dd = dd
        final_nets.append(cum)
        max_dds.append(run_max_dd)
    final_nets.sort()
    max_dds.sort()
    return final_nets, max_dds


def monte_carlo_stress(trades, account_balance, observed_max_dd):
    """Bootstrap-resample trade nets to project DD distribution and ruin probability."""
    nets = [t.get("net", 0.0) for t in trades if t.get("net") is not None]
    if len(nets) < MC_MIN_TRADES:
        return None
    horizon = MC_HORIZON_TRADES or len(nets)
    bal = account_balance or 0
    ruin_threshold = bal * 0.5 if bal > 0 else None
    final_nets, max_dds = _bootstrap_paths(nets, horizon, MC_RUNS, MC_SEED)
    ruined = sum(1 for d in max_dds if ruin_threshold is not None and d >= ruin_threshold)

    return {
        "runs": MC_RUNS,
        "horizon_trades": horizon,
        "observed_max_dd": observed_max_dd,
        "dd_p50": round(percentile(max_dds, 0.50), 2),
        "dd_p95": round(percentile(max_dds, 0.95), 2),
        "dd_p99": round(percentile(max_dds, 0.99), 2),
        "dd_pct_balance_p95": (
            round((percentile(max_dds, 0.95) / bal) * 100, 2)
            if bal > 0 else None
        ),
        "net_p25": round(percentile(final_nets, 0.25), 2),
        "net_p50": round(percentile(final_nets, 0.50), 2),
        "net_p75": round(percentile(final_nets, 0.75), 2),
        "prob_negative": round(sum(1 for n in final_nets if n < 0) / len(final_nets), 3),
        "prob_ruin": round(ruined / MC_RUNS, 3) if ruin_threshold is not None else None,
    }


# --- 2. Walk-Forward / Out-of-Sample validation --------------------------

def walk_forward(trades):
    """Rolling 5-fold split. Compare per-trade Sharpe-like (mean/stdev) train vs test.
    Plus permutation test for statistical significance of the mean.
    """
    nets = [t.get("net", 0.0) for t in trades if t.get("net") is not None]
    n = len(nets)
    if n < OOS_MIN_TRADES:
        return None

    # Adaptive folds: try max, scale down to keep fold_size >= OOS_MIN_FOLD_SIZE.
    n_folds = OOS_FOLDS_MAX
    while n_folds >= 2 and n // (n_folds + 1) < OOS_MIN_FOLD_SIZE:
        n_folds -= 1
    if n_folds < 2:
        return None
    fold_size = n // (n_folds + 1)
    folds = []
    for k in range(1, n_folds + 1):
        train_end = k * fold_size
        test_end = min((k + 1) * fold_size, n)
        train = nets[:train_end]
        test = nets[train_end:test_end]
        if len(test) < OOS_MIN_FOLD_SIZE or len(train) < OOS_MIN_FOLD_SIZE:
            continue
        m_tr = sum(train) / len(train)
        s_tr = stdev(train) or 1e-9
        m_te = sum(test) / len(test)
        s_te = stdev(test) or 1e-9
        sharpe_tr = m_tr / s_tr
        sharpe_te = m_te / s_te
        folds.append({
            "k": k,
            "train_n": len(train),
            "test_n": len(test),
            "sharpe_train": round(sharpe_tr, 3),
            "sharpe_test": round(sharpe_te, 3),
            "test_net": round(sum(test), 2),
            "test_profitable": sum(test) > 0,
        })
    if not folds:
        return None

    avg_sharpe_train = sum(f["sharpe_train"] for f in folds) / len(folds)
    avg_sharpe_test = sum(f["sharpe_test"] for f in folds) / len(folds)
    decay = (avg_sharpe_test / avg_sharpe_train) if avg_sharpe_train > 0 else 0.0
    pct_test_profitable = sum(1 for f in folds if f["test_profitable"]) / len(folds) * 100

    # Permutation test on full series mean.
    rng = random.Random(MC_SEED + 1)
    obs_mean = sum(nets) / n
    abs_nets = [abs(x) for x in nets]
    ge = 0
    for _ in range(OOS_PERM_TRIALS):
        s = 0.0
        for v in abs_nets:
            s += v if rng.random() < 0.5 else -v
        if (s / n) >= obs_mean:
            ge += 1
    p_value = ge / OOS_PERM_TRIALS

    # Score 0-1 combining decay and OOS profitability.
    decay_norm = clamp01(decay)
    oos_score = 0.5 * decay_norm + 0.5 * (pct_test_profitable / 100.0)

    return {
        "n_folds": n_folds,
        "fold_size": fold_size,
        "folds": folds,
        "avg_sharpe_train": round(avg_sharpe_train, 3),
        "avg_sharpe_test": round(avg_sharpe_test, 3),
        "sharpe_decay": round(decay, 3),
        "pct_folds_test_profitable": round(pct_test_profitable, 1),
        "permutation_p_value": round(p_value, 4),
        "is_significant": p_value < 0.05,
        "oos_score": round(oos_score, 3),
    }


# --- 3. Forward Tracker (append-only history) ----------------------------

def update_forward_tracker(snap, data_dir, today_iso, real_magics=None):
    """Append today's snapshot of every READY/NEAR bot to candidates_history.jsonl
    and compute tracker metrics (days_since_first_seen, net_since, expected band).

    Magics already deployed to real are skipped: the forward tracker is a
    promotion-discovery ledger of demo-only EAs not yet running real. Excluding
    them keeps the canonical history/base-rate clean (already-written lines are
    preserved append-only).
    """
    real_magics = real_magics or set()
    history_path = os.path.join(data_dir, "candidates_history.jsonl")
    history = []
    corrupt_lines = 0
    if os.path.exists(history_path):
        with open(history_path) as f:
            for lineno, raw in enumerate(f, 1):
                line = raw.strip()
                if line:
                    try:
                        history.append(json.loads(line))
                    except json.JSONDecodeError as exc:
                        # Do NOT swallow silently: a corrupt append-only ledger
                        # produces false tracker verdicts. Count + log; the gate
                        # in verify_integrity fails the cycle past a threshold.
                        corrupt_lines += 1
                        if corrupt_lines <= 10:
                            print(
                                f"[post_merge]   tracker corrupt line {lineno} "
                                f"in candidates_history.jsonl: {exc}",
                                file=sys.stderr,
                            )

    by_key = {}
    for row in history:
        k = (row.get("vps"), row.get("login"), row.get("magic"))
        by_key.setdefault(k, []).append(row)

    today_only = today_iso[:10]
    appended = 0
    # Do NOT append onto a corrupt ledger — that compounds corruption and the
    # verify_integrity gate would then fail the cycle anyway. Skip today's write
    # (corrupt_lines is surfaced via tracker_health for triage).
    if corrupt_lines:
        print(
            f"[post_merge]   tracker: skipping today's append — ledger has "
            f"{corrupt_lines} corrupt line(s), fix candidates_history.jsonl first",
            file=sys.stderr,
        )
    with open(history_path, "a") as f:
        for b in (snap.get("bots", []) if not corrupt_lines else []):
            status = b.get("promotion_status")
            if status not in PORTFOLIO_MIN_STATUS:
                continue
            if b.get("magic") in real_magics:
                continue  # already in real — not a discovery candidate
            k = (b.get("vps"), b.get("account_login"), b.get("magic"))
            existing = by_key.get(k, [])
            if existing and existing[-1].get("date", "")[:10] == today_only:
                continue  # already logged today
            row = {
                "date": today_iso,
                "vps": b.get("vps"),
                "login": b.get("account_login"),
                "magic": b.get("magic"),
                "status": status,
                "score": b.get("promotion_score"),
                "net_profit": b.get("net_profit"),
                "net_after_commission": b.get("net_after_commission"),
                "trades": b.get("trades"),
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            by_key.setdefault(k, []).append(row)
            appended += 1

    # Build tracker block per bot — embed first-seen + verdict directly into bot.
    tracked = 0
    for b in snap.get("bots", []):
        if b.get("magic") in real_magics:
            continue  # already in real — no tracker block (keeps snapshot.json clean)
        k = (b.get("vps"), b.get("account_login"), b.get("magic"))
        rows = by_key.get(k, [])
        if not rows:
            continue
        first = rows[0]
        first_date = first.get("date", "")[:10]
        if not first_date:
            continue
        try:
            d_first = datetime.fromisoformat(first_date)
            d_today = datetime.fromisoformat(today_only)
            days_since = (d_today - d_first).days
        except ValueError:
            continue
        # Commission-honest net_since, matching the bootstrap band basis (per-bot
        # t['net'] is post-commission). Use net_after_commission on BOTH ends when
        # available; legacy ledger rows predate it → both fall back to net_profit so
        # numerator and denominator stay on the same basis (no units mismatch).
        if first.get("net_after_commission") is not None and b.get("net_after_commission") is not None:
            net_at_first = first["net_after_commission"]
            current_net = b["net_after_commission"]
        else:
            net_at_first = first.get("net_profit") or 0
            current_net = b.get("net_profit") or 0
        net_since = current_net - net_at_first

        # Recompute bootstrap MC at the EXACT trades-expected for the elapsed period
        # (linear scaling of MC quantiles is statistically wrong — risk scales as sqrt(t)).
        verdict = None
        expected_p25 = None
        expected_p75 = None
        expected_p50 = None
        trades_count = b.get("trades") or 0
        months_active = b.get("months_active") or 0
        if trades_count >= MC_MIN_TRADES and months_active and days_since > 0:
            per = load_per_bot(data_dir, b.get("vps"), b.get("account_login"), b.get("magic"))
            trade_list = (per or {}).get("trades") or []
            nets = [t.get("net", 0.0) for t in trade_list if t.get("net") is not None]
            if len(nets) >= MC_MIN_TRADES:
                # Expected trades during elapsed period, from historical frequency.
                trades_per_day = len(nets) / max(1.0, months_active * 30.0)
                expected_horizon = max(1, int(round(trades_per_day * days_since)))
                # Use distinct seed per bot+date so we get fresh randomness day-to-day.
                # sha256 (not builtin hash()) → reproducible across processes regardless
                # of PYTHONHASHSEED; parenthesized so the 0x7FFFFFFF mask applies to the
                # whole XOR, not just the date term (Data Integrity DNA: every figure reproducible).
                date_seed = int.from_bytes(hashlib.sha256(today_only.encode()).digest()[:4], "big")
                seed = (MC_SEED ^ (b.get("magic") or 0) ^ date_seed) & 0x7FFFFFFF
                fn_sorted, _ = _bootstrap_paths(nets, expected_horizon, 1000, seed)
                expected_p25 = round(percentile(fn_sorted, 0.25), 2)
                expected_p50 = round(percentile(fn_sorted, 0.50), 2)
                expected_p75 = round(percentile(fn_sorted, 0.75), 2)
            if days_since < 7:
                verdict = "TOO_SOON"
            elif expected_p25 is None:
                verdict = None
            elif net_since >= expected_p75:
                verdict = "ABOVE"
            elif net_since >= expected_p25:
                verdict = "ON_TRACK"
            else:
                verdict = "BELOW"
        b["tracker"] = {
            "first_seen_date": first_date,
            "first_seen_status": first.get("status"),
            "days_since_first_seen": days_since,
            "net_since_first_seen": round(net_since, 2),
            "expected_p25": expected_p25,
            "expected_p50": expected_p50,
            "expected_p75": expected_p75,
            "verdict": verdict,
            "history_points": len(rows),
            "method": "bootstrap MC at expected-trades horizon (1000 runs)",
        }
        tracked += 1

    if corrupt_lines:
        print(
            f"[post_merge]   tracker_health: {corrupt_lines} corrupt line(s) in "
            f"candidates_history.jsonl ({len(history)} valid)",
            file=sys.stderr,
        )
    return {
        "appended": appended,
        "tracked": tracked,
        "corrupt_lines": corrupt_lines,
        "history_lines": len(history) + corrupt_lines,
    }


# --- 5. Regime / temporal robustness analysis ---------------------------

def regime_analysis(trades):
    """Without external OHLC, measure temporal robustness using close_time:
      - Performance by day of week (Mon-Fri)
      - Performance by hour of day (UTC, 0-23)
      - Performance by trade duration bucket
      - Concentration (Herfindahl): how concentrated is PnL in few buckets?
    A bot whose net comes from one hour is fragile; one spread across hours is robust.
    """
    if not trades or len(trades) < 20:
        return None

    by_dow = {i: {"trades": 0, "wins": 0, "net": 0.0} for i in range(7)}
    by_hour = {i: {"trades": 0, "wins": 0, "net": 0.0} for i in range(24)}
    duration_buckets = [
        ("<1h", 0, 3600),
        ("1-6h", 3600, 21600),
        ("6-24h", 21600, 86400),
        (">24h", 86400, 10**9),
    ]
    by_dur = {label: {"trades": 0, "wins": 0, "net": 0.0} for label, _, _ in duration_buckets}

    total_net = 0.0
    counted = 0
    for t in trades:
        close_ts = t.get("close_time")
        net = t.get("net")
        if close_ts is None or net is None:
            continue
        try:
            dt = datetime.fromtimestamp(close_ts, tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            continue
        dow = dt.weekday()
        hour = dt.hour
        by_dow[dow]["trades"] += 1
        by_dow[dow]["net"] += net
        if net > 0:
            by_dow[dow]["wins"] += 1
        by_hour[hour]["trades"] += 1
        by_hour[hour]["net"] += net
        if net > 0:
            by_hour[hour]["wins"] += 1
        dur = t.get("duration_sec") or 0
        for label, lo, hi in duration_buckets:
            if lo <= dur < hi:
                by_dur[label]["trades"] += 1
                by_dur[label]["net"] += net
                if net > 0:
                    by_dur[label]["wins"] += 1
                break
        total_net += net
        counted += 1

    if counted < 20:
        return None

    # Herfindahl concentration (positive PnL only): sum((net_i / total_pos)^2)
    pos_dow = [v["net"] for v in by_dow.values() if v["net"] > 0]
    pos_hour = [v["net"] for v in by_hour.values() if v["net"] > 0]
    pos_dur = [v["net"] for v in by_dur.values() if v["net"] > 0]
    def herfindahl(xs):
        s = sum(xs)
        if s <= 0:
            return None
        return round(sum((x / s) ** 2 for x in xs), 3)
    herf_dow = herfindahl(pos_dow)
    herf_hour = herfindahl(pos_hour)
    herf_dur = herfindahl(pos_dur)

    # Robustness score: lower Herfindahl (more spread) = higher robustness.
    # H ranges from 1/N (perfectly spread) to 1.0 (all in one bucket).
    def robustness(h, n_buckets):
        if h is None:
            return 0.0
        ideal = 1.0 / n_buckets
        # Map h ∈ [ideal, 1.0] → robustness ∈ [1.0, 0.0]
        return clamp01((1.0 - h) / (1.0 - ideal)) if ideal < 1 else 0.0
    rob_dow = robustness(herf_dow, 5)
    rob_hour = robustness(herf_hour, 24)
    rob_dur = robustness(herf_dur, 4)
    overall = round((rob_dow + rob_hour + rob_dur) / 3, 3)

    def fmt_bucket(d):
        return {
            k: {
                "trades": v["trades"],
                "win_rate_pct": round(v["wins"] / v["trades"] * 100, 1) if v["trades"] else 0,
                "net": round(v["net"], 2),
            } for k, v in d.items()
        }

    return {
        "by_day_of_week": fmt_bucket(by_dow),
        "by_hour_utc": fmt_bucket(by_hour),
        "by_duration": fmt_bucket(by_dur),
        "herfindahl_dow": herf_dow,
        "herfindahl_hour": herf_hour,
        "herfindahl_duration": herf_dur,
        "robustness_score": overall,
        "interpretation": (
            "ALTA robustez temporal" if overall >= 0.7 else
            "MEDIA robustez temporal" if overall >= 0.5 else
            "BAJA robustez (concentración alta)"
        ),
    }


# --- Institutional metrics (CVaR, Ulcer, K-Ratio, SQN, Tail, Autocorr) --

def _linreg_slope_se(ys):
    """Simple OLS over y = a + b*t, t = 0..n-1. Returns (slope, stderr_of_slope, n)."""
    n = len(ys)
    if n < 5:
        return None
    xs = list(range(n))
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 0:
        return None
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    slope = sxy / sxx
    intercept = my - slope * mx
    resid = [ys[i] - (intercept + slope * xs[i]) for i in range(n)]
    rss = sum(r * r for r in resid)
    if n - 2 <= 0:
        return None
    sigma2 = rss / (n - 2)
    se_slope = math.sqrt(sigma2 / sxx) if sigma2 > 0 else 0.0
    return slope, se_slope, n


def institutional_metrics(daily_series, trades, account_balance):
    """5 métricas faltantes para due-diligence institucional:
      - cvar_95_pct: pérdida promedio diaria en peor 5% de días, % del balance
      - ulcer_index_pct: RMS del DD% (profundidad × duración)
      - martin_ratio: net annualized / Ulcer Index (variante superior a Calmar)
      - k_ratio: linealidad de la equity curve (slope/SE × √n/n)
      - sqn: System Quality Number (Van Tharp) sobre R-multiples = √N × mean/std
      - tail_ratio: P95(daily_ret) / |P5(daily_ret)|. <1 = "vender opciones"
      - return_autocorr_lag1: clustering de pérdidas (>0.2 invalida MC IID)
    """
    out = {
        "cvar_95_pct": None,
        "ulcer_index_pct": None,
        "martin_ratio": None,
        "k_ratio": None,
        "sqn": None,
        "sqn_band": None,
        "tail_ratio": None,
        "return_autocorr_lag1": None,
        "interpretation": {},
    }

    # --- Daily-series-based metrics (CVaR, Ulcer, K-Ratio, Tail, Autocorr)
    if daily_series and len(daily_series) >= 10:
        daily_nets = [row.get("daily_net", 0.0) or 0.0 for row in daily_series]
        dd_pcts = [row.get("dd_pct", 0.0) or 0.0 for row in daily_series]
        cum_nets = [row.get("cum_net", 0.0) or 0.0 for row in daily_series]
        n = len(daily_nets)
        bal = account_balance or 0

        # CVaR 95% — average loss in worst 5% of days, expressed as % balance
        if bal > 0:
            sorted_nets = sorted(daily_nets)
            worst_count = max(1, int(math.ceil(n * 0.05)))
            worst_slice = sorted_nets[:worst_count]
            cvar = sum(worst_slice) / worst_count   # negative number = loss
            out["cvar_95_pct"] = round(cvar / bal * 100, 3)

        # Ulcer Index — RMS de dd_pct
        if dd_pcts:
            ui = math.sqrt(sum(d * d for d in dd_pcts) / len(dd_pcts))
            out["ulcer_index_pct"] = round(ui, 3)
            # Martin Ratio — net annualized return / Ulcer.
            # Annualized return: net_total / balance × (365/days_active) × 100.
            if bal > 0 and ui > 0 and n > 0:
                net_total = cum_nets[-1] if cum_nets else 0.0
                ann_return_pct = (net_total / bal) * (365.0 / n) * 100.0
                out["martin_ratio"] = round(ann_return_pct / ui, 3)

        # K-Ratio (Kestner modified) — linealidad de la curva cum_net
        lr = _linreg_slope_se(cum_nets) if cum_nets else None
        if lr is not None:
            slope, se, nn = lr
            if se > 0:
                out["k_ratio"] = round((slope / se) * math.sqrt(nn) / nn, 3)

        # Tail Ratio — daily returns como % del balance, para que sea adimensional
        if bal > 0 and n >= 20:
            rets = sorted([dn / bal for dn in daily_nets])
            p5 = percentile(rets, 0.05)
            p95 = percentile(rets, 0.95)
            if p5 is not None and p95 is not None and p5 < 0:
                out["tail_ratio"] = round(p95 / abs(p5), 3)

        # Autocorrelación lag-1 sobre returns diarios
        if n >= 20:
            xs = daily_nets[:-1]
            ys = daily_nets[1:]
            ac = pearson(xs, ys)
            if ac is not None:
                out["return_autocorr_lag1"] = round(ac, 3)

    # --- Trade-based metric (SQN)
    nets = [t.get("net", 0.0) or 0.0 for t in (trades or []) if t.get("net") is not None]
    if len(nets) >= 30:
        m = sum(nets) / len(nets)
        s = stdev(nets)
        if s > 0:
            sqn = math.sqrt(len(nets)) * m / s
            out["sqn"] = round(sqn, 2)
            if sqn < 1.6:
                out["sqn_band"] = "MALO"
            elif sqn < 2.0:
                out["sqn_band"] = "PROMEDIO"
            elif sqn < 3.0:
                out["sqn_band"] = "BUENO"
            elif sqn < 5.0:
                out["sqn_band"] = "EXCELENTE"
            elif sqn < 7.0:
                out["sqn_band"] = "SANTO_GRIAL"
            else:
                out["sqn_band"] = "SOSPECHOSO_OVERFIT"

    # --- Interpretation block (UI helper, no impact on gating)
    interp = {}
    if out["cvar_95_pct"] is not None:
        c = out["cvar_95_pct"]
        interp["cvar_95"] = (
            "🟢 Cola benigna" if c > -1.0 else
            "🟡 Cola moderada" if c > -3.0 else
            "🟠 Cola grande" if c > -6.0 else
            "🔴 Cola peligrosa"
        )
    if out["ulcer_index_pct"] is not None:
        u = out["ulcer_index_pct"]
        interp["ulcer"] = (
            "🟢 DD plano" if u < 1.0 else
            "🟡 DD aceptable" if u < 3.0 else
            "🟠 Agonía moderada" if u < 6.0 else
            "🔴 Agonía severa"
        )
    if out["k_ratio"] is not None:
        k = out["k_ratio"]
        interp["k_ratio"] = (
            "🟢 Curva lineal (edge real)" if k > 0.20 else
            "🟡 Curva consistente" if k > 0.10 else
            "🟠 Crecimiento irregular" if k > 0.0 else
            "🔴 Sin tendencia o decreciente"
        )
    if out["tail_ratio"] is not None:
        t = out["tail_ratio"]
        interp["tail_ratio"] = (
            "🟢 Asimetría favorable" if t >= 1.2 else
            "🟡 Simétrico" if t >= 0.85 else
            "🟠 Asimetría adversa" if t >= 0.7 else
            "🔴 Vender opciones (peligroso)"
        )
    if out["return_autocorr_lag1"] is not None:
        a = out["return_autocorr_lag1"]
        interp["autocorr"] = (
            "🟢 Independiente (MC válido)" if abs(a) < 0.15 else
            "🟡 Clustering leve" if a < 0.30 else
            "🔴 Clustering severo (MC subestima DD)"
        ) if a >= 0 else (
            "🟢 Anti-correlado (mean-revert)"
        )
    out["interpretation"] = interp
    return out


# --- 4. Portfolio Optimizer (Risk Parity / Inv-Vol / Equal) -------------

def build_portfolio(snap, data_dir, real_accounts=None, real_magics=None):
    """Compute risk-parity, inverse-volatility, and equal-weight allocations
    over the top N (READY/NEAR) candidates by promotion_score.

    Real-account bots are excluded — they are already promoted, not candidates.
    Magics already deployed to real (any instance) are excluded too: the portfolio
    is a promotion-discovery view of demo-only EAs not yet running real.
    """
    real_accounts = real_accounts or set()
    real_magics = real_magics or set()
    now = datetime.now(timezone.utc)
    bots = [b for b in snap.get("bots", [])
            if b.get("promotion_status") in PORTFOLIO_MIN_STATUS
            and b.get("magic")
            and (b.get("vps"), b.get("account_login")) not in real_accounts
            and b.get("magic") not in real_magics
            and not _is_new_bot(b, now)]
    bots.sort(key=lambda b: -(b.get("promotion_score") or 0))
    bots = bots[:PORTFOLIO_MAX_BOTS]
    if not bots:
        return None

    # Pull daily series stdevs.
    bot_data = []
    for b in bots:
        sr = load_per_bot_series(data_dir, b["vps"], b["account_login"], b["magic"])
        daily_nets = [row.get("daily_net", 0.0) for row in sr]
        s = stdev(daily_nets)
        if s <= 0:
            continue
        mean_daily = sum(daily_nets) / len(daily_nets) if daily_nets else 0
        bot_data.append({
            "key": f"{b['vps']}-{b['account_login']}-{b['magic']}",
            "vps": b["vps"],
            "login": b["account_login"],
            "magic": b["magic"],
            "symbols": b.get("symbols", []),
            "score": b.get("promotion_score"),
            "status": b.get("promotion_status"),
            "net_profit": b.get("net_profit"),
            "trades": b.get("trades"),
            "daily_stdev": s,
            "daily_mean": mean_daily,
            "annualized_return_pct": round(mean_daily * 252 / max(1, b.get("max_drawdown") or 1), 3),
        })
    if not bot_data:
        return None

    # Inverse volatility weights (= risk parity if assets uncorrelated).
    inv_vols = [1.0 / b["daily_stdev"] for b in bot_data]
    s_inv = sum(inv_vols)
    inv_vol_weights = [w / s_inv for w in inv_vols]

    # Equal weight.
    n = len(bot_data)
    equal_weights = [1.0 / n] * n

    # Score-weighted (proportional to promotion_score).
    score_sum = sum((b["score"] or 0) for b in bot_data) or 1.0
    score_weights = [(b["score"] or 0) / score_sum for b in bot_data]

    allocations = {}
    for cap in PORTFOLIO_CAPITALS:
        allocations[str(cap)] = {
            "inverse_volatility": [
                {**bot_data[i], "weight": round(w, 4), "capital_usd": round(cap * w, 2)}
                for i, w in enumerate(inv_vol_weights)
            ],
            "equal_weight": [
                {**bot_data[i], "weight": round(w, 4), "capital_usd": round(cap * w, 2)}
                for i, w in enumerate(equal_weights)
            ],
            "score_weighted": [
                {**bot_data[i], "weight": round(w, 4), "capital_usd": round(cap * w, 2)}
                for i, w in enumerate(score_weights)
            ],
        }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_bots": len(bot_data),
        "method_default": "inverse_volatility",
        "capitals": PORTFOLIO_CAPITALS,
        "allocations": allocations,
        "notes": "Risk parity ≈ inverse volatility when correlation ≈ 0. Equal weight = naive baseline. Score weighted = bias toward Promotion Score.",
    }


# --- 6. Bayesian shrinkage (cohort-adjusted) -----------------------------

def _primary_symbol(bot):
    syms = bot.get("symbols") or []
    if not syms:
        return None
    # Strip broker suffix (e.g., "EURUSD.b" → "EURUSD")
    return syms[0].split(".")[0].upper()


def _age_bucket(months_active):
    if not months_active:
        return 0
    for b in SHRINKAGE_AGE_BUCKETS:
        if months_active <= b:
            return b
    return SHRINKAGE_AGE_BUCKETS[-1] + 1


def _cohort_key(bot):
    return (_primary_symbol(bot), _age_bucket(bot.get("months_active") or 0))


def compute_shrunk_scores(snap):
    """Empirical-Bayes shrinkage of promotion_score toward cohort prior.

    Cohort = (primary_symbol, age_bucket). Shrinkage weight w = n_eff / (n_eff + k0)
    where n_eff = sqrt(trades * months_active). Bots with low n_eff get pulled
    hard toward the cohort mean (kills survivorship-by-luck on small samples).

    Mutates each bot in-place adding:
      - promotion_score_raw (original)
      - promotion_score_shrunk (the shrunk value, for reference/shadow)
      - shrinkage_meta = {cohort, cohort_n, cohort_prior, global_prior, n_eff, w, delta}
    NOTE: promotion_score STAYS = raw (NOT overwritten — preserves the original status
    pyramid). promotion_status is assigned later by the rank-based 6b block over the
    demo-only deduped pool, NOT from the shrunk score here.
    """
    bots = snap.get("bots", [])
    if not bots:
        return None

    # Use only gating-passing bots to compute priors (avoid bias from broken bots).
    eligible = [b for b in bots if all((b.get("promotion_gating") or {}).values())
                and b.get("promotion_score") is not None]
    if not eligible:
        return None

    # Global prior: trades-weighted mean of eligible scores.
    total_w = 0.0
    weighted = 0.0
    for b in eligible:
        w = max(1, b.get("trades") or 1)
        weighted += (b["promotion_score"]) * w
        total_w += w
    global_prior = weighted / total_w if total_w > 0 else 0.0

    # Cohort priors (trades-weighted within cohort).
    by_cohort = {}
    for b in eligible:
        ck = _cohort_key(b)
        by_cohort.setdefault(ck, []).append(b)
    cohort_prior = {}
    for ck, members in by_cohort.items():
        if len(members) < SHRINKAGE_MIN_COHORT:
            continue
        tw = sum(max(1, m.get("trades") or 1) for m in members)
        cp = sum((m["promotion_score"]) * max(1, m.get("trades") or 1) for m in members) / tw
        cohort_prior[ck] = {"prior": cp, "n": len(members)}

    # Shrink every bot. CRITICAL: shrunk is a CONFIDENCE OVERLAY, not the
    # primary status driver. promotion_score / promotion_status remain anchored
    # to the raw score (which already passes hard gating), so the existing
    # READY/NEAR/WATCH pyramid stays intact and the dashboard shows real
    # candidates. The shrunk value + delta are surfaced as a separate
    # confidence indicator (visible in Score tab + Query DSL).
    promoted_counts = {}
    for b in bots:
        raw = b.get("promotion_score")
        if raw is None:
            continue
        b.setdefault("promotion_score_raw", raw)
        ck = _cohort_key(b)
        cp = cohort_prior.get(ck)
        prior_used = cp["prior"] if cp else global_prior
        cohort_n = cp["n"] if cp else 0
        n_eff = math.sqrt(max(1, b.get("trades") or 1) * max(1, b.get("months_active") or 1))
        w = n_eff / (n_eff + SHRINKAGE_K0)
        shrunk = w * raw + (1 - w) * prior_used
        shrunk = round(shrunk, 1)
        delta = round(shrunk - raw, 2)
        # Confidence label: how aligned is the shrunk vs raw (small |delta| = high confidence).
        if abs(delta) < 2:
            confidence = "HIGH"
        elif abs(delta) < 5:
            confidence = "MEDIUM"
        else:
            confidence = "LOW"
        b["promotion_score_shrunk"] = shrunk
        # promotion_score stays = raw; do NOT overwrite (preserves original status pyramid).
        b["shrinkage_meta"] = {
            "cohort_key": f"{ck[0] or '∅'}/{ck[1]}",
            "cohort_n": cohort_n,
            "cohort_prior_used": cp is not None,
            "prior_value": round(prior_used, 2),
            "global_prior": round(global_prior, 2),
            "n_eff": round(n_eff, 2),
            "weight_observed": round(w, 3),
            "weight_prior": round(1 - w, 3),
            "delta": delta,
            "confidence": confidence,
        }
        promoted_counts[b.get("promotion_status") or "?"] = promoted_counts.get(b.get("promotion_status") or "?", 0) + 1

    return {
        "global_prior": round(global_prior, 2),
        "cohorts_with_prior": len(cohort_prior),
        "cohorts_total": len(by_cohort),
        "k0": SHRINKAGE_K0,
        "status_counts_post_shrinkage": promoted_counts,
    }


# --- 7. Drift Watchdog (Page-Hinkley over daily_net) ---------------------

def page_hinkley_drift(daily_series):
    """Sequential change-point detection over `daily_net`.
    Returns dict with breakpoint info or None if insufficient data / no drift.
    """
    if not daily_series or len(daily_series) < PH_MIN_DAYS:
        return None
    nets = [row.get("daily_net", 0.0) or 0.0 for row in daily_series]
    dates = [row.get("date") for row in daily_series]
    n = len(nets)

    sd = stdev(nets)
    if sd <= 0:
        return None
    lam = PH_LAMBDA_FACTOR * sd

    # Running estimate of mean (cumulative).
    running_mean = nets[0]
    cum_dev = 0.0
    cum_min = 0.0
    breakpoint_idx = None
    breakpoint_severity = 0.0
    for i in range(1, n):
        running_mean = running_mean + (nets[i] - running_mean) / (i + 1)
        # Negative-direction drift: detect when daily_net falls persistently below mean.
        cum_dev += (nets[i] - running_mean - PH_DELTA)
        if cum_dev > 0:
            cum_dev = 0.0
            cum_min = 0.0
            continue
        if cum_dev < cum_min:
            cum_min = cum_dev
        gap = -cum_dev - (-cum_min)  # always >=0
        # Page-Hinkley fires when the descending excursion crosses lambda.
        excursion = abs(cum_min)
        if excursion > lam and breakpoint_idx is None:
            breakpoint_idx = i
            breakpoint_severity = round(excursion / lam, 2)
            break

    if breakpoint_idx is None:
        return {
            "flag": False,
            "lambda": round(lam, 4),
            "stdev_daily": round(sd, 4),
            "n_days": n,
        }

    bp_date = dates[breakpoint_idx]
    before = nets[:breakpoint_idx]
    after = nets[breakpoint_idx:]
    before_sum = sum(before)
    after_sum = sum(after)
    days_before = len(before)
    days_after = len(after)
    before_per_day = before_sum / max(1, days_before)
    after_per_day = after_sum / max(1, days_after)
    today_iso = datetime.now(timezone.utc).date().isoformat()
    days_since_break = None
    try:
        d_bp = datetime.fromisoformat(bp_date).date()
        d_today = datetime.fromisoformat(today_iso).date()
        days_since_break = (d_today - d_bp).days
    except (ValueError, TypeError):
        pass

    return {
        "flag": True,
        "breakpoint_date": bp_date,
        "breakpoint_idx": breakpoint_idx,
        "severity": breakpoint_severity,           # excursion / lambda (1.0 = exact threshold)
        "lambda": round(lam, 4),
        "stdev_daily": round(sd, 4),
        "n_days": n,
        "days_before": days_before,
        "days_after": days_after,
        "days_since_break": days_since_break,
        "net_before_per_day": round(before_per_day, 4),
        "net_after_per_day": round(after_per_day, 4),
        "net_delta_per_day": round(after_per_day - before_per_day, 4),
        "interpretation": (
            "DRIFT SEVERO" if breakpoint_severity >= 2.0 else
            "DRIFT MODERADO" if breakpoint_severity >= 1.3 else
            "DRIFT INCIPIENTE"
        ),
    }


# --- 8. Capacity Forecaster + Real-vs-Demo divergence --------------------

def _liquidity_tier_for(bot):
    sym = _primary_symbol(bot)
    if not sym:
        return 3
    if sym in LIQUIDITY_TIER:
        return LIQUIDITY_TIER[sym]
    # Heuristics for unmapped symbols.
    if sym.startswith(("XAU", "XAG", "OIL", "BRENT", "WTI")):
        return 3
    if "JPY" in sym or "EUR" in sym or "GBP" in sym or "USD" in sym:
        return 2
    return 3


def compute_capacity(bot, trades):
    """Estimate USD capacity before slippage degrades the strategy.

    Heuristic: capacity is bounded by how much volume the bot pushes per unit
    time on its primary symbol. The faster the cadence and the lower the
    liquidity tier, the smaller the safe capital.

    capacity_usd = base_tier × liquidity_factor × pace_factor × position_factor

    where pace_factor ↓ as trades_per_day ↑ (scalpers cap lower) and
          position_factor ↓ as avg_volume → broker-typical maxima.
    """
    if not trades:
        return None
    tier = _liquidity_tier_for(bot)
    base = TIER_BASE_CAPACITY[tier]
    liq = TIER_LIQUIDITY_FACTOR[tier]

    months = bot.get("months_active") or 1
    n_trades = bot.get("trades") or len(trades)
    days_active = max(1.0, months * 30.0)
    trades_per_day = n_trades / days_active

    durations = [t.get("duration_sec", 0) or 0 for t in trades]
    durations = [d for d in durations if d > 0]
    avg_dur_h = (sum(durations) / len(durations) / 3600.0) if durations else 24.0

    volumes = [t.get("volume", 0) or 0 for t in trades if t.get("volume")]
    avg_vol = sum(volumes) / len(volumes) if volumes else 0.01

    # Pace factor: scalpers (>10 trades/day) capped harder than swing (<1/day).
    if trades_per_day >= 20:
        pace_factor = 0.10
    elif trades_per_day >= 10:
        pace_factor = 0.25
    elif trades_per_day >= 3:
        pace_factor = 0.50
    elif trades_per_day >= 1:
        pace_factor = 0.75
    else:
        pace_factor = 1.0

    # Position factor: 0.01 lot baseline = 1.0; degrades as you scale.
    # Avg lot 0.05 → 0.8; 0.10 → 0.6; 0.50 → 0.3; 1.0+ → 0.15.
    if avg_vol <= 0.02:
        position_factor = 1.0
    elif avg_vol <= 0.05:
        position_factor = 0.8
    elif avg_vol <= 0.10:
        position_factor = 0.6
    elif avg_vol <= 0.50:
        position_factor = 0.3
    else:
        position_factor = 0.15

    capacity = base * liq * pace_factor * position_factor
    # Confidence band: ±35%.
    cap_low = round(capacity * 0.65, 0)
    cap_high = round(capacity * 1.35, 0)

    return {
        "capacity_usd": round(capacity, 0),
        "capacity_usd_low": cap_low,
        "capacity_usd_high": cap_high,
        "tier": tier,
        "tier_label": ["", "Major", "Minor/Cross", "Exotic/Metals"][tier],
        "trades_per_day": round(trades_per_day, 2),
        "avg_duration_hours": round(avg_dur_h, 2),
        "avg_volume_lots": round(avg_vol, 3),
        "pace_factor": pace_factor,
        "liquidity_factor": liq,
        "position_factor": position_factor,
        "verdict": (
            "🟢 ESCALABLE" if capacity >= 50000 else
            "🟡 CAPACIDAD MEDIA" if capacity >= 15000 else
            "🟠 CAPACIDAD LIMITADA" if capacity >= 5000 else
            "🔴 NO ESCALABLE"
        ),
    }


def detect_real_accounts(snap):
    """Return set of (vps, login) tuples for accounts flagged as real."""
    real = set()
    for a in snap.get("accounts", []):
        # Single source of truth: the VPS snapshot_builder flags is_real = (trade_mode==2)
        # (ACCOUNT_TRADE_MODE_REAL). No hardcoded login list — a new real is picked up
        # automatically. `account_kind`/`type` kept as a defensive fallback.
        kind = (a.get("account_kind") or a.get("type") or "").lower()
        if a.get("is_real") or "real" in kind:
            real.add((a.get("vps"), a.get("login")))
    return real


def detect_real_magics(snap):
    """Return set of magics (EAs) currently deployed to a real account — by closed
    trades this year OR by an open real position. These magics are excluded from the
    promotion-discovery views (Candidatos/Tracker/Portfolio): the goal is to surface
    demo-only EAs not yet running real."""
    real_logins = {login for (_vps, login) in detect_real_accounts(snap)}
    magics = set()
    for b in snap.get("bots", []):
        if b.get("account_login") in real_logins and b.get("magic"):
            magics.add(b["magic"])
    rp = snap.get("real_portfolio") or {}
    for p in rp.get("open_positions") or []:
        if p.get("magic"):
            magics.add(p["magic"])
    return magics


def compute_real_vs_demo_divergence(bot, real_accounts):
    """If the bot runs on a real account AND a same-magic twin runs on demo,
    surface a comparison block. For now we only know magic+symbols match;
    twins are flagged but no per-trade matching (requires sync ts which broker
    differs slightly). This emits the structural block for the UI to render.
    """
    key = (bot.get("vps"), bot.get("account_login"))
    if key not in real_accounts:
        return None
    return {
        "is_real": True,
        "magic": bot.get("magic"),
        "primary_symbol": _primary_symbol(bot),
        "real_trades": bot.get("trades"),
        "real_net_profit": bot.get("net_profit"),
        "real_wr": bot.get("win_rate_pct"),
        "real_pf": bot.get("profit_factor"),
        "note": "Bot operando con dinero real. Para detectar divergencia se requiere magic gemelo en demo (mismo periodo).",
    }


# --- 9. Underwater analysis (top drawdowns + recovery) ------------------

def underwater_analysis(daily_series, account_balance):
    """Episodes of underwater equity (peak → recover). Top 10 by depth.

    Returns dict with top_drawdowns[], pain_index_pct, longest_underwater_days,
    recovery_factor_proper, n_episodes.
    """
    if not daily_series or len(daily_series) < 10:
        return None

    episodes = []
    in_dd = False
    ep = None
    for i, pt in enumerate(daily_series):
        dd_abs = pt.get("dd_abs") or 0
        dd_pct = pt.get("dd_pct") or 0
        if dd_abs > 0 and not in_dd:
            in_dd = True
            ep = {
                "start_date": pt.get("date"), "start_idx": i,
                "max_dd_abs": dd_abs, "max_dd_pct": dd_pct,
                "max_dd_date": pt.get("date"), "max_dd_idx": i,
            }
        elif in_dd:
            if dd_abs > ep["max_dd_abs"]:
                ep["max_dd_abs"] = dd_abs
                ep["max_dd_pct"] = dd_pct
                ep["max_dd_date"] = pt.get("date")
                ep["max_dd_idx"] = i
            if dd_abs == 0:
                in_dd = False
                ep["end_date"] = pt.get("date")
                ep["end_idx"] = i
                ep["underwater_days"] = i - ep["start_idx"]
                ep["recovery_days"] = i - ep["max_dd_idx"]
                ep["ongoing"] = False
                episodes.append(ep)
                ep = None

    if in_dd and ep is not None:
        last = daily_series[-1]
        ep["end_date"] = last.get("date")
        ep["end_idx"] = len(daily_series) - 1
        ep["underwater_days"] = ep["end_idx"] - ep["start_idx"]
        ep["recovery_days"] = None
        ep["ongoing"] = True
        episodes.append(ep)

    episodes_sorted = sorted(episodes, key=lambda e: e["max_dd_abs"], reverse=True)
    top = []
    for e in episodes_sorted[:10]:
        top.append({
            "start_date": e["start_date"], "end_date": e["end_date"],
            "max_dd_date": e["max_dd_date"],
            "max_dd_abs": round(e["max_dd_abs"], 2),
            "max_dd_pct": round(e["max_dd_pct"], 3),
            "underwater_days": e["underwater_days"],
            "recovery_days": e["recovery_days"],
            "ongoing": e.get("ongoing", False),
        })

    dd_pcts = [pt.get("dd_pct") or 0 for pt in daily_series]
    pain = sum(dd_pcts) / len(dd_pcts) if dd_pcts else 0
    longest = max((e["underwater_days"] for e in episodes), default=0)

    final_cum = (daily_series[-1].get("cum_net") or 0) if daily_series else 0
    max_dd_abs_overall = max((e["max_dd_abs"] for e in episodes), default=0)
    rec_factor = (final_cum / max_dd_abs_overall) if max_dd_abs_overall > 0 else None

    return {
        "top_drawdowns": top,
        "pain_index_pct": round(pain, 4),
        "longest_underwater_days": int(longest),
        "recovery_factor_proper": round(rec_factor, 3) if rec_factor is not None else None,
        "n_episodes": len(episodes),
    }


# --- 10. Bootstrap Confidence Intervals ---------------------------------

def _bootstrap_quantiles(samples, runs, fn, seed):
    rng = random.Random(seed)
    n = len(samples)
    if n < 5:
        return None
    out = []
    for _ in range(runs):
        idx = [rng.randint(0, n - 1) for _ in range(n)]
        rs = [samples[i] for i in idx]
        try:
            v = fn(rs)
        except Exception:
            v = None
        if v is None:
            continue
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            continue
        out.append(v)
    if not out:
        return None
    out.sort()
    lo_p = (1 - CI_LEVEL) / 2
    hi_p = 1 - lo_p
    lo = out[max(0, int(lo_p * len(out)))]
    hi = out[min(len(out) - 1, int(hi_p * len(out)))]
    return lo, hi


def _pack_ci(point, ci, decimals=3):
    if point is None or ci is None:
        return None
    lo, hi = ci
    width = hi - lo
    rel_w = (width / abs(point)) if point and abs(point) > 1e-9 else None
    stable = rel_w is not None and rel_w < 0.5
    return {
        "point": round(point, decimals),
        "lo": round(lo, decimals),
        "hi": round(hi, decimals),
        "width": round(width, decimals),
        "stable": stable,
    }


def confidence_intervals(daily_series, trades):
    """Bootstrap 95% CI for Sharpe, Sortino, Calmar, ProfitFactor, WinRate."""
    if not daily_series or len(daily_series) < CI_MIN_DAYS:
        return None
    if not trades or len(trades) < CI_MIN_TRADES:
        return None

    daily_returns = [pt.get("daily_net") or 0.0 for pt in daily_series]
    nets = [t.get("net") or 0.0 for t in trades]

    def sharpe_fn(rs):
        m = sum(rs) / len(rs)
        sd = stdev(rs)
        return (m / sd) * math.sqrt(252) if sd and sd > 0 else None

    def sortino_fn(rs):
        m = sum(rs) / len(rs)
        downs = [r for r in rs if r < 0]
        if not downs:
            return None
        sd = stdev(downs)
        return (m / sd) * math.sqrt(252) if sd and sd > 0 else None

    def calmar_fn(rs):
        cum = 0.0
        peak = 0.0
        mdd = 0.0
        for r in rs:
            cum += r
            if cum > peak:
                peak = cum
            d = peak - cum
            if d > mdd:
                mdd = d
        if mdd <= 0:
            return None
        years = len(rs) / 252.0
        if years <= 0:
            return None
        annret = cum / years
        return annret / mdd

    def pf_fn(ns):
        wins = sum(n for n in ns if n > 0)
        losses = -sum(n for n in ns if n < 0)
        return (wins / losses) if losses > 0 else None

    def wr_fn(ns):
        if not ns:
            return None
        return sum(1 for n in ns if n > 0) / len(ns) * 100.0

    sh_pt = sharpe_fn(daily_returns)
    so_pt = sortino_fn(daily_returns)
    cl_pt = calmar_fn(daily_returns)
    pf_pt = pf_fn(nets)
    wr_pt = wr_fn(nets)

    sh_ci = _bootstrap_quantiles(daily_returns, CI_RUNS, sharpe_fn, CI_SEED)
    so_ci = _bootstrap_quantiles(daily_returns, CI_RUNS, sortino_fn, CI_SEED + 1)
    cl_ci = _bootstrap_quantiles(daily_returns, CI_RUNS, calmar_fn, CI_SEED + 2)
    pf_ci = _bootstrap_quantiles(nets, CI_RUNS, pf_fn, CI_SEED + 3)
    wr_ci = _bootstrap_quantiles(nets, CI_RUNS, wr_fn, CI_SEED + 4)

    months = len(daily_series) / 30.0
    low_conf = len(trades) < 50 or months < 4

    return {
        "sharpe": _pack_ci(sh_pt, sh_ci),
        "sortino": _pack_ci(so_pt, so_ci),
        "calmar": _pack_ci(cl_pt, cl_ci),
        "profit_factor": _pack_ci(pf_pt, pf_ci),
        "win_rate_pct": _pack_ci(wr_pt, wr_ci, decimals=2),
        "n_runs": CI_RUNS,
        "ci_level": CI_LEVEL,
        "low_confidence": low_conf,
        "n_days": len(daily_series),
        "n_trades": len(trades),
    }


# --- 11. Historical Event Stress (replay during real macro events) -------

def event_stress(daily_series, trades):
    """Replay bot during pre-defined historical macro windows."""
    if not daily_series:
        return None

    daily_by_date = {pt.get("date"): pt for pt in daily_series if pt.get("date")}
    series_dates = sorted(daily_by_date.keys()) if daily_by_date else []
    earliest = series_dates[0] if series_dates else None

    results = []
    for ev in EVENT_WINDOWS:
        in_window = [daily_by_date[d] for d in series_dates
                     if ev["start"] <= d <= ev["end"]]
        ev_trades = []
        for t in trades or []:
            ct = t.get("close_time") or 0
            if not ct:
                continue
            try:
                d = datetime.fromtimestamp(ct, tz=timezone.utc).strftime("%Y-%m-%d")
            except (OSError, ValueError):
                continue
            if ev["start"] <= d <= ev["end"]:
                ev_trades.append(t)

        if earliest and earliest > ev["end"]:
            results.append({**ev, "active": False, "reason": "not_yet_running"})
            continue
        if not in_window and not ev_trades:
            results.append({**ev, "active": False, "reason": "no_activity"})
            continue

        net = sum((t.get("net") or 0) for t in ev_trades)
        n = len(ev_trades)
        wins = sum(1 for t in ev_trades if (t.get("net") or 0) > 0)
        wr = (wins / n * 100) if n else None

        cum = 0.0
        peak = 0.0
        mdd = 0.0
        for pt in in_window:
            cum += (pt.get("daily_net") or 0)
            if cum > peak:
                peak = cum
            d = peak - cum
            if d > mdd:
                mdd = d

        verdict = "positive" if net > 0 else ("negative" if net < 0 else "flat")
        results.append({
            **ev, "active": True, "trades": n,
            "net": round(net, 2),
            "win_rate_pct": round(wr, 2) if wr is not None else None,
            "max_dd_intra": round(mdd, 2),
            "days_in_window": len(in_window),
            "verdict": verdict,
        })

    n_active = sum(1 for r in results if r.get("active"))
    n_positive = sum(1 for r in results if r.get("verdict") == "positive")
    return {
        "events": results,
        "n_active": n_active,
        "n_positive": n_positive,
        "battle_tested": n_active >= 3,
        "n_total_events": len(EVENT_WINDOWS),
    }


# --- 12. Promotion Radar (8-axis percentile-rank normalization) ----------

RADAR_AXES = ("returns", "risk_adjusted", "consistency", "decay_health",
              "sample_size", "regime_robustness", "oos_generalization",
              "capacity_headroom")
RADAR_AXIS_LABELS = {
    "returns": "Retornos anualizados",
    "risk_adjusted": "Risk-Adj (Calmar)",
    "consistency": "% Meses+",
    "decay_health": "Salud (decay)",
    "sample_size": "Sample size",
    "regime_robustness": "Robustez temporal",
    "oos_generalization": "OOS generalization",
    "capacity_headroom": "Capacity",
}


def _radar_axis_value(b, accounts_by_login, axis):
    if axis == "returns":
        bal = (accounts_by_login.get(b.get("account_login")) or {}).get("balance", 0)
        m = b.get("months_active") or 0
        if not bal or not m or m < 1:
            return None
        return (b.get("net_profit") or 0) / bal * (12.0 / m) * 100.0
    if axis == "risk_adjusted":
        return b.get("calmar")
    if axis == "consistency":
        return b.get("months_positive_pct")
    if axis == "decay_health":
        if b.get("decay_flag"):
            return 0.0
        dr = b.get("decay_ratio")
        return dr if dr is not None else None
    if axis == "sample_size":
        return b.get("trades")
    if axis == "regime_robustness":
        return ((b.get("regime") or {}).get("robustness_score"))
    if axis == "oos_generalization":
        return ((b.get("oos") or {}).get("oos_score"))
    if axis == "capacity_headroom":
        return ((b.get("capacity") or {}).get("capacity_usd"))
    return None


def _percentile_rank(value, sorted_pop):
    """Empirical CDF rank with midrank for ties. Returns 0–100, or None if no pop."""
    if value is None or not sorted_pop:
        return None
    n = len(sorted_pop)
    below = 0
    equal = 0
    for v in sorted_pop:
        if v < value:
            below += 1
        elif v == value:
            equal += 1
        else:
            break
    rank = below + equal / 2.0
    return (rank / n) * 100.0


DOMINANCE_AXES = ("money", "risk", "consistency", "stability")
DOMINANCE_AXIS_LABELS = {
    "money": "Dinero (return mensual neto)",
    "risk": "Riesgo (Calmar)",
    "consistency": "Consistencia (% meses+)",
    "stability": "Estabilidad (Sortino)",
}
DOMINANCE_P75 = 75.0


def _dominance_axis_value(b, accounts_by_login, axis):
    """Commission-honest core-axis values for the dominance/thoroughbred check."""
    if axis == "money":
        bal = (accounts_by_login.get(b.get("account_login")) or {}).get("balance", 0)
        m = b.get("months_active") or 0
        nac = b.get("net_after_commission")
        if nac is None or not bal or bal <= 0 or m < 1:
            return None
        return (nac / bal) / m * 100.0
    if axis == "risk":
        return b.get("calmar")
    if axis == "consistency":
        return b.get("months_positive_pct")
    if axis == "stability":
        return b.get("sortino")
    return None


def compute_dominance(snap, accounts_by_login):
    """Per-bot dominance diagnostic over the gating-eligible cohort on 4 core axes
    (money / risk / consistency / stability). Answers the owner's question "are these
    the 3 thoroughbreds, better than the whole demo book in every sense?":
      - per-axis percentile-rank (0–100) vs the cohort,
      - all_ge_p75: top-25% on EVERY axis,
      - dominated_by: magic of any other eligible bot that Pareto-dominates it
        (≥ on all 4 axes and > on ≥1), else None,
      - is_thoroughbred: all_ge_p75 AND not dominated.
    These are DIAGNOSTIC badges only — they never change promotion_status (always-3
    by score). STATELESS: pure function of the current snapshot (no pinning)."""
    bots = snap.get("bots", [])
    eligible = [b for b in bots
                if all((b.get("promotion_gating") or {}).values())
                and b.get("magic")
                and b.get("net_after_commission") is not None]
    if len(eligible) < 3:
        for b in bots:
            b.pop("dominance", None)
        return None

    pop = {ax: [] for ax in DOMINANCE_AXES}
    raws = {}
    for b in eligible:
        rv = {}
        for ax in DOMINANCE_AXES:
            v = _dominance_axis_value(b, accounts_by_login, ax)
            rv[ax] = v
            if v is not None:
                pop[ax].append(v)
        raws[id(b)] = rv
    for ax in DOMINANCE_AXES:
        pop[ax].sort()
    p75 = {ax: (percentile(pop[ax], 0.75) if pop[ax] else None) for ax in DOMINANCE_AXES}

    pcts = {}
    for b in eligible:
        rv = raws[id(b)]
        ax_out, all_ge = {}, True
        for ax in DOMINANCE_AXES:
            pr = _percentile_rank(rv[ax], pop[ax])
            ax_out[ax] = {
                "raw": (round(rv[ax], 4) if rv[ax] is not None else None),
                "pct": (round(pr, 1) if pr is not None else None),
                "label": DOMINANCE_AXIS_LABELS[ax],
            }
            if pr is None or pr < DOMINANCE_P75:
                all_ge = False
        pcts[id(b)] = (ax_out, all_ge)

    def _vec(b):
        ax_out = pcts[id(b)][0]
        return [(ax_out[ax]["pct"] if ax_out[ax]["pct"] is not None else -1.0)
                for ax in DOMINANCE_AXES]

    for a in eligible:
        va = _vec(a)
        dominated_by = None
        for c in eligible:
            if c is a:
                continue
            vc = _vec(c)
            if all(vc[i] >= va[i] for i in range(len(DOMINANCE_AXES))) and \
               any(vc[i] > va[i] for i in range(len(DOMINANCE_AXES))):
                dominated_by = c.get("magic")
                break
        ax_out, all_ge = pcts[id(a)]
        a["dominance"] = {
            "axes": ax_out,
            "all_ge_p75": all_ge,
            "dominated_by": dominated_by,
            "is_thoroughbred": all_ge and dominated_by is None,
        }

    elig_ids = {id(b) for b in eligible}
    for b in bots:
        if id(b) not in elig_ids:
            b.pop("dominance", None)

    return {
        "axes": list(DOMINANCE_AXES),
        "axis_labels": DOMINANCE_AXIS_LABELS,
        "p75_threshold_pct": DOMINANCE_P75,
        "p75_raw": {ax: (round(p75[ax], 4) if p75[ax] is not None else None)
                    for ax in DOMINANCE_AXES},
        "n_eligible": len(eligible),
    }


def compute_promotion_radar(snap, accounts_by_login):
    """Per-bot 8-axis radar with percentile-rank normalization on the
    gating-eligible cohort. Median bot ≈ 50 on every axis. Returns
    cohort meta {axes, axis_labels, cohort, n_eligible} and mutates
    each bot adding `promotion_radar`.
    """
    bots = snap.get("bots", [])
    if not bots:
        return None
    eligible = [b for b in bots
                if all((b.get("promotion_gating") or {}).values())
                and b.get("magic")]
    if len(eligible) < 5:
        return None

    # Sorted population per axis (drop None) — used for percentile_rank.
    pop = {}
    for ax in RADAR_AXES:
        vals = []
        for b in eligible:
            v = _radar_axis_value(b, accounts_by_login, ax)
            if v is not None:
                vals.append(v)
        vals.sort()
        pop[ax] = vals

    cohort_meta = {}
    for ax in RADAR_AXES:
        sp = pop[ax]
        if not sp:
            cohort_meta[ax] = {"label": RADAR_AXIS_LABELS[ax], "n": 0}
            continue
        cohort_meta[ax] = {
            "label": RADAR_AXIS_LABELS[ax],
            "p25": round(percentile(sp, 0.25), 4),
            "p50": round(percentile(sp, 0.50), 4),
            "p75": round(percentile(sp, 0.75), 4),
            "min": round(sp[0], 4),
            "max": round(sp[-1], 4),
            "n": len(sp),
        }

    # Per-bot enrichment.
    radar_count = 0
    for b in bots:
        if not b.get("magic"):
            continue
        axes_out = {}
        sum_p = 0.0
        n_p = 0
        for ax in RADAR_AXES:
            raw = _radar_axis_value(b, accounts_by_login, ax)
            pct = _percentile_rank(raw, pop[ax])
            axes_out[ax] = {
                "raw": (round(raw, 4) if raw is not None else None),
                "pct": (round(pct, 1) if pct is not None else None),
                "label": RADAR_AXIS_LABELS[ax],
            }
            if pct is not None:
                sum_p += pct
                n_p += 1
        area_pct = round(sum_p / n_p, 1) if n_p else None
        if area_pct is None:
            shape = "INSUFICIENTE"
        elif area_pct >= 70:
            shape = "EQUILIBRADO ALTO"
        elif area_pct >= 50:
            shape = "PROMEDIO ALTO"
        elif area_pct >= 30:
            shape = "PROMEDIO BAJO"
        else:
            shape = "DEBIL"
        only_pcts = [v["pct"] for v in axes_out.values() if v["pct"] is not None]
        asym = round(stdev(only_pcts), 1) if len(only_pcts) >= 2 else None
        if asym is None:
            asym_label = "—"
        elif asym > 25:
            asym_label = "ESPIGA"           # one or two axes carry everything
        elif asym > 18:
            asym_label = "DESEQUILIBRADO"
        else:
            asym_label = "EQUILIBRADO"
        b["promotion_radar"] = {
            "axes": axes_out,
            "area_pct": area_pct,
            "shape_label": shape,
            "asymmetry": asym,
            "asymmetry_label": asym_label,
            "n_axes_computed": n_p,
        }
        radar_count += 1

    return {
        "axes": list(RADAR_AXES),
        "axis_labels": RADAR_AXIS_LABELS,
        "cohort": cohort_meta,
        "n_eligible": len(eligible),
        "n_decorated": radar_count,
        "method": "Empirical-CDF percentile rank (midrank for ties) over gating-eligible cohort.",
    }


# --- 13. Trade-PnL Distribution stats (for client-side violin) -----------

def compute_trade_distribution_stats(trades):
    """Distribution stats (Fisher–Pearson moments + tail-contribution) for trade nets.
    Used by the client-side violin/density plot. Lightweight: just summary stats,
    not the full sample (that lives in the per-bot file already)."""
    nets = sorted([t.get("net", 0.0) or 0.0 for t in (trades or []) if t.get("net") is not None])
    n = len(nets)
    if n < 30:
        return None
    total = sum(nets)
    mean = total / n
    sd = stdev(nets)
    if sd > 0:
        m3 = sum((x - mean) ** 3 for x in nets) / n
        m4 = sum((x - mean) ** 4 for x in nets) / n
        skew = m3 / (sd ** 3)
        kurt_excess = m4 / (sd ** 4) - 3.0
    else:
        skew = 0.0
        kurt_excess = 0.0

    p5 = percentile(nets, 0.05)
    p25 = percentile(nets, 0.25)
    med = percentile(nets, 0.50)
    p75 = percentile(nets, 0.75)
    p95 = percentile(nets, 0.95)

    top5_count = max(1, int(round(n * 0.05)))
    top5_sum = sum(nets[-top5_count:])
    top5_contrib = (top5_sum / total * 100.0) if total > 0 else None

    wins = [x for x in nets if x > 0]
    losses = [x for x in nets if x < 0]

    if total <= 0:
        dtype = "PERDEDOR"
    elif top5_contrib is None:
        dtype = "INDETERMINADO"
    elif top5_contrib >= 75:
        dtype = "LOTTERY"
    elif top5_contrib >= 50:
        dtype = "OUTLIER_DEPENDIENTE"
    elif top5_contrib >= 30:
        dtype = "BALANCEADO"
    else:
        dtype = "GRINDER"

    bw = 1.06 * sd * (n ** (-1.0 / 5.0)) if sd > 0 else 0.0

    interp = {
        "GRINDER": "🟢 Grinder consistente — cola benigna, ningún outlier carga el resultado.",
        "BALANCEADO": "🟢 Balanceado — net distribuido sanamente entre muchos trades.",
        "OUTLIER_DEPENDIENTE": "🟡 Dependiente de outliers — ~50% del net viene del top 5%.",
        "LOTTERY": "🔴 Lottery tail — el net depende casi completamente de unos pocos trades enormes.",
        "PERDEDOR": "⚫ Bot net negativo.",
    }.get(dtype, "")

    return {
        "n": n,
        "mean": round(mean, 4),
        "median": round(med, 4),
        "stdev": round(sd, 4),
        "skewness": round(skew, 3),
        "excess_kurtosis": round(kurt_excess, 3),
        "min": round(nets[0], 4),
        "max": round(nets[-1], 4),
        "p5": round(p5, 4),
        "p25": round(p25, 4),
        "p75": round(p75, 4),
        "p95": round(p95, 4),
        "wins_count": len(wins),
        "losses_count": len(losses),
        "wins_sum": round(sum(wins), 4),
        "losses_sum": round(sum(losses), 4),
        "top5pct_count": top5_count,
        "top5pct_sum": round(top5_sum, 4),
        "top5pct_contribution_pct": round(top5_contrib, 2) if top5_contrib is not None else None,
        "distribution_type": dtype,
        "interpretation": interp,
        "kde_bandwidth": round(bw, 6),
    }


# --- 14. Adversarial Pair Finder ----------------------------------------

PAIR_PARTNER_STATUSES = ("READY", "NEAR", "WATCH")
PAIR_TARGET_STATUSES = ("READY", "NEAR")
PAIR_TOP_N = 3
PAIR_MIN_OVERLAP_DAYS = 20


def _combo_metrics(daily_a, daily_b, weight_a=0.5):
    """Equal-weight (or weighted) combination of two daily-net series. Returns
    {n_days, total_net, max_dd, calmar, sharpe, sortino} or None if too short."""
    if not daily_a:
        return None
    all_dates = sorted(set(daily_a) | set(daily_b or {}))
    if len(all_dates) < PAIR_MIN_OVERLAP_DAYS:
        return None
    nets = [
        (daily_a.get(d, 0.0) * weight_a + (daily_b or {}).get(d, 0.0) * (1 - weight_a))
        for d in all_dates
    ]
    cum = 0.0
    peak = 0.0
    mdd = 0.0
    for v in nets:
        cum += v
        if cum > peak:
            peak = cum
        d = peak - cum
        if d > mdd:
            mdd = d
    n = len(nets)
    years = n / 252.0
    calmar = None
    if years > 0 and mdd > 0:
        calmar = (cum / years) / mdd
    m = sum(nets) / n
    sd = stdev(nets)
    sharpe = (m / sd) * math.sqrt(252) if sd and sd > 0 else None
    downs = [r for r in nets if r < 0]
    sd_d = stdev(downs) if len(downs) >= 2 else 0.0
    sortino = (m / sd_d) * math.sqrt(252) if sd_d and sd_d > 0 else None
    return {
        "n_days": n,
        "total_net": round(cum, 2),
        "max_dd": round(mdd, 2),
        "calmar": round(calmar, 3) if calmar is not None else None,
        "sharpe": round(sharpe, 3) if sharpe is not None else None,
        "sortino": round(sortino, 3) if sortino is not None else None,
    }


def compute_pair_recommendations(snap, data_dir):
    """For each READY/NEAR bot, find the top-3 best portfolio partners using
    50/50 daily-net combination. Ranks by diversification gain (combo Calmar
    uplift vs best solo). Skips same-account partners (not real diversification).
    Stores results into bot["pair_recommendations"]."""
    bots = snap.get("bots", [])
    candidates = [b for b in bots
                  if b.get("promotion_status") in PAIR_PARTNER_STATUSES
                  and b.get("magic")]
    if len(candidates) < 3:
        return 0

    series_cache = {}
    for b in candidates:
        sr = load_per_bot_series(data_dir, b["vps"], b["account_login"], b["magic"])
        if sr:
            key = f"{b['vps']}-{b['account_login']}-{b['magic']}"
            series_cache[key] = {row["date"]: (row.get("daily_net") or 0.0) for row in sr}

    targets = [b for b in candidates if b.get("promotion_status") in PAIR_TARGET_STATUSES]
    pair_count = 0
    for a in targets:
        ka = f"{a['vps']}-{a['account_login']}-{a['magic']}"
        if ka not in series_cache:
            continue
        a_series = series_cache[ka]
        a_solo = _combo_metrics(a_series, {}, weight_a=1.0)
        if not a_solo or a_solo.get("calmar") is None:
            continue
        evals = []
        for b in candidates:
            if b is a:
                continue
            if b.get("account_login") == a.get("account_login"):
                continue   # same account — not portfolio diversification
            kb = f"{b['vps']}-{b['account_login']}-{b['magic']}"
            if kb not in series_cache:
                continue
            b_series = series_cache[kb]
            combo = _combo_metrics(a_series, b_series, weight_a=0.5)
            if not combo or combo.get("calmar") is None:
                continue
            b_solo = _combo_metrics(b_series, {}, weight_a=1.0) or {}
            best_solo = max(a_solo.get("calmar") or 0, b_solo.get("calmar") or 0)
            div_gain = None
            if best_solo and best_solo > 0:
                div_gain = (combo["calmar"] - best_solo) / best_solo * 100.0
            # Pearson on aligned daily nets (zero-fill missing days).
            all_dates = sorted(set(a_series) | set(b_series))
            xa = [a_series.get(d, 0.0) for d in all_dates]
            xb = [b_series.get(d, 0.0) for d in all_dates]
            rho = pearson(xa, xb)
            evals.append({
                "vps": b["vps"],
                "login": b["account_login"],
                "magic": b["magic"],
                "symbol": (b.get("symbols") or [None])[0],
                "status": b["promotion_status"],
                "score": b.get("promotion_score"),
                "rho": round(rho, 3) if rho is not None else None,
                "combined": combo,
                "partner_solo_calmar": b_solo.get("calmar"),
                "partner_solo_max_dd": b_solo.get("max_dd"),
                "diversification_gain_pct": round(div_gain, 1) if div_gain is not None else None,
            })
        # Rank by diversification gain desc; then by ρ ascending (more negative = better hedge).
        evals.sort(key=lambda c: (
            -(c["diversification_gain_pct"] if c["diversification_gain_pct"] is not None else -1e9),
            (c["rho"] if c["rho"] is not None else 1.0),
        ))
        top = evals[:PAIR_TOP_N]
        if top:
            a["pair_recommendations"] = {
                "solo": a_solo,
                "partners": top,
                "n_evaluated": len(evals),
                "method": (
                    "50/50 equal-weight combination of daily_net series. "
                    "Diversification gain = (combo Calmar − best solo Calmar) / best solo Calmar × 100. "
                    "Rank: gain desc, then ρ asc."
                ),
            }
            pair_count += 1
    return pair_count


# --- 15. Survival Analysis (Kaplan-Meier on bot lifetimes) ---------------

SURVIVAL_BUCKETS = (
    {"id": "score_0_40",   "label": "Score 0–40",   "min": 0,  "max": 40},
    {"id": "score_40_60",  "label": "Score 40–60",  "min": 40, "max": 60},
    {"id": "score_60_75",  "label": "Score 60–75",  "min": 60, "max": 75},
    {"id": "score_75_100", "label": "Score 75–100", "min": 75, "max": 101},
)
SURVIVAL_HORIZON_MONTHS = 24


def _is_dead(bot):
    """Death (event observed) = ANY of:
      - decay_flag set
      - drift detected with severity >= 1.3
      - net_profit ≤ 0 with months_active ≥ 3
      - DD > 20% of account balance
    """
    if bot.get("decay_flag"):
        return True
    drift = bot.get("drift") or {}
    if drift.get("flag") and (drift.get("severity") or 0) >= 1.3:
        return True
    months = bot.get("months_active") or 0
    if months >= 3 and (bot.get("net_profit") or 0) <= 0:
        return True
    dd_pct = bot.get("dd_pct_of_balance") or 0
    if dd_pct >= 20:
        return True
    return False


def _bucket_for_score(score):
    if score is None:
        return None
    for b in SURVIVAL_BUCKETS:
        if b["min"] <= score < b["max"]:
            return b["id"]
    return None


def kaplan_meier(durations_events):
    """KM estimator with Greenwood variance + log-log 95% CI."""
    if not durations_events:
        return []
    event_times = sorted({d for d, ev in durations_events if ev})
    out = [{"t": 0.0, "S": 1.0, "ci_lo": 1.0, "ci_hi": 1.0,
            "n_at_risk": len(durations_events), "n_events": 0}]
    S = 1.0
    var_sum = 0.0
    for t in event_times:
        n_at_risk = sum(1 for d, _ in durations_events if d >= t)
        n_events = sum(1 for d, ev in durations_events if d == t and ev)
        if n_at_risk == 0:
            continue
        S = S * (1.0 - n_events / n_at_risk)
        if (n_at_risk - n_events) > 0:
            var_sum += n_events / (n_at_risk * (n_at_risk - n_events))
        var_S = (S * S) * var_sum
        if 0 < S < 1 and var_S > 0:
            try:
                se_log_log = math.sqrt(var_S) / (S * abs(math.log(S)))
                z = 1.96
                ci_lo = S ** math.exp(z * se_log_log)
                ci_hi = S ** math.exp(-z * se_log_log)
                ci_lo = max(0.0, min(1.0, ci_lo))
                ci_hi = max(0.0, min(1.0, ci_hi))
            except (ValueError, OverflowError):
                ci_lo = ci_hi = S
        else:
            ci_lo = ci_hi = S
        out.append({
            "t": round(t, 2),
            "S": round(S, 4),
            "ci_lo": round(ci_lo, 4),
            "ci_hi": round(ci_hi, 4),
            "n_at_risk": n_at_risk,
            "n_events": n_events,
        })
    return out


def build_survival_table(snap):
    """Compute KM curves for: overall, score buckets, top-6 symbols.
    Returns dict ready to write to data/survival.json."""
    bots = [b for b in snap.get("bots", [])
            if b.get("magic") and b.get("months_active")]
    if len(bots) < 10:
        return None
    all_de = [(float(b.get("months_active") or 0), _is_dead(b)) for b in bots]

    curves = {"overall": {
        "label": "Todos los bots",
        "n": len(all_de),
        "n_dead": sum(1 for _, e in all_de if e),
        "curve": kaplan_meier(all_de),
    }}

    for bucket in SURVIVAL_BUCKETS:
        sub = [(float(b["months_active"]), _is_dead(b)) for b in bots
               if bucket["min"] <= (b.get("promotion_score") or 0) < bucket["max"]]
        if len(sub) >= 5:
            curves[bucket["id"]] = {
                "label": bucket["label"],
                "n": len(sub),
                "n_dead": sum(1 for _, e in sub if e),
                "curve": kaplan_meier(sub),
                "score_min": bucket["min"],
                "score_max": bucket["max"],
            }

    by_sym = {}
    for b in bots:
        sym = _primary_symbol(b)
        if not sym:
            continue
        by_sym.setdefault(sym, []).append((float(b["months_active"]), _is_dead(b)))
    top_syms = sorted(by_sym.items(), key=lambda kv: -len(kv[1]))[:6]
    for sym, de in top_syms:
        if len(de) >= 5:
            curves[f"sym_{sym}"] = {
                "label": f"Símbolo {sym}",
                "n": len(de),
                "n_dead": sum(1 for _, e in de if e),
                "curve": kaplan_meier(de),
                "symbol": sym,
            }

    bot_to_bucket = {}
    for b in bots:
        bk = _bucket_for_score(b.get("promotion_score"))
        if bk:
            bot_to_bucket[f"{b['vps']}-{b['account_login']}-{b['magic']}"] = bk

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "n_bots": len(bots),
        "n_dead": sum(1 for _, e in all_de if e),
        "horizon_months": SURVIVAL_HORIZON_MONTHS,
        "death_definition": (
            "Cualquiera de: decay_flag, drift severidad ≥ 1.3, "
            "net_profit ≤ 0 con ≥ 3 meses, o DD > 20% del balance"
        ),
        "curves": curves,
        "buckets": [b["id"] for b in SURVIVAL_BUCKETS],
        "bot_to_bucket": bot_to_bucket,
    }


# --- Main ----------------------------------------------------------------

def _parse_iso_safe(s):
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except Exception:
        return None


# --- Real daily performance (panel "¿Quién ganó HOY?" + consistencia) -------
# Computed ONLY for bots running on real accounts. Pure function of the per-bot
# trade list (close_time epoch s) + daily_equity_series; informational for the
# dashboard — never touches promotion scoring/gating.

def compute_real_daily(trades, daily_series):
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()
    yesterday = (now - timedelta(days=1)).date().isoformat()
    week_cut = (now - timedelta(days=7)).date().isoformat()

    def day_of(t):
        c = t.get("close_time")
        return datetime.fromtimestamp(c, tz=timezone.utc).date().isoformat() if c else None

    t_today = [t for t in trades if day_of(t) == today]
    t_yest = [t for t in trades if day_of(t) == yesterday]
    net = lambda ts: round(sum(t.get("net", t.get("profit", 0.0)) or 0.0 for t in ts), 2)

    # Rolling stats over ACTIVE days (daily_equity_series only has days with trades).
    cut30 = (now - timedelta(days=30)).date().isoformat()
    cut7 = week_cut
    d30 = [d for d in daily_series if d.get("date", "") >= cut30]
    d7 = [d for d in d30 if d.get("date", "") >= cut7]
    pos30 = sum(1 for d in d30 if (d.get("daily_net") or 0) > 0)
    pos7 = sum(1 for d in d7 if (d.get("daily_net") or 0) > 0)
    nets30 = [d.get("daily_net") or 0.0 for d in d30]
    exp30 = round(sum(nets30) / len(nets30), 2) if nets30 else None
    sd30 = round(stdev(nets30), 2) if len(nets30) >= 2 else None

    # Streak: consecutive positive ACTIVE days counting back from the last one.
    streak = 0
    for d in reversed(daily_series):
        if (d.get("daily_net") or 0) > 0:
            streak += 1
        else:
            break

    pos_rate30 = round(pos30 / len(d30), 3) if d30 else None
    if pos_rate30 is not None and len(d30) >= 8 and pos_rate30 >= 0.6:
        badge = "constante"
    elif streak >= 3:
        badge = "racha"
    elif pos_rate30 is not None and len(d30) >= 5 and pos_rate30 < 0.45:
        badge = "volatil"
    else:
        badge = "neutro"

    week_net = net([t for t in trades if (day_of(t) or "") >= week_cut])

    # Out-of-form alert (C4): losing week with mostly red active days.
    out_of_form = bool(d7) and len(d7) >= 3 and week_net < 0 and pos7 / len(d7) <= 0.4
    form_reason = None
    if out_of_form:
        form_reason = f"semana {week_net:+.2f} USD con {pos7}/{len(d7)} días verdes"

    return {
        "today_net": net(t_today),
        "today_trades": len(t_today),
        "today_wins": sum(1 for t in t_today if (t.get("net", t.get("profit", 0)) or 0) > 0),
        "yesterday_net": net(t_yest),
        "yesterday_trades": len(t_yest),
        "week_net": week_net,
        "active_days_30": len(d30),
        "pos_days_30": pos30,
        "pos_rate_30": pos_rate30,
        "pos_days_7": pos7,
        "active_days_7": len(d7),
        "expectancy_daily_30": exp30,
        "stdev_daily_30": sd30,
        "streak_days": streak,
        "badge": badge,
        "out_of_form": out_of_form,
        "form_reason": form_reason,
        "series_90d": [[d.get("date"), round(d.get("daily_net") or 0.0, 2)]
                       for d in daily_series
                       if d.get("date", "") >= (now - timedelta(days=90)).date().isoformat()],
    }


# --- Floating-DD shadow (Fase B, tribunal 2026-06-09) -----------------------
# SHADOW ONLY: records would_fail flags and never touches promotion_status.
# The flip to enforcement is a MANUAL owner decision gated on triple evidence
# (coverage >=90% + >=30 clean days + verify_integrity green) — never a timer.
# Percentages arrive PRE-COMPUTED from each VPS sampler against the DECLARED
# initial balance (initial_balances.json on the VPS) — the fixed denominator;
# post_merge never re-derives them from the live account_balance.
FLOATING_DD_SHADOW_THRESHOLD_PCT = 20.0   # provisional: closed-DD 15% + 5pp headroom, no empirical derivation yet
FLOATING_DD_MIN_COVERAGE_PCT = 90.0


def apply_floating_dd_shadow(snap, data_dir):
    """Consume data/sampler/<vps>/floating_dd_summary.json (mirrored, fail-soft)
    and decorate bots[] + accounts[] with sampled floating-DD shadow fields.
    The metric is a LOWER BOUND (60-120s sampling misses sub-cadence spikes)."""
    sampler_root = os.path.join(data_dir, "sampler")
    if not os.path.isdir(sampler_root):
        return None

    summaries = {}
    statuses = {}
    for vps in sorted(os.listdir(sampler_root)):
        sdir = os.path.join(sampler_root, vps)
        for name, store in (("floating_dd_summary.json", summaries), ("sampler_status.json", statuses)):
            p = os.path.join(sdir, name)
            if os.path.isfile(p):
                try:
                    with open(p) as f:
                        store[vps] = json.load(f)
                except Exception as exc:
                    print(f"[floating-dd-shadow] WARN: unreadable {vps}/{name}: {exc}")
    if not summaries:
        return None

    def _agg(days_map, cadence_secs):
        """Coverage metrológico (tribunal post-impl): span CALENDARIO (no nº de
        días con datos — eso oculta huecos), y clamp por-día al máximo esperado
        ANTES de sumar (multi-driver duplicado no puede inflar coverage)."""
        days = sorted(days_map)
        expected_per_day = 86400.0 / max(cadence_secs, 1.0)
        samples = sum(int(d.get("samples", 0)) for d in days_map.values())
        clamped = sum(min(int(d.get("samples", 0)), expected_per_day) for d in days_map.values())
        try:
            d0 = datetime.strptime(days[0], "%Y-%m-%d")
            d1 = datetime.strptime(days[-1], "%Y-%m-%d")
            span_days = (d1 - d0).days + 1
        except Exception:
            span_days = len(days)
        coverage_pct = round(min(100.0, clamped / (span_days * expected_per_day) * 100.0), 1) if span_days else 0.0
        return days, samples, span_days, coverage_pct

    bots_covered = 0
    accounts_covered = 0
    would_fail = 0
    now_utc = datetime.now(timezone.utc)
    for vps, summary in summaries.items():
        st = statuses.get(vps) or {}
        cadence = float(st.get("cadence_secs") or 120.0)
        # Staleness gate (tribunal post-impl): a dead sampler must read as
        # insufficient data, never as a silently-frozen "healthy" metric.
        last_ts = _parse_iso_safe(st.get("last_sample_ts"))
        vps_stale = (last_ts is None) or ((now_utc - last_ts).total_seconds() > 6 * 3600)
        if vps_stale:
            print(f"[floating-dd-shadow] WARN: {vps} sampler stale (last={st.get('last_sample_ts')}) — flagged insufficient")
        bot_days = summary.get("bots", {})
        acc_days = summary.get("accounts", {})

        for b in snap.get("bots", []):
            if b.get("vps") != vps:
                continue
            key = f"{b.get('account_login')}-{b.get('magic')}"
            days_map = bot_days.get(key)
            if not days_map:
                continue
            days, samples, span_days, coverage_pct = _agg(days_map, cadence)
            worst = max(float(d.get("worst_floating_dd_pct", 0.0)) for d in days_map.values())
            # Precondición tribunal: span>=7d calendario Y >=5 días con datos Y
            # sampler vivo — sin eso la métrica no es elegible ni para shadow-fail.
            sufficient = (coverage_pct >= FLOATING_DD_MIN_COVERAGE_PCT
                          and span_days >= 7 and len(days) >= 5 and not vps_stale)
            fail = (worst > FLOATING_DD_SHADOW_THRESHOLD_PCT) if sufficient else None
            b["floating_dd"] = {
                "stale": vps_stale,
                "max_floating_dd_pct_sampled": round(worst, 3),
                "time_underwater_min_total": round(sum(float(d.get("time_underwater_min", 0.0))
                                                       for d in days_map.values()), 1),
                "coverage_days": span_days,
                "first_day": days[0],
                "last_day": days[-1],
                "samples": samples,
                "coverage_pct": coverage_pct,
                "cadence_secs": cadence,
                "enforced": False,
                "insufficient_coverage": not sufficient,
                "note": "lower bound — sampled, not continuous",
            }
            b["would_fail_floating_dd"] = fail
            bots_covered += 1
            if fail:
                would_fail += 1

        for a in snap.get("accounts", []):
            if a.get("vps") != vps:
                continue
            days_map = acc_days.get(str(a.get("login")))
            if not days_map:
                continue
            days, samples, span_days, coverage_pct = _agg(days_map, cadence)
            a["floating_dd"] = {
                "worst_simultaneous_floating_dd_pct": round(max(
                    float(d.get("worst_floating_dd_pct", 0.0)) for d in days_map.values()), 3),
                "max_floating_deficit": round(max(
                    float(d.get("max_floating_deficit", 0.0)) for d in days_map.values()), 2),
                "min_equity": min(float(d.get("min_equity")) for d in days_map.values()
                                  if d.get("min_equity") is not None),
                "coverage_days": span_days,
                "samples": samples,
                "coverage_pct": coverage_pct,
            }
            accounts_covered += 1

    meta = {
        "shadow": True,
        "threshold_pct": FLOATING_DD_SHADOW_THRESHOLD_PCT,
        "threshold_provenance": "closed-DD 15% + 5pp headroom — provisional, no empirical derivation vs real ruin tolerance",
        "min_coverage_pct": FLOATING_DD_MIN_COVERAGE_PCT,
        "vps_with_sampler": sorted(summaries),
        "bots_covered": bots_covered,
        "accounts_covered": accounts_covered,
        "would_fail_floating_dd_count": would_fail,
        "unit_of_failure_note": "MT5 stop-out is per ACCOUNT — account-level series is the gating-relevant one",
    }
    snap["floating_dd_meta"] = meta
    return meta


def compute_vps_freshness(data_dir, vps_ids=None):
    """For each snapshot_vpsN.json present, compute lag from now() vs its
    generated_at. Returns ({vps_id: {lag_sec, stale, generated_at}}, partial)."""
    if vps_ids is None:
        vps_ids = ["vps1", "vps2", "vps3", "vps4", "vps5", "vps6"]
    now = datetime.now(timezone.utc)
    out = {}
    partial = False
    for v in vps_ids:
        p = os.path.join(data_dir, f"snapshot_{v}.json")
        if not os.path.exists(p):
            out[v] = {"present": False}
            partial = True
            continue
        try:
            with open(p) as f:
                snap = json.load(f)
            gen_t = _parse_iso_safe(snap.get("generated_at"))
            if not gen_t:
                # Fallback: file mtime
                gen_t = datetime.fromtimestamp(os.path.getmtime(p), tz=timezone.utc)
            lag = (now - gen_t).total_seconds()
            # > 90 min behind = stale (3 missed cycles). lag < -5 min = clock skew /
            # future-dated snapshot: treat as stale too, else a forward clock would
            # present rancid-but-future data as fresh and slip past the freshness gate.
            # `stale` stays AGE-based (drives the watchdog Issue — no noise on a brief
            # carry). `carried_forward` is a SEPARATE flag (this VPS was served from
            # last-good data this cycle): its curves are FROZEN, so the promotion guard
            # excludes it from READY/NEAR regardless of age — but a 1-cycle carry is
            # NOT alarmed, only surfaced as partial_data (yellow banner).
            carried = bool(snap.get("carried_forward"))
            stale = lag > 90 * 60 or lag < -300
            out[v] = {
                "present": True,
                "generated_at": gen_t.isoformat(timespec="seconds"),
                "lag_sec": int(lag),
                "stale": stale,
                "carried_forward": carried,
                "bot_count": len([b for b in snap.get("bots", []) if b.get("magic")]),
            }
            if stale or carried:
                partial = True
        except Exception as e:
            # Corrupt/unreadable VPS snapshot: mark stale+corrupt so the freshness
            # gate (verify_integrity.check_freshness) hard-fails for real accounts
            # on this VPS instead of silently passing (present=True, stale absent).
            out[v] = {"present": True, "error": str(e), "stale": True, "corrupt": True}
            partial = True
    return out, partial


def aggregate_health_metrics(data_dir):
    """Read heartbeat_log.jsonl + integrity_health_log.jsonl tails to compute
    uptime_pct_30d, mean_lag_sec_7d, recovery_count_7d. Defensive — returns
    empty dict if no logs."""
    metrics = {}
    now = datetime.now(timezone.utc)
    hb_path = os.path.join(data_dir, "heartbeat_log.jsonl")
    if os.path.exists(hb_path):
        ok = warn = fail = 0
        lags_7d = []
        cutoff_30 = now.timestamp() - 30 * 86400
        cutoff_7 = now.timestamp() - 7 * 86400
        try:
            with open(hb_path) as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    t = _parse_iso_safe(r.get("ts"))
                    if not t or t.timestamp() < cutoff_30:
                        continue
                    res = r.get("result")
                    if res == "ok":
                        ok += 1
                    elif res == "warn":
                        warn += 1
                    elif res == "fail":
                        fail += 1
                    if t.timestamp() >= cutoff_7 and isinstance(r.get("lag_sec"), (int, float)):
                        lags_7d.append(r["lag_sec"])
            total = ok + warn + fail
            if total:
                metrics["uptime_pct_30d"] = round(100.0 * ok / total, 2)
                metrics["heartbeat_samples_30d"] = total
            if lags_7d:
                metrics["mean_lag_sec_7d"] = round(sum(lags_7d) / len(lags_7d), 1)
                metrics["max_lag_sec_7d"] = round(max(lags_7d), 1)
        except Exception:
            pass
    dr_path = os.path.join(data_dir, "dispatch_refresh_log.jsonl")
    if os.path.exists(dr_path):
        rec = 0
        cutoff_7 = now.timestamp() - 7 * 86400
        try:
            with open(dr_path) as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    t = _parse_iso_safe(r.get("ts"))
                    if not t or t.timestamp() < cutoff_7:
                        continue
                    if any(a.get("post_lag_min") is not None and a["post_lag_min"] <= 35
                           for a in r.get("attempts", [])):
                        rec += 1
            metrics["recovery_count_7d"] = rec
        except Exception:
            pass
    return metrics


def write_sync_status_md(data_dir, snap, vps_freshness, health_metrics, partial_data):
    """Auto-generated operations dashboard — overwritten each cycle."""
    md_path = os.path.join(data_dir, "..", "SYNC_STATUS.md")
    md_path = os.path.normpath(md_path)
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    bots = [b for b in snap.get("bots", []) if b.get("magic")]
    accounts = snap.get("accounts", [])

    lines = []
    lines.append("# SYNC_STATUS — Battle of Bots")
    lines.append("")
    lines.append("> Auto-generated by `post_merge.py` after each successful cycle. Do not edit by hand.")
    lines.append("")
    lines.append(f"**Last cycle:** `{now_iso}`")
    lines.append(f"**Snapshot generated_at:** `{snap.get('generated_at','?')}`")
    lines.append(f"**Bots indexed:** {len(bots)}")
    lines.append(f"**Accounts indexed:** {len(accounts)}")
    lines.append(f"**Partial data:** {'⚠️ YES — see VPS table' if partial_data else 'no'}")
    lines.append("")
    lines.append("## VPS freshness")
    lines.append("")
    lines.append("| VPS | present | generated_at | lag (min) | bots | stale |")
    lines.append("|-----|---------|--------------|----------:|-----:|:-----:|")
    for v in sorted(vps_freshness.keys()):
        d = vps_freshness[v]
        if not d.get("present"):
            lines.append(f"| {v} | ❌ no | — | — | — | — |")
            continue
        if "error" in d:
            lines.append(f"| {v} | ⚠️ err | — | — | — | — |")
            continue
        lag_min = round(d["lag_sec"] / 60, 1)
        st = "🛑" if d.get("stale") else "✅"
        lines.append(f"| {v} | ✅ | `{d['generated_at']}` | {lag_min} | {d.get('bot_count', 0)} | {st} |")
    lines.append("")
    lines.append("## Health metrics")
    lines.append("")
    if health_metrics:
        for k, v in health_metrics.items():
            lines.append(f"- **{k}**: {v}")
    else:
        lines.append("_no heartbeat history yet — will populate after first 24h_")
    lines.append("")
    lines.append("## Troubleshooting commands")
    lines.append("")
    lines.append("```bash")
    lines.append("# Latest GH Actions runs")
    lines.append("gh run list --repo yody38/KizCapital-Battle-of-Bots --limit 10")
    lines.append("")
    lines.append("# Manual heartbeat check")
    lines.append("python3 'Battle of Bots/scripts/heartbeat_check.py' --no-email")
    lines.append("")
    lines.append("# Manual integrity verification")
    lines.append("python3 'Battle of Bots/scripts/integrity_watchdog.py' --no-issue")
    lines.append("")
    lines.append("# Manual dispatch (recovers stuck pipeline)")
    lines.append("python3 'Battle of Bots/scripts/dispatch_refresh.py' --reason manual")
    lines.append("")
    lines.append("# Tail heartbeat log")
    lines.append("tail -20 'Battle of Bots/data/heartbeat_log.jsonl'")
    lines.append("```")
    lines.append("")
    lines.append("## Links")
    lines.append("")
    lines.append("- Dashboard: https://kiz-capital-bots-kiz-capital-battle-of-bots-projects.vercel.app/")
    lines.append("- GH Actions: https://github.com/yody38/KizCapital-Battle-of-Bots/actions")
    lines.append("- Billing:    https://github.com/settings/billing")
    lines.append("")

    tmp = md_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    os.replace(tmp, md_path)
    return md_path


# --- Ultra Tribunal sync — veredicto ↔ Candidatos a Cuenta Real -------------
# 5 features (2026-07-13): ingesta del veredicto, doble firma READY∧podio,
# vigencia/obsolescencia, gate de dominancia continuo, tenure/racha de podio.
# TODO visual-only: jamás muta promotion_status ni el orden de asientos.

_VERDICT_FILE_RE = re.compile(r"^verdict_(\d{8})\S*\.json$")
_PODIUM_ID_RE = re.compile(r"[\w.\-]+:\d+:\d+")


def _load_tribunal_verdicts():
    """Todos los verdict_*.json de tribunal/data/ → [(run_date, dict)] asc por fecha.
    Dedupe por run_date prefiriendo el esquema rico (podium de dicts)."""
    d = os.path.abspath(TRIBUNAL_DATA_DIR)
    if not os.path.isdir(d):
        return []
    by_date = {}
    for name in sorted(os.listdir(d)):
        m = _VERDICT_FILE_RE.match(name)
        if not m:
            continue
        try:
            with open(os.path.join(d, name)) as f:
                v = json.load(f)
        except (json.JSONDecodeError, OSError) as exc:
            print(f"[tribunal] verdict ilegible {name}: {exc}", file=sys.stderr)
            continue
        date8 = m.group(1)
        run_date = str(v.get("run_date") or f"{date8[:4]}-{date8[4:6]}-{date8[6:]}")[:10]
        pod = _podium_entries(v)
        if not pod:
            print(f"[tribunal] {name}: sin podio parseable — omitido", file=sys.stderr)
            continue
        rich = any(e[3] for e in pod)
        cur = by_date.get(run_date)
        if cur is None or (rich and not cur[1]):
            by_date[run_date] = (v, rich)
    return [(rd, v) for rd, (v, _r) in sorted(by_date.items())]


def _podium_entries(v):
    """Podio normalizado → [(id, rank, comp, entry_dict|None)] tolerando esquemas viejos
    (incluida la variante 'con lote' que usa la clave podio_READY)."""
    out = []
    for i, p in enumerate(v.get("podium") or v.get("podio_READY") or []):
        if isinstance(p, dict) and p.get("id"):
            out.append((p["id"], p.get("rank") or i + 1, p.get("comp"), p))
        elif isinstance(p, str):
            m = _PODIUM_ID_RE.search(p)
            if m:
                out.append((m.group(0), i + 1, None, None))
    return out


def _suplente_entries(v):
    out = []
    for s in v.get("suplentes") or []:
        if isinstance(s, dict) and s.get("id"):
            out.append((s["id"], s.get("comp"), s.get("note")))
        elif isinstance(s, str):
            m = _PODIUM_ID_RE.search(s)
            if m:
                out.append((m.group(0), None, s))
    return out


def _tribunal_stale_reasons(b, entry):
    """Cambio material post-veredicto: la data del bot ya no respalda lo juzgado."""
    reasons = []
    vdd, bdd = entry.get("dd_pct"), b.get("dd_pct_of_balance")
    if vdd is not None and bdd is not None and (bdd - vdd) > TRIBUNAL_STALE_DD_PTS:
        reasons.append(f"DD% empeoró {vdd}→{bdd}")
    vpf, bpf = entry.get("pf"), b.get("profit_factor")
    if vpf is not None and bpf is not None and (vpf - bpf) > TRIBUNAL_STALE_PF_DROP:
        reasons.append(f"PF cayó {vpf}→{round(bpf, 2)}")
    if b.get("dormant"):
        reasons.append("dormant (sin trades recientes)")
    if b.get("decay_flag") and str(entry.get("decay", "no")).lower() in ("no", "false"):
        reasons.append("decay flag nuevo")
    if entry.get("status") == "READY" and b.get("promotion_status") != "READY":
        reasons.append(f"cayó de READY→{b.get('promotion_status')}")
    return reasons


def _ready_streak_days(data_dir, snap):
    """Racha de días consecutivos en READY según el ledger append-only
    candidates_history.jsonl (ya persistido cross-ciclo vía fetch_ledger)."""
    path = os.path.join(data_dir, "candidates_history.jsonl")
    rows_by_key = {}
    if os.path.exists(path):
        with open(path) as f:
            for raw in f:
                line = raw.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue  # ya contado/gateado por tracker_health
                k = (row.get("vps"), row.get("login"), row.get("magic"))
                rows_by_key.setdefault(k, []).append(row)
    decorated = 0
    for b in snap.get("bots", []):
        if b.get("promotion_status") != "READY":
            continue
        rows = rows_by_key.get((b.get("vps"), b.get("account_login"), b.get("magic")), [])
        streak = 0
        for row in reversed(rows):
            if row.get("status") == "READY":
                streak += 1
            else:
                break
        b["ready_streak_days"] = streak
        decorated += 1
    return decorated


def _continuous_dominance_gate(snap, now, real_logins, real_magics):
    """Gate de dominancia del tribunal (gate_lib, 12 ejes) aplicado al top-3 READY
    vigente en CADA ciclo CI — mini-tribunal continuo entre veredictos semanales."""
    if _gate_lib is None:
        return {"verdict": None, "error": "gate_lib no disponible"}
    ready_ids = [f"{b.get('vps')}:{b.get('account_login')}:{b.get('magic')}"
                 for b in snap.get("bots", []) if b.get("promotion_status") == "READY"]
    if len(ready_ids) != 3:
        return {"verdict": None, "error": f"READY={len(ready_ids)} (se requieren 3)"}
    # Cohorte viva demo — misma definición que build_expediente.py Fase 0.
    rows = []
    for b in snap.get("bots", []):
        if b.get("is_real") or b.get("magic") in real_magics \
                or b.get("account_login") in real_logins or not b.get("magic"):
            continue
        if (b.get("trades") or 0) < _gate_lib.COHORT_MIN_TRADES:
            continue
        dsl = _days_since_last_trade(b, now)
        if dsl is None or dsl > _gate_lib.COHORT_ALIVE_DAYS:
            continue
        row = {"id": f"{b.get('vps')}:{b.get('account_login')}:{b.get('magic')}",
               "trades": b.get("trades")}
        for axis, _hb in _gate_lib.CORE_AXES_DIRECTION:
            row[axis] = b.get(axis)
        rows.append(row)
    _gate_lib.percentile_ranks(rows, _gate_lib.CORE_AXES_DIRECTION)
    for r in rows:
        r["core_composite"] = _gate_lib.core_composite(r)
    scan = _gate_lib.dominance_scan(rows, ready_ids)
    scan["cohort_n"] = len(rows)
    return scan


def apply_tribunal(snap, data_dir, now, real_logins, real_magics):
    """Ingesta el último veredicto del Ultra Tribunal + histórico y decora el
    snapshot. Fail-open: sin veredictos → tribunal_meta ausente, sección intacta."""
    for b in snap.get("bots", []):
        b.pop("tribunal", None)  # nunca heredar decoración de un snapshot previo
    verdicts = _load_tribunal_verdicts()
    streak_decorated = _ready_streak_days(data_dir, snap)
    if not verdicts:
        return None

    run_date, v = verdicts[-1]
    bots_by_id = {}
    for b in snap.get("bots", []):
        if b.get("magic"):
            bots_by_id.setdefault(
                f"{b.get('vps')}:{b.get('account_login')}:{b.get('magic')}", b)

    try:
        age_days = (now.date() - datetime.fromisoformat(run_date).date()).days
    except ValueError:
        age_days = None
    if age_days is None:
        verdict_state = "desconocido"
    elif age_days <= TRIBUNAL_FRESH_DAYS:
        verdict_state = "vigente"
    elif age_days <= TRIBUNAL_EXPIRED_DAYS:
        verdict_state = "viejo"
    else:
        verdict_state = "expirado"

    dissents_all = v.get("registered_dissents_and_risks") or []
    gate = (v.get("gate") or {}).get("deterministic")
    validator = (v.get("adversarial_validator") or {}).get("verdict_holds")

    podium = _podium_entries(v)
    podium_meta = []
    for pid, rank, comp, entry in podium:
        b = bots_by_id.get(pid)
        magic_str = pid.split(":")[-1]
        dissents = [s for s in dissents_all if magic_str in s or f"#{rank}" in s]
        stale = _tribunal_stale_reasons(b, entry) if (b is not None and entry) else []
        if b is not None:
            b["tribunal"] = {
                "rank": rank, "comp": comp, "run_date": run_date,
                "is_suplente": False, "note": None,
                "dissents": dissents, "stale_reasons": stale,
                "gate": gate, "validator_holds": validator,
            }
        podium_meta.append({
            "id": pid, "rank": rank, "comp": comp,
            "sym": (entry or {}).get("sym"),
            "in_snapshot": b is not None,
            "current_status": b.get("promotion_status") if b is not None else "AUSENTE",
            "stale_reasons": stale,
        })

    suplentes_meta = []
    for pid, comp, note in _suplente_entries(v):
        b = bots_by_id.get(pid)
        if b is not None and "tribunal" not in b:
            b["tribunal"] = {
                "rank": None, "comp": comp, "run_date": run_date,
                "is_suplente": True, "note": note,
                "dissents": [], "stale_reasons": [],
                "gate": gate, "validator_holds": validator,
            }
        suplentes_meta.append({"id": pid, "comp": comp, "note": note,
                               "in_snapshot": b is not None})

    # Doble firma: READY (gating cuantitativo) ∧ podio (juicio adversarial).
    podium_ids = {pid for pid, _r, _c, _e in podium}
    ready_ids = {bid for bid, b in bots_by_id.items()
                 if b.get("promotion_status") == "READY"}
    for bid, b in bots_by_id.items():
        in_pod, is_ready = bid in podium_ids, bid in ready_ids
        if in_pod or is_ready:
            b["double_signature"] = ("confirmed" if (in_pod and is_ready)
                                     else "quant_only" if is_ready else "tribunal_only")
        else:
            b.pop("double_signature", None)

    concordance = {
        "matches": len(ready_ids & podium_ids),
        "of": len(podium_ids),
        "ready_not_podium": sorted(ready_ids - podium_ids),
        "podium_not_ready": [m["id"] for m in podium_meta
                             if m["current_status"] != "READY"],
    }

    # Tenure: histórico de podios por bot a través de TODOS los veredictos.
    appearances = {}
    run_dates = [rd for rd, _v in verdicts]
    for rd, vv in verdicts:
        for pid, rank, comp, _e in _podium_entries(vv):
            appearances.setdefault(pid, []).append(
                {"run_date": rd, "rank": rank, "comp": comp})
    history_decorated = 0
    for b in snap.get("bots", []):
        b.pop("tribunal_history", None)
    for pid, ranks in appearances.items():
        b = bots_by_id.get(pid)
        if b is None:
            continue
        present = {r["run_date"] for r in ranks}
        consecutive = 0
        for rd in reversed(run_dates):
            if rd in present:
                consecutive += 1
            else:
                break
        b["tribunal_history"] = {
            "podium_appearances": len(ranks),
            "consecutive_podiums": consecutive,
            "first_podium": ranks[0]["run_date"],
            "ranks": ranks,
        }
        history_decorated += 1

    continuous_gate = _continuous_dominance_gate(snap, now, real_logins, real_magics)

    return {
        "run_date": run_date,
        "age_days": age_days,
        "verdict_state": verdict_state,
        "fresh_days": TRIBUNAL_FRESH_DAYS,
        "expired_days": TRIBUNAL_EXPIRED_DAYS,
        "universe": v.get("universe"),
        "gate": v.get("gate"),
        "validator_holds": validator,
        "block_weights": v.get("block_weights"),
        "recommendation": v.get("domain_outsider_recommendation"),
        "dissents": dissents_all,
        "podium": podium_meta,
        "suplentes": suplentes_meta,
        "concordance": concordance,
        "continuous_gate": continuous_gate,
        "history": {"n_verdicts": len(verdicts), "run_dates": run_dates,
                    "bots_with_history": history_decorated},
        "ready_streak_decorated": streak_decorated,
        "ranker_note": "visual-only: el veredicto jamás mueve asientos (shadow-first + human veto)",
    }


def main():
    if len(sys.argv) < 2:
        print("usage: post_merge.py <data_dir>", file=sys.stderr)
        sys.exit(2)
    data_dir = sys.argv[1]
    snap_path = os.path.join(data_dir, "snapshot.json")
    with open(snap_path) as f:
        snap = json.load(f)

    accounts_by_login = {a["login"]: a for a in snap.get("accounts", [])}

    # Per-VPS freshness — computed from snapshot_vpsN.json before any enrichment.
    vps_freshness, partial_data = compute_vps_freshness(data_dir)
    snap["vps_freshness"] = vps_freshness
    snap["partial_data"] = partial_data

    enriched = 0
    for b in snap.get("bots", []):
        acc = accounts_by_login.get(b.get("account_login"))
        bal = (acc or {}).get("balance", 0)
        result = compute_score(b, bal)
        b["promotion_score"] = result["score"]
        b["promotion_status"] = result["status"]
        b["promotion_components"] = result["components"]
        b["promotion_gating"] = result["gating"]
        b["promotion_fails"] = result["fails"]
        b["dd_pct_of_balance"] = result["dd_pct_of_balance"]
        enriched += 1

    # Stress, OOS, Regime, Drift, Capacity — pulled from per-bot JSON (have full trade list + daily series)
    stress_count = 0
    oos_count = 0
    regime_count = 0
    drift_count = 0
    drift_flagged = 0
    capacity_count = 0
    institutional_count = 0
    tail_ratio_warn = 0
    autocorr_warn = 0
    underwater_count = 0
    ci_count = 0
    event_count = 0
    battle_tested_count = 0
    trade_dist_count = 0
    real_daily_count = 0
    real_accounts = detect_real_accounts(snap)
    real_logins_p2 = {login for (_v, login) in real_accounts}
    real_magics = detect_real_magics(snap)
    # Single source of truth: the frontend consumes this instead of recomputing in
    # parallel, so FE and BE can never disagree on which magics are already in real.
    snap["real_magics"] = sorted(real_magics)
    real_bot_count = 0
    # Pass 1: real_vs_demo runs for EVERY bot in a real account, regardless of
    # whether per-bot file exists (some VPS may not yet emit per-bot history
    # for newly-funded real accounts — we still need to flag them as real).
    for b in snap.get("bots", []):
        if not b.get("magic"):
            continue
        div = compute_real_vs_demo_divergence(b, real_accounts)
        if div is not None:
            b["real_vs_demo"] = div
            real_bot_count += 1

    # Pass 2: enrichments that REQUIRE the per-bot trade list / daily series.
    for b in snap.get("bots", []):
        per = load_per_bot(data_dir, b.get("vps"), b.get("account_login"), b.get("magic"))
        if not per:
            continue
        trades = per.get("trades") or []
        daily_series = per.get("daily_equity_series") or []
        acc = accounts_by_login.get(b.get("account_login"))
        bal = (acc or {}).get("balance", 0)

        mc = monte_carlo_stress(trades, bal, b.get("max_drawdown"))
        if mc is not None:
            b["stress"] = mc
            stress_count += 1

        oos = walk_forward(trades)
        if oos is not None:
            b["oos"] = oos
            oos_count += 1

        reg = regime_analysis(trades)
        if reg is not None:
            b["regime"] = reg
            regime_count += 1

        drift = page_hinkley_drift(daily_series)
        if drift is not None:
            b["drift"] = drift
            drift_count += 1
            if drift.get("flag"):
                drift_flagged += 1

        cap = compute_capacity(b, trades)
        if cap is not None:
            b["capacity"] = cap
            capacity_count += 1

        # Commission-honest net for the real-money promotion decision: snapshot
        # net_profit EXCLUDES commission (profit+swap); per-bot 'net' INCLUDES it.
        # The candidate ranker/gate uses this so a bot only profitable pre-commission
        # cannot rank or gate as promotable.
        b["net_after_commission"] = round(sum(t.get("net", 0.0) for t in trades), 2)

        # Recent cadence (owner profile "opera constantemente"): closed-trade counts in
        # the last 30/90 days from close_time (epoch s). Feeds norm_cadence in the re-score.
        _now_ts = datetime.now(timezone.utc).timestamp()
        _cts = [t.get("close_time") for t in trades if t.get("close_time")]
        b["trades_30d"] = sum(1 for c in _cts if (_now_ts - c) <= 30 * 86400)
        b["trades_90d"] = sum(1 for c in _cts if (_now_ts - c) <= 90 * 86400)

        inst = institutional_metrics(daily_series, trades, bal)
        # Solo guardar si al menos una métrica se calculó
        if any(inst.get(k) is not None for k in
               ("cvar_95_pct", "ulcer_index_pct", "k_ratio", "sqn", "tail_ratio", "return_autocorr_lag1")):
            b["institutional"] = inst
            institutional_count += 1
            if inst.get("tail_ratio") is not None and inst["tail_ratio"] < 0.7:
                tail_ratio_warn += 1
            if inst.get("return_autocorr_lag1") is not None and inst["return_autocorr_lag1"] > 0.3:
                autocorr_warn += 1

        uw = underwater_analysis(daily_series, bal)
        if uw is not None:
            b["underwater"] = uw
            underwater_count += 1

        ci = confidence_intervals(daily_series, trades)
        if ci is not None:
            b["confidence_intervals"] = ci
            ci_count += 1

        ev = event_stress(daily_series, trades)
        if ev is not None:
            b["event_stress"] = ev
            event_count += 1
            if ev.get("battle_tested"):
                battle_tested_count += 1

        td = compute_trade_distribution_stats(trades)
        if td is not None:
            b["trade_distribution"] = td
            trade_dist_count += 1

        # Daily performance for bots on REAL accounts (panel "¿Quién ganó HOY?",
        # consistencia diaria, heatmap calendario). Informational only.
        if b.get("account_login") in real_logins_p2:
            b["real_daily"] = compute_real_daily(trades, daily_series)
            real_daily_count += 1

    # 5b) Re-score with the MONEY + QUALITY factors. compute_score ran before the
    # per-bot enrichments existed (net_after_commission, oos, stress, institutional,
    # confidence_intervals → placeholders 0.0). Now that Pass 2 has filled them,
    # recompute promotion_score = Σ(components·WEIGHTS) with the real values. These are
    # SCORE factors, never gates → the section ALWAYS seats the 3 best (never empties).
    # Stateless: pure function of THIS snapshot, so dynamism is fully preserved.
    for b in snap.get("bots", []):
        comp = b.get("promotion_components")
        if not comp:
            continue
        acc = accounts_by_login.get(b.get("account_login"))
        bal = (acc or {}).get("balance", 0)
        comp["net_return"] = round(
            norm_net_return(b.get("net_after_commission"), bal, b.get("months_active")), 3)
        comp["cadence"] = round(norm_cadence(b), 3)  # now that trades_90d exists (Pass 2)
        comp["oos_robustness"] = round(norm_oos(b.get("oos")), 3)
        comp["safety"] = round(norm_safety(b.get("stress")), 3)
        comp["tail_quality"] = round(norm_tail(b.get("institutional")), 3)
        comp["significance"] = round(norm_significance(b.get("oos"), b.get("confidence_intervals")), 3)
        raw = sum(comp.get(k, 0.0) * w for k, w in WEIGHTS.items())
        b["promotion_score"] = round(raw * 100, 1)

    # 6) Bayesian shrinkage of promotion_score (must run AFTER initial scoring,
    # BEFORE forward tracker / portfolio so they consume the shrunk values).
    shrinkage_meta = compute_shrunk_scores(snap)

    # 6b) Rank-based status over the DEMO-ONLY, deduped-by-magic candidate pool.
    #   · Exclude EAs already on a real account (real_magics/real_logins): this
    #     section surfaces demo-only EAs not yet promoted to real.
    #   · Commission-honest net: snapshot net_profit excludes commission — use
    #     net_after_commission for the net>0 gate AND the rank tiebreak.
    #   · Dedup by magic: one EA = one slot (best instance) — no duplicate edge.
    #   · Caps 3/5/15 (preservation). A cap stays under-filled if there aren't
    #     enough healthy unique EAs — that is signal, not a bug.
    real_logins = {login for (_v, login) in real_accounts}

    def _tag(b):
        return f"{b.get('magic')}@{b.get('vps')}/{b.get('account_login')}"

    pool_pre_commission = [b for b in snap.get("bots", [])
                           if all((b.get("promotion_gating") or {}).values())
                           and b.get("promotion_score") is not None
                           and b.get("magic")
                           and b.get("magic") not in real_magics
                           and b.get("account_login") not in real_logins]
    # FAIL-CLOSED commission: a bot whose net_after_commission could NOT be computed
    # (per-bot file missing) is EXCLUDED — never fall back to the commission-EXCLUDED
    # snapshot net_profit for a real-money decision. Surfaced + gated by verify_integrity.
    commission_unknown = [_tag(b) for b in pool_pre_commission if b.get("net_after_commission") is None]
    with_net = [b for b in pool_pre_commission if b.get("net_after_commission") is not None]
    elig_all = [b for b in with_net if b["net_after_commission"] > 0]
    commission_filter_dropped = [_tag(b) for b in with_net if b["net_after_commission"] <= 0]
    # Deterministic ordering (no float-tie ambiguity): score desc, commission-honest
    # net desc, trades desc, then vps asc, login asc.
    # CONFIDENCE-ADJUSTED ordering (owner decision 2026-07-01): rank by the SHRUNK score,
    # so a small-sample fluke can never outrank a proven bot. Deterministic tiebreaks.
    def _shrunk(b):
        v = b.get("promotion_score_shrunk")
        return v if v is not None else (b.get("promotion_score") or 0)
    elig_all.sort(key=lambda b: (
        -_shrunk(b),
        -(b.get("net_after_commission") or 0),
        -(b.get("trades") or 0),
        str(b.get("vps") or ""),
        b.get("account_login") or 0,
    ))

    # Dedup by magic — first (best) instance wins; the rest are recorded.
    eligible, seen_magic, dedup_dropped = [], set(), []
    for b in elig_all:
        m = b.get("magic")
        if m in seen_magic:
            dedup_dropped.append(f"{m}@{b.get('vps')}/{b.get('account_login')}")
            continue
        seen_magic.add(m)
        eligible.append(b)

    cap_ready = STATUS_RANK_CAPS["READY"]
    cap_near = STATUS_RANK_CAPS["NEAR"]
    cap_watch = STATUS_RANK_CAPS["WATCH"]

    now = datetime.now(timezone.utc)

    # Preload daily-return series of the bots ALREADY in real: a candidate that just
    # clones the deployed real portfolio adds no diversification (HARD corr gate now).
    real_series = []
    for rb in snap.get("bots", []):
        if rb.get("account_login") in real_logins and rb.get("magic"):
            per = load_per_bot(data_dir, rb.get("vps"), rb.get("account_login"), rb.get("magic"))
            s = (per or {}).get("daily_equity_series") or []
            dmap = {r.get("date"): r.get("daily_net") for r in s
                    if r.get("date") is not None and r.get("daily_net") is not None}
            if len(dmap) >= MIN_CORR_TRADES:
                real_series.append(dmap)

    def _corr_vs_real(cand):
        if not real_series:
            return None
        per = load_per_bot(data_dir, cand.get("vps"), cand.get("account_login"), cand.get("magic"))
        s = (per or {}).get("daily_equity_series") or []
        cmap = {r.get("date"): r.get("daily_net") for r in s
                if r.get("date") is not None and r.get("daily_net") is not None}
        best = None
        for rmap in real_series:
            common = [d for d in cmap if d in rmap]
            if len(common) < MIN_CORR_TRADES:
                continue
            rho = pearson([cmap[d] for d in common], [rmap[d] for d in common])
            if rho is not None and (best is None or rho > best):
                best = rho
        return round(best, 3) if best is not None else None

    # Trust classification: HARD fails can NEVER hold a READY/NEAR seat; SOFT fails can
    # only backfill (flagged provisional). See TRUST config. Returns (hard_ok, soft_ok, reasons).
    def _seat_block(b):
        hard, soft = [], []
        dsl = b.get("days_since_last_trade")
        if dsl is not None and dsl > TRUST["max_dormant_days"]:
            hard.append("dormant")
        cmax = b.get("corr_max_vs_real")
        if cmax is not None and cmax > TRUST["max_corr_vs_real"]:
            hard.append("clones_real")
        band = (b.get("institutional") or {}).get("sqn_band")
        if TRUST["enforce_sqn_malo"] and band == "MALO":
            hard.append("sqn_malo")
        if _shrunk(b) < TRUST["min_shrunk"]:
            soft.append("shrunk<min")
        sm = b.get("shrinkage_meta") or {}
        if not (((sm.get("cohort_n") or 0) >= TRUST["min_cohort_n"])
                or ((b.get("months_active") or 0) >= TRUST["min_months_evidence"])):
            soft.append("no_evidence")
        if abs(sm.get("delta") or 0) > TRUST["max_shrink_delta"]:
            soft.append("inflated")
        wr = b.get("win_rate_pct")
        if wr is None or wr < TRUST["min_win_rate"]:
            soft.append("wr<min")
        return (len(hard) == 0), (len(hard) == 0 and len(soft) == 0), hard + soft

    # Annotate freshness + corr + trust on every deduped candidate (surfaced to the UI).
    for b in eligible:
        dsl = _days_since_last_trade(b, now)
        b["days_since_last_trade"] = dsl
        b["dormant"] = (dsl is not None and dsl > TRUST["max_dormant_days"])
        b["corr_max_vs_real"] = _corr_vs_real(b)
        hard_ok, soft_ok, reasons = _seat_block(b)
        b["trust_eligible"] = soft_ok
        b["trust_fails"] = reasons
        b["_seat_hard_ok"] = hard_ok

    # Diversification (owner promotes the 3 together to ONE account → avoid shared edge):
    # within a shrunk-score band, prefer DISTINCT base symbols. Applied to the TRUSTED
    # pool for the READY seats; a clearly-better bot is never displaced (bounded by band).
    DIVERSITY_BAND = 4.0
    def _base_sym(b):
        return (_primary_symbol(b) or "?").split(".")[0].upper()

    def _diversify(pool, n_seats):
        ordered, used_syms, pool = [], set(), list(pool)
        for _slot in range(min(n_seats, len(pool))):
            if not pool:
                break
            best = _shrunk(pool[0])
            pick = None
            for cand in pool:
                if (best - _shrunk(cand)) > DIVERSITY_BAND:
                    break
                if _base_sym(cand) not in used_syms:
                    pick = cand
                    break
            if pick is None:
                pick = pool[0]
            ordered.append(pick)
            used_syms.add(_base_sym(pick))
            pool.remove(pick)
        return ordered + pool

    seatable = [b for b in eligible if b.get("_seat_hard_ok")]      # may hold READY/NEAR
    blocked = [b for b in eligible if not b.get("_seat_hard_ok")]   # WATCH/NO only
    trusted = [b for b in seatable if b.get("trust_eligible")]
    provisional = [b for b in seatable if not b.get("trust_eligible")]
    for b in eligible:
        b.pop("_seat_hard_ok", None)

    # ALWAYS fill the 3 READY seats: trusted first (diversified), then provisional backfill,
    # then hard-blocked (which can still land in WATCH — a watchlist, not a real-money seat).
    eligible = _diversify(trusted, cap_ready) + provisional + blocked

    # Reset everyone to NO first; rank is authoritative.
    for b in snap.get("bots", []):
        b["promotion_status"] = "NO"

    shadow_cola = {"cvar_fail": 0, "tail_fail": 0, "sqn_fail": 0, "corr_fail": 0}
    for idx, b in enumerate(eligible):
        if idx < cap_ready:
            b["promotion_status"] = "READY"
        elif idx < cap_ready + cap_near:
            b["promotion_status"] = "NEAR"
        elif idx < cap_ready + cap_near + cap_watch:
            b["promotion_status"] = "WATCH"
        else:
            b["promotion_status"] = "NO"
        # A READY/NEAR seat filled by a NON-trusted bot (thin field) is flagged so the UI warns.
        if b["promotion_status"] in ("READY", "NEAR"):
            b["provisional_low_confidence"] = not b.get("trust_eligible", False)
        # Shadow gates: corr + SQN are ENFORCED via trust-eligibility above; cvar/tail stay
        # RECORD-only (owner decision — calibrate before enforcing).
        inst = b.get("institutional") or {}
        cvar, tail, band = inst.get("cvar_95_pct"), inst.get("tail_ratio"), inst.get("sqn_band")
        corr_max = b.get("corr_max_vs_real")
        b["shadow_gates"] = {
            "cvar_fail": cvar is not None and cvar < -5.0,
            "tail_fail": tail is not None and tail < 0.7,
            "sqn_fail": band == "MALO",
            "corr_max_vs_real": corr_max,
            "corr_fail": corr_max is not None and corr_max > 0.7,
        }
        if b["promotion_status"] in ("READY", "NEAR"):
            for k in shadow_cola:
                if b["shadow_gates"].get(k):
                    shadow_cola[k] += 1

    # PROVENANCE GUARD (carry-forward) — REAL-MONEY safety. A VPS served from
    # frozen last-good data this cycle must NOT seat its bots in READY/NEAR:
    # promoting real capital on an un-measured (stale) equity curve violates the
    # DNA. Degrade to WATCH + flag; portfolio/pairs/tracker all key off READY/NEAR
    # so the exclusion cascades automatically.
    carried_vps = {v for v, d in vps_freshness.items() if d.get("carried_forward")}
    if carried_vps:
        n_degraded = 0
        for b in snap.get("bots", []):
            if b.get("vps") in carried_vps:
                b["frozen_data"] = True
                if b.get("promotion_status") in ("READY", "NEAR"):
                    b["promotion_status"] = "WATCH"
                    b["frozen_downgraded"] = True
                    n_degraded += 1
        print(f"[provenance-guard] carried_vps={sorted(carried_vps)} READY/NEAR_degraded_to_WATCH={n_degraded}")

    # Re-enforce the WATCH cap after the provenance downgrades. Seating (above) already
    # respects the caps, but the provenance guard pushes stale READY/NEAR bots INTO WATCH
    # and can overflow it (WATCH=cap+1), which the disjointness/cap tribunal in
    # verify_integrity (--strict) would then abort on — freezing the whole dashboard.
    # A stale (frozen) bot must not hold a WATCH seat over a fresh one, so demote the
    # excess to NO, dropping frozen-downgraded bots first, then lowest score.
    watch_bots = [b for b in snap.get("bots", []) if b.get("promotion_status") == "WATCH"]
    overflow = len(watch_bots) - cap_watch
    if overflow > 0:
        to_demote = sorted(
            watch_bots,
            key=lambda b: (0 if b.get("frozen_downgraded") else 1, b.get("promotion_score") or 0),
        )[:overflow]
        for b in to_demote:
            b["promotion_status"] = "NO"
            b["watch_cap_demoted"] = True
        print(f"[watch-cap] WATCH overflow={overflow} demoted_to_NO="
              f"{[b.get('magic') for b in to_demote]}")

    # Floating-DD shadow (Fase B) — decorates bots/accounts from mirrored sampler
    # summaries; never mutates promotion_status (flip is manual, evidence-gated).
    fdd_meta = apply_floating_dd_shadow(snap, data_dir)
    if fdd_meta:
        print(f"[floating-dd-shadow] vps={fdd_meta['vps_with_sampler']} "
              f"bots={fdd_meta['bots_covered']} accounts={fdd_meta['accounts_covered']} "
              f"would_fail={fdd_meta['would_fail_floating_dd_count']}")

    # Forward Tracker — append today's status of READY/NEAR bots, decorate with verdict
    today_iso = datetime.now(timezone.utc).isoformat()
    tracker_stats = update_forward_tracker(snap, data_dir, today_iso, real_magics)
    # Surface tracker ledger health so verify_integrity can gate on corruption.
    snap["tracker_health"] = {
        "corrupt_lines": tracker_stats.get("corrupt_lines", 0),
        "history_lines": tracker_stats.get("history_lines", 0),
        "appended": tracker_stats.get("appended", 0),
        "tracked": tracker_stats.get("tracked", 0),
    }

    # Promotion Radar — 8-axis percentile-rank normalized cohort view (mutates bots).
    radar_meta = compute_promotion_radar(snap, accounts_by_login)

    # Dominance — "are the top-3 the thoroughbreds?" 4 core axes, P75 + Pareto (mutates bots).
    dominance_meta = compute_dominance(snap, accounts_by_login)

    # Adversarial Pair Finder — top-3 portfolio partners per READY/NEAR.
    pair_count = compute_pair_recommendations(snap, data_dir)

    # Ultra Tribunal — ingesta veredicto + doble firma + vigencia + gate continuo
    # + tenure. Visual-only (nunca muta promotion_status). Fail-open sin veredictos.
    tribunal_meta = apply_tribunal(snap, data_dir, now, real_logins, real_magics)
    if tribunal_meta is not None:
        snap["tribunal_meta"] = tribunal_meta
        cg = tribunal_meta.get("continuous_gate") or {}
        print(f"[tribunal] verdict={tribunal_meta['run_date']} ({tribunal_meta['verdict_state']}, "
              f"{tribunal_meta['age_days']}d) concordancia="
              f"{tribunal_meta['concordance']['matches']}/{tribunal_meta['concordance']['of']} "
              f"gate_continuo={cg.get('verdict')} violations={len(cg.get('violations') or [])} "
              f"historial={tribunal_meta['history']['n_verdicts']} veredictos")
    else:
        snap.pop("tribunal_meta", None)
        print("[tribunal] sin veredictos en tribunal/data/ — sección sin decorar (fail-open)")

    snap["promotion_meta"] = {
        "weights": WEIGHTS,
        "caps": CAPS,
        "gating": GATING,
        "thresholds": dict(STATUS),
        "shrinkage": shrinkage_meta,
        "computed_at": today_iso,
        # Candidate-pool transparency (Data Integrity DNA — every figure re-derivable).
        "rank_caps": dict(STATUS_RANK_CAPS),
        "trust": dict(TRUST),
        "ranker": ("promotion_score_shrunk desc (confidence-adjusted), net_after_commission desc, "
                   "trades desc, vps asc, login asc — READY/NEAR require trust-eligibility "
                   "(freshness + evidence + win_rate; HARD-exclude dormant/clones-real/SQN-MALO); "
                   "always 3 seats, thin field backfills flagged provisional_low_confidence"),
        "human_veto_required": True,  # charter SOLO-LECTURA: READY is a proposal, never auto-promote
        "pool_pre_commission": len(pool_pre_commission),
        "eligible_count": len(elig_all),  # after commission filter (true promotable pool)
        "pool_post_dedup": len(eligible),
        "trusted_count": len(trusted),          # fully trust-eligible (no soft/hard fails)
        "provisional_count": len(provisional),  # seatable but soft-failing (backfill)
        "hard_blocked_count": len(blocked),     # dormant / clones-real / SQN-MALO
        "dedup_dropped": dedup_dropped,
        "commission_filter_dropped": commission_filter_dropped,
        "commission_unknown": commission_unknown,  # fail-closed: excluded, gated by verify_integrity
        "real_magics_excluded": sorted(real_magics),
        "shadow_cola_gates_would_fail": shadow_cola,
        "shadow_pending": ["demo_real_gap"],
        "dominance": dominance_meta,  # P75/Pareto thoroughbred diagnostic (badges only)
    }
    snap["enrichment_meta"] = {
        "stress_runs": MC_RUNS,
        "oos_folds_max": OOS_FOLDS_MAX,
        "oos_perm_trials": OOS_PERM_TRIALS,
        "portfolio_max_bots": PORTFOLIO_MAX_BOTS,
        "portfolio_capitals": PORTFOLIO_CAPITALS,
        "drift_evaluated": drift_count,
        "drift_flagged": drift_flagged,
        "capacity_computed": capacity_count,
        "real_bots_tagged": real_bot_count,
        "institutional_computed": institutional_count,
        "tail_ratio_warn": tail_ratio_warn,
        "autocorr_warn": autocorr_warn,
        "underwater_computed": underwater_count,
        "confidence_intervals_computed": ci_count,
        "event_stress_computed": event_count,
        "battle_tested_count": battle_tested_count,
        "trade_distribution_computed": trade_dist_count,
        "promotion_radar": radar_meta,
        "pair_recommendations_computed": pair_count,
        "event_windows": EVENT_WINDOWS,
        "computed_at": today_iso,
    }

    # Save snapshot first (atomic), then build correlations + portfolio using stored scores.
    tmp = snap_path + ".pm.tmp"
    with open(tmp, "w") as f:
        json.dump(snap, f, ensure_ascii=False, indent=2)
    os.replace(tmp, snap_path)

    corr = build_correlation_matrix(snap, data_dir, real_accounts)
    corr_path = os.path.join(data_dir, "correlations.json")
    tmp2 = corr_path + ".tmp"
    with open(tmp2, "w") as f:
        json.dump(corr, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp2, corr_path)

    portfolio = build_portfolio(snap, data_dir, real_accounts, real_magics)
    if portfolio:
        port_path = os.path.join(data_dir, "portfolio.json")
        tmp3 = port_path + ".tmp"
        with open(tmp3, "w") as f:
            json.dump(portfolio, f, ensure_ascii=False, indent=2)
        os.replace(tmp3, port_path)

    # Survival Curve — Kaplan-Meier per cohort (overall + score buckets + symbols).
    survival = build_survival_table(snap)
    survival_n_curves = 0
    if survival:
        surv_path = os.path.join(data_dir, "survival.json")
        tmp4 = surv_path + ".tmp"
        with open(tmp4, "w") as f:
            json.dump(survival, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp4, surv_path)
        survival_n_curves = len(survival.get("curves") or {})

    # Health metrics aggregated from heartbeat + dispatch logs.
    health_metrics = aggregate_health_metrics(data_dir)
    if health_metrics:
        snap["health_metrics"] = health_metrics
        # Re-save snapshot with the additions (vps_freshness was already there,
        # but health_metrics + final status need to persist).
        tmpH = snap_path + ".hm.tmp"
        with open(tmpH, "w") as f:
            json.dump(snap, f, ensure_ascii=False, indent=2)
        os.replace(tmpH, snap_path)

    # Auto-generated operations status page.
    try:
        sync_md = write_sync_status_md(data_dir, snap, vps_freshness, health_metrics, partial_data)
        sync_md_msg = f"sync_status={os.path.basename(sync_md)}"
    except Exception as e:
        sync_md_msg = f"sync_status_err={e}"

    counts = {}
    for b in snap.get("bots", []):
        s = b.get("promotion_status") or "?"
        counts[s] = counts.get(s, 0) + 1
    n_stale_vps = sum(1 for v in vps_freshness.values()
                      if v.get("present") and v.get("stale"))
    print(
        f"post_merge OK enriched={enriched} status={counts} "
        f"vps_stale={n_stale_vps} partial={partial_data} {sync_md_msg} "
        f"stress={stress_count} oos={oos_count} regime={regime_count} "
        f"drift={drift_count} drift_flagged={drift_flagged} "
        f"capacity={capacity_count} real_bots={real_bot_count} real_daily={real_daily_count} "
        f"underwater={underwater_count} ci={ci_count} events={event_count} battle_tested={battle_tested_count} "
        f"shrinkage_cohorts={(shrinkage_meta or {}).get('cohorts_with_prior', 0)}/"
        f"{(shrinkage_meta or {}).get('cohorts_total', 0)} "
        f"corr_bots={corr['bot_count']} "
        f"tracker_appended={tracker_stats['appended']} tracker_decorated={tracker_stats['tracked']} "
        f"portfolio_bots={portfolio['n_bots'] if portfolio else 0} "
        f"radar_decorated={(radar_meta or {}).get('n_decorated', 0)} "
        f"trade_dist={trade_dist_count} pairs={pair_count} survival_curves={survival_n_curves}"
    )


if __name__ == "__main__":
    main()
