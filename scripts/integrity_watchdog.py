#!/usr/bin/env python3
"""
integrity_watchdog.py — End-to-end Data Integrity verification for Kiz Capital
Battle of Bots dashboard. Runs every 30 min via Anthropic remote cron (skill
`battle-of-bots-integrity-check`), or on demand.

The CI pipeline (mirror.sh) already gates upload with verify_integrity.py --strict.
This watchdog adds a SECOND layer that verifies the live deploy — confirms what
landed in Supabase Storage IS what the dashboard will serve. Covers the window
between "CI passed" and "user sees the data".

Steps (exit non-zero on any FAIL):
  1. gh run list → latest refresh-dashboard conclusion=success
  2. gh run download → integrity-report artifact, validate ok=true
  3. Supabase Storage live integrity_report.json — exists + fresh
  4. HEAD probe ALL per-bot files in Supabase — zero 404s
  5. Vercel index.html — version pin matches (warn, not fail)

On FAIL:
  - Append failure line to data/integrity_health_log.jsonl
  - Create GitHub Issue (dedupe by date — one issue per UTC day; reopens if closed)

On PASS:
  - Append success line to data/integrity_health_log.jsonl
  - Exit 0, single-line summary to stdout

Usage:
  python3 integrity_watchdog.py              # full verification
  python3 integrity_watchdog.py --no-issue   # don't create GH issue on fail
  python3 integrity_watchdog.py --quiet      # only print FAIL details
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
DATA_DIR = ROOT / "data"
ENV_FILE = ROOT / ".env.local"
LOG_FILE = DATA_DIR / "integrity_health_log.jsonl"

BUCKET = "dashboard-data"
GH_REPO = "yody38/KizCapital-Battle-of-Bots"
WORKFLOW = "refresh-dashboard"
VERCEL_URL = "https://kiz-capital-bots-kiz-capital-battle-of-bots-projects.vercel.app/"

# Tolerance for Supabase report staleness vs CI run (seconds).
# CI run finish → upload completes within ~30s. We allow up to 15 min just
# in case the watchdog catches a moment when CI is mid-cycle.
STALE_TOLERANCE_SEC = 15 * 60


# ---------- env / helpers ----------

def load_env() -> dict[str, str]:
    """Read creds from process env first (CI), then .env.local (local manual runs)."""
    env: dict[str, str] = {}
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        v = os.environ.get(k)
        if v:
            env[k] = v
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except Exception:
        return None


# ---------- step 1: latest CI run ----------

def latest_ci_run() -> dict:
    out = subprocess.run(
        [
            "gh", "run", "list",
            "--workflow", WORKFLOW,
            "--repo", GH_REPO,
            "--limit", "1",
            "--json", "databaseId,status,conclusion,createdAt,updatedAt",
        ],
        check=True, capture_output=True, text=True, timeout=30,
    )
    runs = json.loads(out.stdout)
    if not runs:
        raise RuntimeError("no CI runs found")
    return runs[0]


# ---------- step 2: artifact ----------

def download_artifact(run_id: int, dest: Path) -> Path:
    name = f"integrity-report-{run_id}"
    dest.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "gh", "run", "download", str(run_id),
            "--repo", GH_REPO,
            "-n", name,
            "-D", str(dest),
        ],
        check=True, capture_output=True, text=True, timeout=60,
    )
    f = dest / "integrity_report.json"
    if not f.exists():
        raise RuntimeError(f"artifact {name} did not contain integrity_report.json")
    return f


# ---------- step 3 + 4: supabase ----------

def supa_request(url: str, key: str, path: str, method: str) -> tuple[int, bytes]:
    encoded = "/".join(path.split("/"))  # paths in this project don't contain spaces
    endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{encoded}"
    req = urlrequest.Request(
        endpoint,
        headers={"Authorization": f"Bearer {key}", "apikey": key},
        method=method,
    )
    try:
        with urlrequest.urlopen(req, timeout=30) as r:
            return r.status, r.read() if method == "GET" else b""
    except urlerror.HTTPError as e:
        return e.code, b""


def supa_get_json(url: str, key: str, path: str) -> tuple[int, dict | None]:
    code, body = supa_request(url, key, path, "GET")
    if code != 200:
        return code, None
    try:
        return code, json.loads(body)
    except Exception:
        return code, None


def head_all_bot_files(url: str, key: str, bots: list[dict]) -> list[tuple[str, int]]:
    """Returns list of (object_path, http_status) for any bot whose file did NOT return 200."""
    missing: list[tuple[str, int]] = []
    for b in bots:
        path = f"bots/{b['vps']}/{b['account_login']}-{b['magic']}.json"
        try:
            code, _ = supa_request(url, key, path, "HEAD")
        except Exception:
            code = -1
        if code != 200:
            missing.append((path, code))
    return missing


# ---------- step 5: vercel ----------

def vercel_version_pin() -> tuple[str | None, str | None]:
    """Returns (app_js_version, styles_css_version) parsed from index.html."""
    try:
        with urlrequest.urlopen(VERCEL_URL, timeout=15) as r:
            html = r.read().decode("utf-8", errors="replace")
    except Exception:
        return None, None
    app, css = None, None
    for line in html.splitlines():
        if "app.js?v=" in line:
            app = line.split("app.js?v=")[1].split('"')[0]
        elif "styles.css?v=" in line:
            css = line.split("styles.css?v=")[1].split('"')[0]
        if app and css:
            break
    return app, css


# ---------- GitHub Issue (dedupe by date) ----------

def file_issue_dedupe(title_root: str, body: str) -> str:
    """Create or update a GH issue. Title includes today's UTC date so we get
    at most one issue per day per kind. If an open issue with that title exists,
    append a comment instead of creating new."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    title = f"[integrity-watchdog] {title_root} — {today}"

    # Search existing — filter by label for structured dedupe, not title substring.
    try:
        out = subprocess.run(
            [
                "gh", "issue", "list", "--repo", GH_REPO,
                "--state", "open", "--label", "integrity-watchdog",
                "--json", "number,title",
            ],
            check=True, capture_output=True, text=True, timeout=30,
        )
        existing = json.loads(out.stdout)
    except Exception:
        existing = []
    match = next((i for i in existing if i.get("title") == title), None)

    if match:
        # Append comment
        try:
            subprocess.run(
                [
                    "gh", "issue", "comment", str(match["number"]),
                    "--repo", GH_REPO, "--body", body,
                ],
                check=True, capture_output=True, text=True, timeout=30,
            )
            return f"#{match['number']} (commented)"
        except Exception as e:
            return f"comment_failed: {e}"

    try:
        out = subprocess.run(
            [
                "gh", "issue", "create", "--repo", GH_REPO,
                "--title", title, "--body", body,
                "--label", "integrity-watchdog",
            ],
            check=True, capture_output=True, text=True, timeout=30,
        )
        # gh prints the issue URL on stdout
        url = out.stdout.strip().splitlines()[-1]
        num = url.rstrip("/").rsplit("/", 1)[-1]
        return f"#{num} (created)"
    except Exception as e:
        return f"create_failed: {e}"


# ---------- main ----------

def append_log(record: dict) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-issue", action="store_true", help="Skip GH issue creation on fail")
    parser.add_argument("--quiet", action="store_true", help="Only print on fail")
    args = parser.parse_args()

    started = time.time()
    fails: list[str] = []
    info: dict = {"ts": now_iso(), "steps": {}}

    # Step 1
    try:
        run = latest_ci_run()
        info["steps"]["ci"] = {
            "id": run["databaseId"],
            "status": run["status"],
            "conclusion": run.get("conclusion"),
            "updated_at": run.get("updatedAt"),
        }
        if run["status"] != "completed" or run.get("conclusion") != "success":
            fails.append(f"CI run #{run['databaseId']} status={run['status']} conclusion={run.get('conclusion')}")
    except Exception as e:
        info["steps"]["ci"] = {"error": str(e)}
        fails.append(f"ci_list_failed: {e}")

    ci_ok = not fails
    ci_run = info["steps"].get("ci", {}) if ci_ok else None

    # Step 2 — artifact (skip if no CI run id)
    artifact_report = None
    if ci_run and "id" in ci_run:
        try:
            dest = Path(f"/tmp/watchdog-art-{ci_run['id']}")
            f = download_artifact(ci_run["id"], dest)
            artifact_report = json.loads(f.read_text(encoding="utf-8"))
            info["steps"]["artifact"] = {
                "ok": artifact_report["ok"],
                "bots_checked": artifact_report["bots_checked"],
                "bots_failed": artifact_report["bots_failed"],
            }
            if not artifact_report["ok"]:
                fails.append(f"artifact report ok=false bots_failed={artifact_report['bots_failed']}")
        except Exception as e:
            info["steps"]["artifact"] = {"error": str(e)}
            fails.append(f"artifact_download_failed: {e}")

    # Step 3 — Supabase integrity_report
    env = load_env()
    url, key = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        fails.append("supabase_creds_missing (.env.local)")
        info["steps"]["supabase"] = {"error": "creds_missing"}
    else:
        code, supa_report = supa_get_json(url, key, "integrity_report.json")
        if code != 200 or not supa_report:
            fails.append(f"supabase integrity_report fetch http={code}")
            info["steps"]["supabase"] = {"http": code}
        else:
            info["steps"]["supabase"] = {
                "ok": supa_report["ok"],
                "bots_checked": supa_report["bots_checked"],
                "generated_at": supa_report["generated_at"],
            }
            if not supa_report["ok"]:
                fails.append("supabase integrity_report ok=false")
            # Freshness vs CI run finish time
            if ci_run and ci_run.get("updated_at"):
                ci_t = parse_iso(ci_run["updated_at"])
                supa_t = parse_iso(supa_report.get("generated_at"))
                if ci_t and supa_t:
                    lag = (ci_t - supa_t).total_seconds()
                    info["steps"]["supabase"]["lag_sec"] = lag
                    if lag > STALE_TOLERANCE_SEC:
                        fails.append(f"supabase stale: {int(lag)}s behind CI run")

        # Step 4 — HEAD probe per-bot files
        code, snap = supa_get_json(url, key, "snapshot.json")
        if code != 200 or not snap:
            fails.append(f"supabase snapshot.json fetch http={code}")
            info["steps"]["files"] = {"error": f"snapshot_http={code}"}
        else:
            bots = [b for b in snap.get("bots", []) if b.get("magic", 0) != 0]
            missing = head_all_bot_files(url, key, bots)
            info["steps"]["files"] = {
                "total": len(bots),
                "missing": len(missing),
                "samples": [f"{p}={c}" for p, c in missing[:5]],
            }
            if missing:
                fails.append(f"supabase missing files: {len(missing)} of {len(bots)}")

    # Step 5 — Vercel version pin (warn only)
    app_v, css_v = vercel_version_pin()
    info["steps"]["vercel"] = {"app_js": app_v, "styles_css": css_v}

    duration_ms = int((time.time() - started) * 1000)
    info["duration_ms"] = duration_ms
    info["result"] = "ok" if not fails else "fail"
    info["fails"] = fails

    append_log(info)

    if not fails:
        if not args.quiet:
            s = info["steps"]
            files = s.get("files", {})
            print(
                f"[watchdog] ok ci=#{(s.get('ci') or {}).get('id','?')} "
                f"files={files.get('total','?')}/{files.get('total','?')} "
                f"vercel={app_v or '?'} {duration_ms}ms"
            )
        return 0

    # FAIL path
    body_lines = [
        f"**Watchdog detected drift at {info['ts']}**",
        "",
        "## Fails",
        *[f"- {f}" for f in fails],
        "",
        "## Steps",
        f"```json\n{json.dumps(info['steps'], indent=2)}\n```",
        "",
        f"_Reproducer:_ `python3 'Battle of Bots/scripts/integrity_watchdog.py'`",
    ]
    issue_ref = "skipped"
    if not args.no_issue:
        issue_ref = file_issue_dedupe("drift detected", "\n".join(body_lines))
    print(f"[watchdog] FAIL fails={len(fails)} issue={issue_ref} {duration_ms}ms", file=sys.stderr)
    for f in fails:
        print(f"  - {f}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
