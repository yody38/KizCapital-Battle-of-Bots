#!/usr/bin/env python3
"""
dispatch_refresh.py — Auto-recovery executor.

Called by heartbeat_check.py when sync lag exceeds FAIL threshold. Triggers
GitHub Actions refresh-dashboard via repository_dispatch (same mechanism the
VPS1 cron uses), waits, and re-checks Supabase. Retries N times.

Independent of GitHub Actions execution path BUT relies on gh CLI auth, which
the user has configured. If GH Actions is blocked (e.g., billing), the dispatch
call still SUCCEEDS at API level (it queues the workflow) but the workflow run
will fail in 2-3 seconds with the billing message — in that case we send a
clear "billing-blocked" email and stop retrying.

Usage:
    dispatch_refresh.py [--reason str] [--max-attempts 3] [--gap-sec 240]
                        [--allow-local-mirror]   # opt-in nuclear fallback

Exit codes: 0 dashboard recovered | 1 attempts exhausted | 2 hard error
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

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
DATA = ROOT / "data"
LOG = DATA / "dispatch_refresh_log.jsonl"
LEARN_LOG = DATA / "learning_events.jsonl"

sys.path.insert(0, str(SCRIPTS))
from integrity_watchdog import load_env, supa_get_json, parse_iso  # type: ignore

GH_REPO = "yody38/KizCapital-Battle-of-Bots"
EVENT_TYPE = "refresh-dashboard"
ALERT = SCRIPTS / "alert_email.py"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now_utc().isoformat(timespec="seconds")


def log(record: dict) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def email(subject: str, body: str, dedupe: str, win: int) -> None:
    try:
        subprocess.run(
            [sys.executable, str(ALERT),
             "--subject", subject, "--body", body,
             "--dedupe-key", dedupe, "--dedupe-window-min", str(win)],
            check=False, capture_output=True, text=True, timeout=60,
        )
    except Exception:
        pass


def dispatch_once() -> tuple[bool, str]:
    """Returns (api_call_ok, msg). API-ok means GH accepted the dispatch; the
    workflow itself may still fail (e.g., billing)."""
    try:
        out = subprocess.run(
            ["gh", "api", "--method", "POST",
             f"repos/{GH_REPO}/dispatches",
             "-f", f"event_type={EVENT_TYPE}"],
            check=False, capture_output=True, text=True, timeout=30,
        )
        if out.returncode == 0:
            return True, "dispatch accepted"
        return False, f"gh rc={out.returncode}: {out.stderr.strip()[:200]}"
    except FileNotFoundError:
        return False, "gh CLI not installed"
    except Exception as e:
        return False, f"dispatch error: {e}"


def latest_run_status() -> dict:
    """Returns latest refresh-dashboard run summary (best-effort)."""
    try:
        out = subprocess.run(
            ["gh", "run", "list", "--repo", GH_REPO,
             "--workflow", "refresh-dashboard",
             "--limit", "1",
             "--json", "databaseId,status,conclusion,createdAt,event"],
            check=False, capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            return {"error": out.stderr.strip()[:200]}
        runs = json.loads(out.stdout or "[]")
        return runs[0] if runs else {}
    except Exception as e:
        return {"error": str(e)}


def latest_run_billing_blocked() -> bool:
    """Check if the latest failed run was blocked by billing. Looks at
    annotations of the last run."""
    try:
        out = subprocess.run(
            ["gh", "run", "list", "--repo", GH_REPO,
             "--workflow", "refresh-dashboard",
             "--limit", "1",
             "--json", "databaseId,conclusion"],
            check=False, capture_output=True, text=True, timeout=30,
        )
        runs = json.loads(out.stdout or "[]")
        if not runs or runs[0].get("conclusion") != "failure":
            return False
        rid = runs[0]["databaseId"]
        view = subprocess.run(
            ["gh", "run", "view", str(rid), "--repo", GH_REPO],
            check=False, capture_output=True, text=True, timeout=30,
        )
        text = view.stdout + view.stderr
        return "recent account payments have failed" in text or "spending limit" in text
    except Exception:
        return False


def supabase_lag_min() -> float | None:
    env = load_env()
    url, key = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None
    code, rep = supa_get_json(url, key, "integrity_report.json")
    if code != 200 or not rep:
        return None
    gen_t = parse_iso(rep.get("generated_at"))
    if not gen_t:
        return None
    return (now_utc() - gen_t).total_seconds() / 60


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--reason", default="manual")
    p.add_argument("--max-attempts", type=int, default=3)
    p.add_argument("--gap-sec", type=int, default=240)
    p.add_argument("--allow-local-mirror", action="store_true",
                   help="If GH dispatch path fails, run mirror.sh locally on Mac.")
    args = p.parse_args()

    started = now_iso()
    record = {"ts": started, "reason": args.reason, "attempts": []}

    for attempt in range(1, args.max_attempts + 1):
        ok, msg = dispatch_once()
        attempt_rec = {"n": attempt, "ts": now_iso(), "dispatch_ok": ok, "msg": msg}
        if not ok:
            attempt_rec["abort"] = "dispatch_api_failed"
            record["attempts"].append(attempt_rec)
            log(record)
            email(
                "[Kiz Capital] dispatch_refresh FAIL — cannot trigger GH workflow",
                f"{now_iso()}: gh api dispatches returned error.\nDetails: {msg}\n\n"
                "Common causes: gh auth expired, network down, repo access revoked.\n"
                "Recover: gh auth login --hostname github.com",
                "dispatch_gh_api_fail", 60,
            )
            return 2

        time.sleep(min(args.gap_sec, 600))

        # Check if the run that we triggered is failing due to billing.
        if latest_run_billing_blocked():
            attempt_rec["billing_blocked"] = True
            record["attempts"].append(attempt_rec)
            log(record)
            email(
                "[Kiz Capital] GH Actions BILLING BLOCKED — manual fix needed",
                f"{now_iso()}: dispatch triggered but workflow failed in 2-3s with "
                "'recent account payments have failed' / 'spending limit'.\n\n"
                "FIX: https://github.com/settings/billing\n\n"
                f"Last run: https://github.com/{GH_REPO}/actions\n\n"
                "Auto-recovery is paused until billing is restored. Heartbeat will "
                "continue monitoring and alert again in 30 min if still down.",
                "dispatch_billing_blocked", 30,
            )
            append_learning("gh_billing_blocked", f"attempt={attempt}", "alert_user")
            if args.allow_local_mirror:
                rc = run_local_mirror()
                attempt_rec["local_mirror_rc"] = rc
                log(record)
                if rc == 0:
                    return 0
            return 1

        lag = supabase_lag_min()
        attempt_rec["post_lag_min"] = lag
        record["attempts"].append(attempt_rec)
        if lag is not None and lag <= 35:
            log(record)
            email(
                "[Kiz Capital] dispatch_refresh — RECOVERED",
                f"{now_iso()}: dashboard sync recovered after attempt {attempt}. "
                f"Current lag: {lag:.1f} min.",
                "dispatch_recovered", 30,
            )
            append_learning(f"recovery_attempt_{attempt}",
                            f"trigger=repository_dispatch lag_min={lag:.1f}",
                            "auto_recovered")
            return 0

    log(record)
    email(
        "[Kiz Capital] dispatch_refresh EXHAUSTED — manual intervention",
        f"{now_iso()}: {args.max_attempts} attempts each spaced {args.gap_sec}s. "
        f"Dashboard still stale.\n\nLog tail:\n{json.dumps(record, indent=2)[:2000]}",
        "dispatch_exhausted", 30,
    )
    if args.allow_local_mirror:
        rc = run_local_mirror()
        if rc == 0:
            return 0
    return 1


def run_local_mirror() -> int:
    """Last-resort: execute mirror.sh locally on the Mac.
    Requires Tailscale up + SSH key reachable. Gated by --allow-local-mirror."""
    try:
        out = subprocess.run(
            ["bash", str(ROOT / "scripts" / "mirror.sh")],
            check=False, capture_output=True, text=True, timeout=900,
        )
        record = {
            "ts": now_iso(),
            "kind": "local_mirror",
            "rc": out.returncode,
            "tail_stdout": (out.stdout or "")[-500:],
            "tail_stderr": (out.stderr or "")[-500:],
        }
        log(record)
        append_learning("local_mirror", f"rc={out.returncode}",
                        "ok" if out.returncode == 0 else "fail")
        return out.returncode
    except Exception as e:
        log({"ts": now_iso(), "kind": "local_mirror", "error": str(e)})
        return 99


def append_learning(symptom: str, action: str, result: str) -> None:
    LEARN_LOG.parent.mkdir(parents=True, exist_ok=True)
    with LEARN_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps({
            "ts": now_iso(),
            "symptom": symptom,
            "action": action,
            "result": result,
        }) + "\n")


if __name__ == "__main__":
    sys.exit(main())
