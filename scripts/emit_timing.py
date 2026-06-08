#!/usr/bin/env python3
"""
emit_timing.py — per-stage pipeline latency telemetry.

mirror.sh (the orchestrator) measures each stage's wall-clock and passes the
millisecond durations via env vars. This script:
  1. Pulls the rolling history (pipeline_timing_history.jsonl) from Supabase so
     p50/p95 accumulate across CI runs (data/ is gitignored, starts empty).
  2. Appends this cycle's row, trims to the last WINDOW cycles.
  3. Recomputes p50/p95 per stage.
  4. Writes data/pipeline_timing.json (read by the dashboard chip) +
     data/pipeline_timing_history.jsonl (both uploaded by upload_to_supabase.py).

This is the experiment that decides whether the post_merge enrichment cache is
worth building: if post_merge_ms stays well under ~90s, the cache attacks a
non-bottleneck and should NOT be built (per the engineering tribunal verdict).

Best-effort by contract: every failure path exits 0 so telemetry can never fail
a healthy cycle. mirror.sh also guards the call.
"""
from __future__ import annotations

import json
import os
import ssl
import sys
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ENV_FILE = ROOT / ".env.local"
HISTORY = DATA_DIR / "pipeline_timing_history.jsonl"
TIMING = DATA_DIR / "pipeline_timing.json"
BUCKET = "dashboard-data"
OBJ = "pipeline_timing_history.jsonl"
WINDOW = 200  # cycles kept for percentiles (~4 days at PT30M)

STAGES = [
    "mirror_ms", "reconcile_ms", "fetch_ledger_ms",
    "post_merge_ms", "verify_ms", "upload_ms", "end_to_end_ms",
]

try:
    import certifi  # type: ignore

    _CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _CTX = ssl.create_default_context()


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if not ENV_FILE.exists():
        return env
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def parse_lines(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass  # skip corrupt lines, never crash telemetry
    return out


def fetch_remote_history(env: dict[str, str]) -> list[dict]:
    url, skey = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not skey:
        return []
    endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{OBJ}"
    req = urlrequest.Request(endpoint, headers={"Authorization": f"Bearer {skey}", "apikey": skey})
    try:
        with urlrequest.urlopen(req, timeout=30, context=_CTX) as resp:
            return parse_lines(resp.read().decode("utf-8", errors="replace"))
    except urlerror.HTTPError as exc:
        if exc.code != 404:
            print(f"[emit_timing] HTTP {exc.code} fetching history — using local only", file=sys.stderr)
        return []
    except Exception as exc:  # noqa: BLE001
        print(f"[emit_timing] history fetch error: {exc} — using local only", file=sys.stderr)
        return []


def percentile(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    pos = q * (len(sorted_vals) - 1)
    lo = int(pos)
    frac = pos - lo
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac


def env_int(name: str) -> int:
    try:
        return max(0, int(os.environ.get(name, "0")))
    except ValueError:
        return 0


def main() -> int:
    import datetime

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    cycle = {
        "ts": now_iso,
        "mirror_ms": env_int("T_MIRROR_MS"),
        "reconcile_ms": env_int("T_RECONCILE_MS"),
        "fetch_ledger_ms": env_int("T_FETCH_LEDGER_MS"),
        "post_merge_ms": env_int("T_POSTMERGE_MS"),
        "verify_ms": env_int("T_VERIFY_MS"),
        "upload_ms": env_int("T_UPLOAD_MS"),
        "end_to_end_ms": env_int("T_E2E_MS"),
    }

    env = load_env()
    remote = fetch_remote_history(env)
    local = parse_lines(HISTORY.read_text(encoding="utf-8")) if HISTORY.exists() else []
    # Remote is the durable record; local on a CI runner is usually empty. Union by ts.
    seen = set()
    history: list[dict] = []
    for r in remote + local:
        t = r.get("ts")
        if t and t not in seen:
            seen.add(t)
            history.append(r)
    history.append(cycle)
    history.sort(key=lambda r: r.get("ts", ""))
    history = history[-WINDOW:]

    pct = {"p50": {}, "p95": {}}
    for stage in STAGES:
        vals = sorted(float(r[stage]) for r in history if isinstance(r.get(stage), (int, float)) and r.get(stage) > 0)
        pct["p50"][stage] = round(percentile(vals, 0.50))
        pct["p95"][stage] = round(percentile(vals, 0.95))

    out = {
        "generated_at": now_iso,
        "cycle": cycle,
        "p50": pct["p50"],
        "p95": pct["p95"],
        "samples": len(history),
        "window": WINDOW,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        TIMING.write_text(json.dumps(out, indent=2), encoding="utf-8")
        body = "\n".join(json.dumps(r, ensure_ascii=False) for r in history)
        HISTORY.write_text(body + ("\n" if body else ""), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        print(f"[emit_timing] write error: {exc}", file=sys.stderr)
        return 0
    print(f"[emit_timing] OK e2e={cycle['end_to_end_ms']}ms "
          f"mirror={cycle['mirror_ms']} post_merge={cycle['post_merge_ms']} "
          f"upload={cycle['upload_ms']} samples={len(history)}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — telemetry must never fail a cycle
        print(f"[emit_timing] unexpected error (ignored): {exc}", file=sys.stderr)
        sys.exit(0)
