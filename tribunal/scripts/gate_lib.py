#!/usr/bin/env python3
"""Fuente única del gate determinístico de dominancia del Ultra Tribunal.

Compartida por:
  · verify_verdict.py — gate semanal del tribunal sobre data/expediente.json
  · scripts/post_merge.py — gate CONTINUO cada ciclo CI sobre el snapshot enriquecido

Regla: si un bot fuera del podio con evidencia comparable (trades ≥ EVIDENCE_RATIO
del ganador) es estrictamente mejor en ≥ DOMINANCE_FRACTION de los ejes núcleo,
el podio queda REJECTED.
"""
from __future__ import annotations

DOMINANCE_FRACTION = 0.70   # ≥70% de ejes núcleo
EVIDENCE_RATIO = 0.75       # trades del retador ≥ 75% de las del ganador

# Cohorte viva (misma definición que build_expediente.py Fase 0)
COHORT_ALIVE_DAYS = 14      # last_trade dentro de esta ventana = bot vivo
COHORT_MIN_TRADES = 20      # evidencia mínima para entrar a la cohorte

# 12 ejes núcleo con dirección (True = mayor-mejor)
CORE_AXES_DIRECTION: list[tuple[str, bool]] = [
    ("net_30d", True), ("net_90d", True), ("net_profit", True), ("expectancy", True),
    ("profit_factor", True), ("calmar", True), ("sortino", True), ("recovery_factor", True),
    ("months_positive_pct", True), ("promotion_score_shrunk", True),
    ("dd_pct_of_balance", False), ("monthly_net_cov", False),
]
CORE_AXES = [a for a, _ in CORE_AXES_DIRECTION]


def percentile_ranks(rows: list[dict], axes: list[tuple[str, bool]]) -> None:
    """Midrank-ties CDF empírico por eje → row['pct'][axis] ∈ [0,100]."""
    for axis, higher_better in axes:
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


def core_composite(row: dict) -> float | None:
    core = [row.get("pct", {}).get(a) for a in CORE_AXES]
    core = [c for c in core if c is not None]
    return round(sum(core) / len(core), 2) if core else None


def dominance_scan(cohort: list[dict], podium: list[str],
                   core_axes: list[str] | None = None) -> dict:
    """Barrido de dominancia del podio sobre la cohorte percentilada.

    cohort: rows con 'id', 'trades', 'pct' (percentiles por eje) y opcional
    'core_composite'. podium: 3 ids "vps:login:magic".
    """
    core = core_axes or CORE_AXES
    need = max(1, round(DOMINANCE_FRACTION * len(core)))
    by_id = {r["id"]: r for r in cohort}

    missing = [p for p in podium if p not in by_id]
    if missing:
        return {"ok": False, "error": f"ids fuera de la cohorte viva: {missing}",
                "podium": podium, "verdict": None, "violations": []}

    violations = []
    for wid in podium:
        w = by_id[wid]
        wpct = w.get("pct", {})
        for r in cohort:
            if r["id"] in podium:
                continue
            if (r.get("trades") or 0) < EVIDENCE_RATIO * (w.get("trades") or 0):
                continue
            rpct = r.get("pct", {})
            axes_beaten = [a for a in core
                           if a in rpct and a in wpct and rpct[a] > wpct[a]]
            if len(axes_beaten) >= need:
                violations.append({
                    "winner": wid, "challenger": r["id"],
                    "beats_on": len(axes_beaten), "of": len(core),
                    "axes": axes_beaten,
                    "challenger_composite": r.get("core_composite"),
                    "winner_composite": w.get("core_composite"),
                })

    return {
        "ok": True,
        "podium": podium,
        "verdict": "PASS" if not violations else "REJECT",
        "rule": f"retador mejor en ≥{need}/{len(core)} ejes núcleo con trades ≥{int(EVIDENCE_RATIO*100)}% del ganador",
        "violations": violations,
        "podium_composites": {p: by_id[p].get("core_composite") for p in podium},
    }
