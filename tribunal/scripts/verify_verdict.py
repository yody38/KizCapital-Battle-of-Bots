#!/usr/bin/env python3
"""Gate determinístico del Ultra Tribunal — barrido de dominancia del podio.

Para cada caballo del podio, compara sus percentiles núcleo (12 ejes) contra
TODA la cohorte demo viva. Si un bot fuera del podio con evidencia comparable
(trades ≥ 75% de las del ganador) es estrictamente mejor en ≥ 8/12 ejes,
el podio queda REJECTED y el Juez debe swapear o justificar.

La regla vive en gate_lib.py (fuente única, compartida con el gate continuo
de post_merge.py).

Uso: python3 verify_verdict.py "vps:login:magic" "vps:login:magic" "vps:login:magic"
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from gate_lib import dominance_scan

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def main() -> int:
    podium = [a.strip() for a in sys.argv[1:] if a.strip()]
    if len(podium) != 3:
        print(json.dumps({"ok": False, "error": "se requieren exactamente 3 ids vps:login:magic"}))
        return 2
    exp = json.loads((DATA_DIR / "expediente.json").read_text())

    verdict = dominance_scan(exp["cohort"], podium, core_axes=exp["core_axes"])
    if not verdict.get("ok"):
        print(json.dumps({"ok": False, "error": verdict.get("error")}, ensure_ascii=False))
        return 2

    out = DATA_DIR / "last_gate.json"
    out.write_text(json.dumps(verdict, ensure_ascii=False, indent=1))
    print(json.dumps(verdict, ensure_ascii=False))
    return 0 if verdict["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
