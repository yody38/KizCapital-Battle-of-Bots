#!/usr/bin/env python3
"""
heartbeat_check.py — Out-of-band sync health monitor for Kiz Capital Battle of Bots.

Runs on the Mac via launchd every 10 min. Independent of GitHub Actions, so it
keeps watching even when Actions is fully blocked (billing, outage, etc.).

What it does each tick:
  1. Fetch integrity_report.json from Supabase Storage.
  2. Compare generated_at vs now → compute lag.
  3. Classify: OK / WARN / FAIL based on thresholds.
  4. Append to data/heartbeat_log.jsonl (rotated daily by post_merge.py).
  5. WARN → send email (dedupe 60 min).
     FAIL → send email (dedupe 30 min) + trigger dispatch_refresh.py.
  6. Once per hour also runs integrity_watchdog.py --no-issue --quiet as a
     second witness; if its result is FAIL too while heartbeat is FAIL,
     send a "double confirmation" email.

Exit codes: 0 ok | 1 warn | 2 fail
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
DATA = ROOT / "data"
LOG = DATA / "heartbeat_log.jsonl"
LEARN_LOG = DATA / "learning_events.jsonl"

# Reuse helpers from integrity_watchdog to avoid duplication.
sys.path.insert(0, str(SCRIPTS))
from integrity_watchdog import (  # type: ignore
    load_env,
    supa_get_json,
    parse_iso,
)

WARN_LAG_MIN = 35   # > snapshot interval (30 min) + small grace
FAIL_LAG_MIN = 65   # 2 missed cycles
DEDUPE_WARN_MIN = 60
DEDUPE_FAIL_MIN = 30

VERCEL_URL = "https://kiz-capital-bots-kiz-capital-battle-of-bots-projects.vercel.app/"
GH_REPO = "yody38/KizCapital-Battle-of-Bots"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now_utc().isoformat(timespec="seconds")


def append_log(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def send_alert(subject: str, body: str, dedupe_key: str, window_min: int) -> str:
    """Call alert_email.py — returns its stdout line for logging."""
    try:
        out = subprocess.run(
            [sys.executable, str(SCRIPTS / "alert_email.py"),
             "--subject", subject,
             "--body", body,
             "--dedupe-key", dedupe_key,
             "--dedupe-window-min", str(window_min)],
            check=False, capture_output=True, text=True, timeout=60,
        )
        return (out.stdout or out.stderr).strip().splitlines()[-1] if (out.stdout or out.stderr) else f"rc={out.returncode}"
    except Exception as e:
        return f"alert_call_failed: {e}"


def trigger_dispatch_refresh() -> str:
    """Spawn dispatch_refresh.py in background. Returns one-line status."""
    try:
        proc = subprocess.Popen(
            [sys.executable, str(SCRIPTS / "dispatch_refresh.py"),
             "--reason", "heartbeat_fail",
             "--max-attempts", "3",
             "--gap-sec", "240"],
            stdout=open(DATA / "dispatch_refresh.out.log", "a"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        return f"dispatch_refresh.py pid={proc.pid}"
    except FileNotFoundError:
        return "dispatch_refresh.py not yet installed (skipped)"
    except Exception as e:
        return f"dispatch_spawn_failed: {e}"


def run_secondary_watchdog() -> tuple[str, str]:
    """Call integrity_watchdog.py --no-issue --quiet. Returns (result, summary)."""
    try:
        out = subprocess.run(
            [sys.executable, str(SCRIPTS / "integrity_watchdog.py"),
             "--no-issue", "--quiet"],
            check=False, capture_output=True, text=True, timeout=180,
        )
        result = "ok" if out.returncode == 0 else "fail"
        summary = (out.stdout or out.stderr).strip().splitlines()[-1] if (out.stdout or out.stderr) else ""
        return result, summary
    except Exception as e:
        return "error", str(e)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--simulate-lag-min", type=int, default=0,
                   help="Force a lag for testing (does not query Supabase).")
    p.add_argument("--no-email", action="store_true",
                   help="Compute state but don't send any email or trigger fallback.")
    p.add_argument("--no-recovery", action="store_true",
                   help="Send alerts but don't trigger dispatch_refresh.")
    args = p.parse_args()

    record: dict = {"ts": now_iso(), "result": "unknown"}

    if args.simulate_lag_min > 0:
        lag_sec = args.simulate_lag_min * 60
        record["simulated"] = True
        record["lag_sec"] = lag_sec
        record["report"] = {"ok": True, "bots_checked": 0, "bots_failed": 0,
                            "generated_at": (now_utc().timestamp() - lag_sec)}
    else:
        env = load_env()
        url, key = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            record["result"] = "fail"
            record["error"] = "supabase_creds_missing"
            append_log(LOG, record)
            if not args.no_email:
                send_alert(
                    "[Kiz Capital] heartbeat FAIL — supabase creds missing on Mac",
                    f"{now_iso()}: heartbeat_check.py could not read SUPABASE_URL / "
                    f"SUPABASE_SERVICE_ROLE_KEY from env or .env.local. Verify "
                    f"{ROOT / '.env.local'} permissions and contents.",
                    "heartbeat_creds_missing", DEDUPE_FAIL_MIN,
                )
            return 2
        code, report = supa_get_json(url, key, "integrity_report.json")
        if code != 200 or not report:
            record["result"] = "fail"
            record["error"] = f"supa_http={code}"
            append_log(LOG, record)
            if not args.no_email:
                send_alert(
                    "[Kiz Capital] heartbeat FAIL — supabase fetch error",
                    f"{now_iso()}: GET integrity_report.json returned HTTP {code}. "
                    "Supabase Storage may be down, key revoked, or bucket renamed.",
                    "heartbeat_supa_http", DEDUPE_FAIL_MIN,
                )
            return 2
        gen_t = parse_iso(report.get("generated_at"))
        if not gen_t:
            record["result"] = "fail"
            record["error"] = "report_missing_generated_at"
            append_log(LOG, record)
            return 2
        lag_sec = (now_utc() - gen_t).total_seconds()
        record["lag_sec"] = lag_sec
        record["report"] = {
            "ok": report.get("ok"),
            "bots_checked": report.get("bots_checked"),
            "bots_failed": report.get("bots_failed"),
            "generated_at": report.get("generated_at"),
        }
        if not report.get("ok"):
            record["report_ok_false"] = True

    lag_min = record["lag_sec"] / 60

    # Hourly cross-witness: at the top of each hour, run integrity_watchdog
    # locally as an independent verifier of the live deploy. This catches
    # subtle issues the lag-based check would miss (e.g., uploads succeeded
    # but per-bot files are 404).
    if not args.no_email and now_utc().minute < 10:
        sec_result, sec_summary = run_secondary_watchdog()
        record.setdefault("secondary_watchdog", {})["hourly"] = {
            "result": sec_result, "summary": sec_summary
        }
        if sec_result == "fail" and (record.get("report") or {}).get("ok") is not False:
            # Heartbeat says OK but watchdog disagrees — surface as warn email.
            send_alert(
                "[Kiz Capital] heartbeat OK but watchdog FAIL — drift suspected",
                f"{now_iso()}: lag={lag_min:.1f}min (under threshold) but "
                f"local integrity_watchdog.py reports FAIL.\n\n"
                f"Watchdog summary: {sec_summary}\n\n"
                "Likely a per-bot file is missing or integrity_report.json itself "
                "is stale on Supabase. Investigate.",
                "heartbeat_watchdog_disagree", 60,
            )

    # Classify
    if lag_min <= WARN_LAG_MIN and record.get("report", {}).get("ok") is not False:
        record["result"] = "ok"
        append_log(LOG, record)
        print(f"[heartbeat] ok lag={lag_min:.1f}min bots={record['report'].get('bots_checked','?')}")
        return 0

    if lag_min <= FAIL_LAG_MIN:
        record["result"] = "warn"
        body = (
            f"{now_iso()}: dashboard sync lag = {lag_min:.1f} min "
            f"(warn threshold {WARN_LAG_MIN} min, fail at {FAIL_LAG_MIN} min).\n\n"
            f"Last integrity_report:\n{json.dumps(record.get('report'), indent=2)}\n\n"
            f"Next heartbeat in ~10 min. If lag crosses {FAIL_LAG_MIN} min, "
            "auto-recovery (repository_dispatch) will trigger.\n\n"
            f"GH Actions: https://github.com/{GH_REPO}/actions\n"
            f"Dashboard:  {VERCEL_URL}"
        )
        append_log(LOG, record)
        if not args.no_email:
            sent = send_alert(
                f"[Kiz Capital] heartbeat WARN — lag {lag_min:.0f}min",
                body, "heartbeat_warn", DEDUPE_WARN_MIN,
            )
            record["alert"] = sent
        print(f"[heartbeat] WARN lag={lag_min:.1f}min")
        return 1

    # FAIL — alert + recover
    record["result"] = "fail"
    record["lag_min"] = round(lag_min, 1)
    sec_result, sec_summary = ("skipped", "")
    if not args.no_email:
        sec_result, sec_summary = run_secondary_watchdog()
        record["secondary_watchdog"] = {"result": sec_result, "summary": sec_summary}

    body = (
        f"{now_iso()}: dashboard sync FAIL — lag = {lag_min:.1f} min "
        f"(threshold {FAIL_LAG_MIN} min, ~2+ missed cycles).\n\n"
        f"Last integrity_report:\n{json.dumps(record.get('report'), indent=2)}\n\n"
        f"Secondary watchdog (integrity_watchdog.py): {sec_result} — {sec_summary}\n\n"
        "Triggering dispatch_refresh.py (auto-recovery, up to 3 attempts).\n"
        "If this persists, check:\n"
        f"  1. GitHub Actions billing: https://github.com/settings/billing\n"
        f"  2. GH Actions runs:        https://github.com/{GH_REPO}/actions\n"
        f"  3. Supabase Storage live:  {VERCEL_URL}\n"
    )
    append_log(LOG, record)
    if not args.no_email:
        sent = send_alert(
            f"[Kiz Capital] heartbeat FAIL — lag {lag_min:.0f}min, recovering",
            body, "heartbeat_fail", DEDUPE_FAIL_MIN,
        )
        record["alert"] = sent
    if not (args.no_email or args.no_recovery):
        record["recovery"] = trigger_dispatch_refresh()
        # Append a learning event for the runbook builder.
        append_log(LEARN_LOG, {
            "ts": now_iso(),
            "symptom": f"heartbeat_lag_min={lag_min:.0f}",
            "action": record["recovery"],
            "result": "recovery_triggered",
            "secondary_witness": sec_result,
        })
        # Regenerate RUNBOOK.md so the user sees the latest pattern history.
        try:
            subprocess.run(
                [sys.executable, str(SCRIPTS / "promote_to_runbook.py")],
                check=False, capture_output=True, text=True, timeout=30,
            )
        except Exception:
            pass
    print(f"[heartbeat] FAIL lag={lag_min:.1f}min recovery={record.get('recovery','-')}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
