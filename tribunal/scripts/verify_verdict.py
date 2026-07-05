#!/usr/bin/env python3
"""Gate determinístico del Ultra Tribunal — barrido de dominancia del podio.

Para cada caballo del podio, compara sus percentiles núcleo (12 ejes) contra
TODA la cohorte demo viva. Si un bot fuera del podio con evidencia comparable
(trades ≥ 75% de las del ganador) es estrictamente mejor en ≥ 9/12 ejes,
el podio queda REJECTED y el Juez debe swapear o justificar.

Uso: python3 verify_verdict.py "vps:login:magic" "vps:login:magic" "vps:login:magic"
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DOMINANCE_FRACTION = 0.70   # ≥70% de ejes núcleo
EVIDENCE_RATIO = 0.75       # trades del retador ≥ 75% de las del ganador


def main() -> int:
    podium = [a.strip() for a in sys.argv[1:] if a.strip()]
    if len(podium) != 3:
        print(json.dumps({"ok": False, "error": "se requieren exactamente 3 ids vps:login:magic"}))
        return 2
    exp = json.loads((DATA_DIR / "expediente.json").read_text())
    core = exp["core_axes"]
    need = max(1, round(DOMINANCE_FRACTION * len(core)))
    by_id = {r["id"]: r for r in exp["cohort"]}

    missing = [p for p in podium if p not in by_id]
    if missing:
        print(json.dumps({"ok": False, "error": f"ids fuera de la cohorte viva: {missing}"}))
        return 2

    violations = []
    for wid in podium:
        w = by_id[wid]
        wpct = w.get("pct", {})
        for r in exp["cohort"]:
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

    verdict = {
        "ok": True,
        "podium": podium,
        "verdict": "PASS" if not violations else "REJECT",
        "rule": f"retador mejor en ≥{need}/{len(core)} ejes núcleo con trades ≥{int(EVIDENCE_RATIO*100)}% del ganador",
        "violations": violations,
        "podium_composites": {p: by_id[p].get("core_composite") for p in podium},
    }
    out = DATA_DIR / "last_gate.json"
    out.write_text(json.dumps(verdict, ensure_ascii=False, indent=1))
    print(json.dumps(verdict, ensure_ascii=False))
    return 0 if not violations else 1


if __name__ == "__main__":
    sys.exit(main())
