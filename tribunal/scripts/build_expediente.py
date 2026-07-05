#!/usr/bin/env python3
"""Fase 0 del Ultra Tribunal de Bots — expediente determinístico.

Baja el snapshot fresco de Supabase Storage (mismas credenciales que el
dashboard Battle of Bots), filtra SOLO bots de cuentas demo, calcula
percentil-rank por eje contra toda la cohorte viva y emite:

  data/expediente.json        — cohorte completa + percentiles (para verify_verdict.py)
  data/expediente_digest.md   — tabla compacta de candidatos (lo que leen los 100 lentes)

Todos los números que citan los agentes del tribunal salen de aquí.
Uso:  python3 build_expediente.py [--offline]   (--offline usa data/snapshot_cache.json)
"""
from __future__ import annotations

import json
import math
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BOB_REPO = Path("/Users/yodyiznaga/battle-of-bots")
ENV_FILE = BOB_REPO / ".env.local"
BUCKET = "dashboard-data"
SKILL_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = SKILL_DIR / "data"
FRESH_MAX_HOURS = 2.0
ALIVE_DAYS = 14          # last_trade dentro de esta ventana = bot vivo
MIN_TRADES = 20          # evidencia mínima para entrar a la cohorte
TOP_K_PER_METRIC = 12    # nominados por métrica para la lista de candidatos
MAX_CANDIDATES = 48


def load_env() -> dict[str, str]:
    """Prioridad: variables de entorno reales (entorno remoto del trigger semanal)
    > .env.local (Mac local). Esto permite correr el mismo script en ambos contextos
    sin duplicar lógica."""
    env: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    missing = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY") if not env.get(k)]
    if missing:
        raise RuntimeError(
            f"Faltan credenciales Supabase: {missing}. "
            f"Localmente deben estar en {ENV_FILE}; en el entorno remoto del trigger "
            f"deben inyectarse como variables de entorno del mismo nombre."
        )
    return env


def fetch_snapshot(offline: bool) -> dict:
    cache = DATA_DIR / "snapshot_cache.json"
    if offline:
        return json.loads(cache.read_text())
    env = load_env()
    url = env["SUPABASE_URL"].rstrip("/")
    key = env["SUPABASE_SERVICE_ROLE_KEY"]
    req = urllib.request.Request(
        f"{url}/storage/v1/object/{BUCKET}/snapshot.json",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    snap = json.load(urllib.request.urlopen(req, timeout=60))
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(snap))
    return snap


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


def num(x, default=None):
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def bot_id(b: dict) -> str:
    return f"{b.get('vps')}:{b.get('account_login')}:{b.get('magic')}"


def extract(b: dict) -> dict:
    """Escalares por bot (fuente única de los 50 ejes)."""
    td = b.get("trade_distribution") or {}
    drift = b.get("drift") or {}
    stress = b.get("stress") or {}
    cap = b.get("capacity") or {}
    inst = b.get("institutional") or {}
    radar = b.get("promotion_radar") or {}
    ci = b.get("confidence_intervals") or {}
    shrink = b.get("shrinkage_meta") or {}
    gating = b.get("promotion_gating") or {}
    avg_win = num(b.get("avg_win"), 0.0) or 0.0
    avg_loss = abs(num(b.get("avg_loss"), 0.0) or 0.0)
    ci_calmar = ci.get("calmar") or {}
    ci_stable = sum(1 for m in ci.values() if isinstance(m, dict) and m.get("stable"))
    return {
        "id": bot_id(b),
        "vps": b.get("vps"), "login": b.get("account_login"), "magic": b.get("magic"),
        "symbols": ",".join(b.get("symbols") or [])[:24],
        "first_trade": b.get("first_trade"), "last_trade": b.get("last_trade"),
        "months_active": num(b.get("months_active")),
        "trades": num(b.get("trades")), "trades_30d": num(b.get("trades_30d")), "trades_90d": num(b.get("trades_90d")),
        "net_30d": num(b.get("net_30d")), "net_90d": num(b.get("net_90d")),
        "net_profit": num(b.get("net_profit")), "net_after_commission": num(b.get("net_after_commission")),
        "expectancy": num(b.get("expectancy")), "profit_factor": num(b.get("profit_factor")),
        "win_rate_pct": num(b.get("win_rate_pct")),
        "awl_ratio": (avg_win / avg_loss) if avg_loss > 0 else None,
        "best_trade": num(b.get("best_trade")), "worst_trade": num(b.get("worst_trade")),
        "worst_trade_abs": abs(num(b.get("worst_trade"), 0.0) or 0.0),
        "sharpe_annualized": num(b.get("sharpe_annualized")), "sqn": num(b.get("sharpe_like")),
        "sortino": num(b.get("sortino")), "calmar": num(b.get("calmar")),
        "recovery_factor": num(b.get("recovery_factor")),
        "max_drawdown": num(b.get("max_drawdown")), "dd_pct_of_balance": num(b.get("dd_pct_of_balance")),
        "longest_dd_duration_days": num(b.get("longest_dd_duration_days")),
        "longest_losing_streak_months": num(b.get("longest_losing_streak_months")),
        "max_consecutive_losses": num(b.get("max_consecutive_losses")),
        "stdev_per_trade": num(b.get("stdev_per_trade")),
        "monthly_net_stdev": num(b.get("monthly_net_stdev")), "monthly_net_cov": num(b.get("monthly_net_cov")),
        "months_positive_pct": num(b.get("months_positive_pct")),
        "slope_lifetime": num(b.get("slope_lifetime")), "slope_recent_90d": num(b.get("slope_recent_90d")),
        "decay_flag": bool(b.get("decay_flag")), "decay_ratio": num(b.get("decay_ratio")),
        "drift_flag": bool(drift.get("flag")),
        "drift_severity": num(drift.get("severity"), 0.0) if drift.get("flag") else 0.0,
        "stress_prob_negative": num(stress.get("prob_negative")),
        "stress_prob_ruin": num(stress.get("prob_ruin")),
        "stress_dd_p95_pct": num(stress.get("dd_pct_balance_p95")),
        "stress_net_p50": num(stress.get("net_p50")),
        "capacity_usd": num(cap.get("capacity_usd")), "capacity_verdict": cap.get("verdict"),
        "sqn_inst": num(inst.get("sqn")), "martin_ratio": num(inst.get("martin_ratio")),
        "ulcer_index_pct": num(inst.get("ulcer_index_pct")), "cvar_95_pct": num(inst.get("cvar_95_pct")),
        "skewness": num(td.get("skewness")), "excess_kurtosis": num(td.get("excess_kurtosis")),
        "top5pct_contribution_pct": num(td.get("top5pct_contribution_pct")),
        "distribution_type": td.get("distribution_type"),
        "radar_area_pct": num(radar.get("area_pct")), "radar_shape": radar.get("shape_label"),
        "radar_asymmetry": num(radar.get("asymmetry")),
        "ci_calmar_width": num(ci_calmar.get("width")), "ci_stable_count": ci_stable,
        "shrink_confidence": shrink.get("confidence"), "shrink_delta": num(shrink.get("delta")),
        "promotion_score_raw": num(b.get("promotion_score_raw")),
        "promotion_score_shrunk": num(b.get("promotion_score_shrunk")),
        "promotion_status": b.get("promotion_status"),
        "gating_fails": [k for k, v in gating.items() if v is False],
    }


# ejes percentilados: (campo, True=mayor-mejor)
PCT_AXES: list[tuple[str, bool]] = [
    ("net_30d", True), ("net_90d", True), ("net_profit", True), ("net_after_commission", True),
    ("expectancy", True), ("profit_factor", True), ("win_rate_pct", True), ("awl_ratio", True),
    ("sharpe_annualized", True), ("sqn", True), ("sortino", True), ("calmar", True),
    ("recovery_factor", True), ("slope_recent_90d", True), ("slope_lifetime", True),
    ("months_positive_pct", True), ("months_active", True), ("trades_30d", True), ("trades", True),
    ("promotion_score_shrunk", True), ("promotion_score_raw", True),
    ("stress_net_p50", True), ("capacity_usd", True), ("martin_ratio", True), ("radar_area_pct", True),
    ("dd_pct_of_balance", False), ("longest_dd_duration_days", False),
    ("longest_losing_streak_months", False), ("max_consecutive_losses", False),
    ("monthly_net_cov", False), ("stdev_per_trade", False), ("worst_trade_abs", False),
    ("top5pct_contribution_pct", False), ("drift_severity", False),
    ("stress_prob_negative", False), ("stress_dd_p95_pct", False),
    ("ci_calmar_width", False), ("radar_asymmetry", False), ("ulcer_index_pct", False),
]

# 12 ejes núcleo (gate de dominancia + composite)
CORE_AXES = [
    "net_30d", "net_90d", "net_profit", "expectancy", "profit_factor", "calmar",
    "sortino", "recovery_factor", "months_positive_pct", "promotion_score_shrunk",
    "dd_pct_of_balance", "monthly_net_cov",
]

CANDIDATE_METRICS = [
    "net_30d", "net_90d", "net_profit", "net_after_commission", "expectancy",
    "profit_factor", "calmar", "sortino", "recovery_factor", "promotion_score_shrunk",
    "months_positive_pct", "win_rate_pct", "sqn", "core_composite",
]


def percentile_ranks(rows: list[dict]) -> None:
    """Midrank-ties CDF empírico por eje → row['pct'][axis] ∈ [0,100]."""
    for axis, higher_better in PCT_AXES:
        vals = [(r[axis], r) for r in rows if r.get(axis) is not None]
        if not vals:
            continue
        vals.sort(key=lambda t: t[0])
        n = len(vals)
        i = 0
        while i < n:
            j = i
            while j + 1 < n and vals[j + 1][0] == vals[i][0]:
                j += 1
            midrank = (i + j) / 2 + 1
            pct = 100.0 * (midrank - 0.5) / n
            for k in range(i, j + 1):
                vals[k][1].setdefault("pct", {})[axis] = round(pct if higher_better else 100.0 - pct, 1)
            i = j + 1


def fmt(v, nd=1):
    if v is None:
        return "·"
    if isinstance(v, bool):
        return "SÍ" if v else "no"
    if isinstance(v, float):
        return f"{v:,.{nd}f}"
    return str(v)


def main() -> int:
    offline = "--offline" in sys.argv
    snap = fetch_snapshot(offline)
    gen = parse_iso(snap.get("generated_at"))
    now = datetime.now(timezone.utc)
    age_h = (now - gen).total_seconds() / 3600 if gen else 999
    real_magics = set(snap.get("real_magics") or [])
    real_logins = {a.get("login") for a in (snap.get("accounts") or [])
                   if a.get("is_real") or a.get("trade_mode") == 2}

    stale = age_h > FRESH_MAX_HOURS
    demo = [b for b in snap.get("bots", [])
            if not b.get("is_real")
            and b.get("magic") not in real_magics
            and b.get("account_login") not in real_logins]

    rows = [extract(b) for b in demo]
    cutoff = now - timedelta(days=ALIVE_DAYS)
    alive = [r for r in rows
             if (r.get("trades") or 0) >= MIN_TRADES
             and (parse_iso(r.get("last_trade")) or datetime.min.replace(tzinfo=timezone.utc)) >= cutoff]

    percentile_ranks(alive)
    for r in alive:
        core = [r.get("pct", {}).get(a) for a in CORE_AXES]
        core = [c for c in core if c is not None]
        r["core_composite"] = round(sum(core) / len(core), 2) if core else None

    # candidatos: unión de top-K por métrica clave, cap por composite
    cand_ids: set[str] = set()
    for m in CANDIDATE_METRICS:
        ranked = sorted([r for r in alive if r.get(m) is not None], key=lambda r: r[m], reverse=True)
        cand_ids.update(r["id"] for r in ranked[:TOP_K_PER_METRIC])
    candidates = sorted([r for r in alive if r["id"] in cand_ids],
                        key=lambda r: r.get("core_composite") or 0, reverse=True)[:MAX_CANDIDATES]

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    expediente = {
        "generated_at": snap.get("generated_at"),
        "built_at": now.isoformat(),
        "snapshot_age_hours": round(age_h, 2),
        "stale": stale,
        "filters": {"alive_days": ALIVE_DAYS, "min_trades": MIN_TRADES,
                    "demo_total": len(demo), "alive_cohort": len(alive),
                    "excluded_real_magics": len(real_magics), "excluded_real_logins": len(real_logins)},
        "core_axes": CORE_AXES,
        "candidates": [r["id"] for r in candidates],
        "cohort": alive,
    }
    (DATA_DIR / "expediente.json").write_text(json.dumps(expediente, ensure_ascii=False))

    # ── digest markdown para los lentes ────────────────────────────────────
    L: list[str] = []
    L.append("# EXPEDIENTE — Ultra Tribunal de Bots (SOLO cuentas demo)")
    L.append(f"\nSnapshot: `{snap.get('generated_at')}` (edad {age_h:.1f}h{' ⚠️ STALE' if stale else ''}) · "
             f"Bots demo: {len(demo)} · Cohorte viva (last_trade ≤{ALIVE_DAYS}d, trades ≥{MIN_TRADES}): {len(alive)} · "
             f"Candidatos en mesa: {len(candidates)} · Reales excluidos: {len(real_magics)} magics.")
    L.append("\nID = `vps:login:magic`. `·` = dato no disponible. CoV mensual: menor=más regular. "
             "top5% = % del PnL que aportan el 5% mejores trades (alto = lottery-ticket). "
             "Comp = composite de percentiles núcleo (0-100, referencia, NO veredicto).")
    L.append("\n## Tabla A — Dinero y actividad\n")
    L.append("| ID | Sym | Meses | Tr | Tr30 | Net30 | Net90 | NetLife | NetComm | Exp | PF | WR% | W/L | Slope90 | SlopeLife | Comp |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in candidates:
        L.append("| " + " | ".join([
            f"`{r['id']}`", r["symbols"] or "·", fmt(r["months_active"], 1), fmt(r["trades"], 0),
            fmt(r["trades_30d"], 0), fmt(r["net_30d"]), fmt(r["net_90d"]), fmt(r["net_profit"]),
            fmt(r["net_after_commission"]), fmt(r["expectancy"], 2), fmt(r["profit_factor"], 2),
            fmt(r["win_rate_pct"]), fmt(r["awl_ratio"], 2), fmt(r["slope_recent_90d"], 2),
            fmt(r["slope_lifetime"], 2), fmt(r["core_composite"]),
        ]) + " |")
    L.append("\n## Tabla B — Riesgo, consistencia y calidad estadística\n")
    L.append("| ID | DD% | DDdías | RachaLm | MaxLoss# | Calmar | Sortino | Sharpe | SQN | Rec | CoV | Mes+% | top5% | Skew | Kurt | Decay | Drift | Shrunk | Raw | ShrinkConf | CIcalmarW | Ruin% | Pneg% | Cap$ | Radar |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in candidates:
        drift_s = f"{r['drift_severity']:.2f}" if r["drift_flag"] else "no"
        radar = f"{r['radar_shape'] or '·'}/{fmt(r['radar_area_pct'])}%/asym {fmt(r['radar_asymmetry'], 2)}"
        L.append("| " + " | ".join([
            f"`{r['id']}`", fmt(r["dd_pct_of_balance"]), fmt(r["longest_dd_duration_days"], 0),
            fmt(r["longest_losing_streak_months"], 0), fmt(r["max_consecutive_losses"], 0),
            fmt(r["calmar"], 2), fmt(r["sortino"], 2), fmt(r["sharpe_annualized"], 2), fmt(r["sqn"], 2),
            fmt(r["recovery_factor"], 2), fmt(r["monthly_net_cov"], 2), fmt(r["months_positive_pct"]),
            fmt(r["top5pct_contribution_pct"]), fmt(r["skewness"], 2), fmt(r["excess_kurtosis"], 2),
            fmt(r["decay_flag"]), drift_s, fmt(r["promotion_score_shrunk"]), fmt(r["promotion_score_raw"]),
            r["shrink_confidence"] or "·", fmt(r["ci_calmar_width"], 1),
            fmt((r["stress_prob_ruin"] or 0) * 100), fmt((r["stress_prob_negative"] or 0) * 100),
            fmt(r["capacity_usd"], 0), radar,
        ]) + " |")
    L.append("\n## Fichas (flags operativas)\n")
    for r in candidates:
        extras = []
        if r["gating_fails"]:
            extras.append("gating FAIL: " + ",".join(r["gating_fails"]))
        if r["promotion_status"]:
            extras.append(f"status {r['promotion_status']}")
        if r["capacity_verdict"]:
            extras.append(f"capacity {r['capacity_verdict']}")
        extras.append(f"CI estables {r['ci_stable_count']}/5")
        extras.append(f"1er trade {str(r['first_trade'])[:10]} · último {str(r['last_trade'])[:10]}")
        extras.append(f"dist {r['distribution_type'] or '·'}")
        L.append(f"- `{r['id']}` — " + " · ".join(extras))
    (DATA_DIR / "expediente_digest.md").write_text("\n".join(L))

    print(json.dumps({
        "ok": True, "stale": stale, "snapshot_generated_at": snap.get("generated_at"),
        "age_hours": round(age_h, 2), "demo_total": len(demo), "alive_cohort": len(alive),
        "candidates": len(candidates), "reals_excluded": bool(real_magics or real_logins),
        "digest": str(DATA_DIR / "expediente_digest.md"),
        "expediente": str(DATA_DIR / "expediente.json"),
        "hint_if_stale": "gh workflow run refresh-dashboard --repo yody38/KizCapital-Battle-of-Bots",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
