#!/usr/bin/env python3
"""
adaptive_tuner.py — Motor de aprendizaje continuo del pipeline (SHADOW MODE).

Corre al final de cada ciclo de CI (mirror.sh, después de emit_timing y antes
del upload). Aprende baselines de latencia y fragilidad a partir de la
telemetría acumulada y emite recomendaciones de cadencia — SIN aplicarlas:

  mode="shadow": ningún consumidor cambia su comportamiento. live_publisher,
  data-source.js y el watchdog solo LOGUEAN qué habría cambiado. Tras ≥1
  semana de shadow y revisión del owner, se activa (proceso shadow-first del
  proyecto: nunca precipitar un cambio de cadencia sobre una medición en curso).

Inputs (best-effort, los que existan en data/):
  pipeline_timing_history.jsonl  p50/p95 del ciclo e2e por hora UTC (emit_timing)
  learning_events.jsonl          auto-recoveries del heartbeat (horas frágiles)
  .breaker_state.json            trips de los circuit breakers

Outputs:
  data/tuning.json               baselines + recomendaciones (se sube a Storage)
  data/tuning_shadow_log.jsonl   1 línea/ciclo: qué HABRÍA cambiado (rolling 1000)

Exit 0 siempre — la telemetría nunca rompe un ciclo sano.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
TIMING_HISTORY = DATA_DIR / "pipeline_timing_history.jsonl"
LEARNING_EVENTS = DATA_DIR / "learning_events.jsonl"
BREAKER_STATE = DATA_DIR / ".breaker_state.json"
TUNING = DATA_DIR / "tuning.json"
SHADOW_LOG = DATA_DIR / "tuning_shadow_log.jsonl"
SHADOW_LOG_MAX = 1000

# Valores vigentes hoy (constantes en el código de cada consumidor) — el shadow
# log compara contra esto. Mantener en sync si algún consumidor cambia.
CURRENT = {
    "live_tick_secs": 3.0,        # live_publisher --interval
    "frontend_poll_ms": 5000,     # data-source.js POLL_MS
    "snapshot_deadman_min": 90,   # integrity_watchdog SNAPSHOT_DEADMAN
}

MIN_CYCLES_PER_HOUR = 5  # sin n suficiente no hay baseline (no sobreajustar a ruido)


def parse_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def percentile(vals: list[float], q: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    if len(s) == 1:
        return float(s[0])
    pos = q * (len(s) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def parse_iso(v) -> datetime | None:
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def market_open(now: datetime) -> bool:
    """Forex: cierra viernes 22:00 UTC, reabre domingo 22:00 UTC."""
    wd, hhmm = now.weekday(), now.hour + now.minute / 60
    if wd == 4 and hhmm >= 22:
        return False
    if wd == 5:
        return False
    if wd == 6 and hhmm < 22:
        return False
    return True


def main() -> int:
    now = datetime.now(timezone.utc)

    # --- Baselines de latencia por hora UTC (ventana de emit_timing ~4 días) ---
    by_hour: dict[int, list[float]] = {}
    for row in parse_jsonl(TIMING_HISTORY):
        t = parse_iso(row.get("ts"))
        e2e = row.get("end_to_end_ms")
        if t and isinstance(e2e, (int, float)) and e2e > 0:
            by_hour.setdefault(t.hour, []).append(float(e2e))
    baselines_hour = {
        str(h): {
            "cycles": len(v),
            "e2e_p50_ms": int(percentile(v, 0.50)),
            "e2e_p95_ms": int(percentile(v, 0.95)),
        }
        for h, v in sorted(by_hour.items())
        if len(v) >= MIN_CYCLES_PER_HOUR
    }

    # --- Fragilidad por hora: auto-recoveries de heartbeat_check (90 días) ---
    frag_cut = now - timedelta(days=90)
    recoveries_by_hour: dict[str, int] = {}
    for ev in parse_jsonl(LEARNING_EVENTS):
        t = parse_iso(ev.get("ts"))
        if t and t >= frag_cut and str(ev.get("result", "")).startswith("recovery"):
            recoveries_by_hour[str(t.hour)] = recoveries_by_hour.get(str(t.hour), 0) + 1

    # --- Trips de breakers (estado actual) ---
    try:
        breakers = json.loads(BREAKER_STATE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        breakers = {}
    breaker_trips = {k: v.get("trips", 0) for k, v in breakers.items() if isinstance(v, dict)}

    # --- Recomendaciones (reglas explicables, nada de cajas negras) ---
    is_open = market_open(now)
    overlap = is_open and 12 <= now.hour < 16 and now.weekday() < 5  # Londres+NY

    if not is_open:
        tick, tick_why = 10.0, "mercado forex cerrado — nada cambia entre ticks"
    elif overlap:
        tick, tick_why = 2.0, "solape Londres+NY — máxima actividad, tick más fino"
    else:
        tick, tick_why = 3.0, "sesión normal — cadencia estándar"

    poll_ms = 15000 if not is_open else 5000
    poll_why = "mercado cerrado — polling relajado" if not is_open else "mercado abierto — polling estándar"

    # Dead-man del snapshot relativo al baseline de ESTA hora: cadencia (30 min)
    # × 2 ciclos perdidos + p95 del pipeline, acotado [45, 90] min. Menos falsos
    # positivos en horas lentas conocidas, detección más rápida en horas rápidas.
    hb = baselines_hour.get(str(now.hour))
    if hb:
        deadman = max(45, min(90, 60 + int(hb["e2e_p95_ms"] / 60000) + 5))
        deadman_why = f"2 ciclos (60m) + p95 pipeline de las {now.hour:02d}h UTC ({int(hb['e2e_p95_ms']/1000)}s) + 5m margen"
    else:
        deadman = CURRENT["snapshot_deadman_min"]
        deadman_why = f"sin baseline para las {now.hour:02d}h UTC (n<{MIN_CYCLES_PER_HOUR}) — se mantiene el actual"

    recommendations = {
        "live_tick_secs": {"current": CURRENT["live_tick_secs"], "recommended": tick, "reason": tick_why},
        "frontend_poll_ms": {"current": CURRENT["frontend_poll_ms"], "recommended": poll_ms, "reason": poll_why},
        "snapshot_deadman_min": {"current": CURRENT["snapshot_deadman_min"], "recommended": deadman, "reason": deadman_why},
    }
    would_change = {k: v for k, v in recommendations.items() if v["recommended"] != v["current"]}

    tuning = {
        "generated_at": now.isoformat(),
        "mode": "shadow",
        "market_open": is_open,
        "baselines": {
            "e2e_by_hour_utc": baselines_hour,
            "recoveries_by_hour_utc_90d": recoveries_by_hour,
            "breaker_trips": breaker_trips,
        },
        "recommendations": recommendations,
    }
    TUNING.write_text(json.dumps(tuning, indent=2, ensure_ascii=False), encoding="utf-8")

    # Shadow log: evidencia para el veredicto de la semana (qué habría cambiado
    # y cuántas veces) — rolling para no crecer sin límite.
    lines = SHADOW_LOG.read_text(encoding="utf-8").splitlines() if SHADOW_LOG.exists() else []
    lines.append(json.dumps({
        "ts": now.isoformat(),
        "would_change": {k: v["recommended"] for k, v in would_change.items()},
    }, ensure_ascii=False))
    SHADOW_LOG.write_text("\n".join(lines[-SHADOW_LOG_MAX:]) + "\n", encoding="utf-8")

    print(
        f"[adaptive_tuner] shadow OK · baselines_hours={len(baselines_hour)} "
        f"market_open={is_open} would_change={sorted(would_change) or 'nada'}"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — telemetría jamás rompe el ciclo
        print(f"[adaptive_tuner] non-fatal: {exc}", file=sys.stderr)
        sys.exit(0)
