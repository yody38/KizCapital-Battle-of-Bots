#!/usr/bin/env python3
"""Regenera docs/FORMULA_CHANGES.md desde el changelog que vive en el codigo.

El documento y la formula no pueden divergir, asi que la fuente unica es
`SCORE_CHANGELOG_V2` en post_merge.py. Correr tras tocar cualquier formula:

    python3 scripts/gen_formula_changes.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import post_merge as pm  # noqa: E402

OUT = ROOT / "docs" / "FORMULA_CHANGES.md"


def build() -> str:
    L = [
        "# Cambios de formula — trazabilidad obligatoria",
        "",
        "Generado automaticamente desde `SCORE_CHANGELOG_V2` en `scripts/post_merge.py`.",
        "No editar a mano: si cambia la formula, cambia el codigo y este documento se",
        "regenera con `python3 scripts/gen_formula_changes.py`.",
        "",
        f"**Version viva del score:** `{pm.SCORE_LIVE_VERSION}`  ",
        f"**Versiones en sombra:** "
        f"{', '.join(f'`{v}`' for v in pm.SCORE_SHADOW_VERSIONS) or 'ninguna'}",
        "",
        "Mientras la version viva sea `v1`, NADA de lo que sigue afecta a",
        "`promotion_status`, al orden de los asientos ni a ninguna cifra publicada.",
        "v2 se calcula y se publica en paralelo para que el owner pueda comparar",
        "antes de autorizar el cambio.",
        "",
        "El diff por bot de cada ciclo queda en `data/shadow/score_v2_diff.json`, y",
        "el resumen en `snapshot.promotion_meta.score_versions.v2.diff`.",
        "",
        "---",
        "",
    ]
    for i, e in enumerate(pm.SCORE_CHANGELOG_V2, 1):
        L += [
            f"## F{i} · `{e['component']}`", "",
            "| | |", "|---|---|",
            f"| **OLD FORMULA** | `{e['old']}` |",
            f"| **NEW FORMULA** | `{e['new']}` |",
            f"| **RATIONALE** | {e['rationale']} |",
            f"| **EXPECTED IMPACT** | {e['expected_impact']} |",
            f"| **AFFECTED BOTS** | {e['affected']} |",
            f"| **TEST** | `{e['test']}` |",
            "",
        ]
    L += [
        "---", "",
        "## Correlacion", "",
        "| | |", "|---|---|",
        f"| **Version viva** | `{pm.CORR_LIVE_VERSION}` |",
        "| **OLD (v1, viva)** | pearson sobre la UNION de fechas, rellenando con "
        "0.0 los dias sin operar |",
        f"| **NEW (v2, sombra)** | pearson sobre la INTERSECCION de dias activos, "
        f"minimo {pm.MIN_CORR_OVERLAP_DAYS} dias solapados, `None` si no llega |",
        "| **RATIONALE** | Las series son dispersas. El relleno con ceros sesga la "
        "correlacion hacia 0 en pares de baja frecuencia y la infla entre bots que "
        "solo comparten calendario. Ese estimador alimenta el bloqueo HARD "
        "`clones_real` con umbral 0.7. |",
        "| **EXPECTED IMPACT** | Puede cambiar que bots quedan bloqueados por "
        "parecerse a uno ya desplegado en real. |",
        "| **AFFECTED BOTS** | los hasta 60 del universo de correlacion |",
        "| **TEST** | `tests/test_correlation_v2.py` |",
        "",
        "Ambas matrices viajan en `data/correlations.json`: `matrix` (v1) y",
        "`matrix_v2`, junto a `overlap_n` con los dias solapados de cada par.",
        "",
        "---", "",
        "## Ventanas temporales", "",
        "Desde 2026-09-08 todo campo nuevo lleva la ventana en el nombre:",
        "`_lifetime`, `_365d`, `_180d`, `_90d`, `_30d`, `_current`. Los campos sin",
        "sufijo conservan su semantica mezclada actual, estan documentados en",
        "`snapshot.metrics_meta`, y se retiran cuando ningun consumidor los lea.",
        "",
        "Convencion de dinero: los campos con sufijo usan",
        "`net = profit + commission + swap`. Los campos legacy sin sufijo que",
        "escribe `reconcile_snapshot` usan `profit + swap`, sin comision, que es",
        "mas optimista. Por eso no se mezclan.",
        "",
    ]
    return "\n".join(L)


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(build(), encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)} regenerado")
