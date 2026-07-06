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

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from alert_telegram import send as tg_send
except Exception:  # alerting must never break the watchdog
    def tg_send(text, **kw):  # type: ignore[misc]
        return "unavailable"

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
MCP_DEADMAN_SEC = 90 * 60  # mcp-health is dispatched ~every 30min (VPS1 dispatch_ci.ps1, like
                           # refresh/watchdog). GH free-tier cron */5 is throttled to ~2h and is
                           # only a backstop, so 20min was a guaranteed false positive. 90min =
                           # tolerate 2 missed dispatch cycles, still catch a dead monitor in <1.5h.
LIVE_DEADMAN_SEC = 90      # live stream pushes every ~3s → >90s stale = worker/tailnet/MT5 dead
LIVE_REAL_LOGINS = {25425, 32081, 43306, 43411, 43414}  # 5 reales en vivo: 32081/43306 (VPS5) + 25425/43411/43414 (VPS6); roster por VPS en C:\mt5-mcp\.live_publisher.env


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

def latest_ci_runs() -> list[dict]:
    out = subprocess.run(
        [
            "gh", "run", "list",
            "--workflow", WORKFLOW,
            "--repo", GH_REPO,
            "--limit", "5",
            "--json", "databaseId,status,conclusion,createdAt,updatedAt",
        ],
        check=True, capture_output=True, text=True, timeout=30,
    )
    runs = json.loads(out.stdout)
    if not runs:
        raise RuntimeError("no CI runs found")
    return runs


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
        # Push alert ONLY on creation (1/day by dedupe) — same-day comments stay
        # silent to respect the daily alert budget.
        tg = tg_send(f"🟠 integrity drift: {title_root}\n{body[:600]}\nIssue #{num}",
                     source="integrity-watchdog")
        print(f"[watchdog] telegram={tg}")
        return f"#{num} (created)"
    except Exception as e:
        return f"create_failed: {e}"


# ---------- main ----------

def append_log(record: dict) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def upload_health_to_supabase(url: str, key: str, record: dict) -> None:
    """Persist watchdog results to Storage so the dashboard's 'Salud del
    sistema' panel can show real uptime history. The GH Actions workspace is
    ephemeral (fresh checkout per run), so the local jsonl never accumulates —
    Storage is the durable store. Best-effort: never fails the watchdog.

      watchdog_status.json  — full record of the LATEST run
      watchdog_history.json — rolling 30d list of {ts, result, fails, duration_ms}
    """
    def _put(path: str, payload) -> None:
        endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{path}"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urlrequest.Request(
            endpoint,
            data=body,
            headers={
                "Authorization": f"Bearer {key}",
                "apikey": key,
                "Content-Type": "application/json",
                "x-upsert": "true",
            },
            method="POST",
        )
        with urlrequest.urlopen(req, timeout=30):
            pass

    try:
        _put("watchdog_status.json", record)

        _, history = supa_get_json(url, key, "watchdog_history.json")
        if not isinstance(history, list):
            history = []
        history.append({
            "ts": record.get("ts"),
            "result": record.get("result"),
            "fails": record.get("fails") or [],
            "duration_ms": record.get("duration_ms"),
        })
        cutoff = datetime.now(timezone.utc).timestamp() - 30 * 86400
        pruned = []
        for h in history:
            t = parse_iso(h.get("ts"))
            if t and t.timestamp() >= cutoff:
                pruned.append(h)
        _put("watchdog_history.json", pruned)
    except Exception as e:  # noqa: BLE001
        print(f"[watchdog] health upload failed (non-fatal): {e}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-issue", action="store_true", help="Skip GH issue creation on fail")
    parser.add_argument("--quiet", action="store_true", help="Only print on fail")
    args = parser.parse_args()

    started = time.time()
    fails: list[str] = []
    info: dict = {"ts": now_iso(), "steps": {}}
    dormant_eas: list[dict] = []  # "competencia siempre activa" monitor (separate alert)

    # Step 1
    completed_run = None
    try:
        runs = latest_ci_runs()
        run = runs[0]
        info["steps"]["ci"] = {
            "id": run["databaseId"],
            "status": run["status"],
            "conclusion": run.get("conclusion"),
            "updated_at": run.get("updatedAt"),
        }
        if run["status"] == "in_progress" or run["status"] == "queued":
            # Race: watchdog fired while CI is mid-cycle. Not a real drift —
            # the previous successful cycle's data is still serving the dashboard.
            # Steps 2/3 audit the newest COMPLETED run instead of the in-flight one.
            info["steps"]["ci"]["note"] = "pending — auditing previous completed run (race)"
        elif run["status"] != "completed" or run.get("conclusion") != "success":
            fails.append(f"CI run #{run['databaseId']} status={run['status']} conclusion={run.get('conclusion')}")
        completed_run = next(
            (r for r in runs if r["status"] == "completed" and r.get("conclusion") == "success"),
            None,
        )
        if completed_run and completed_run["databaseId"] != run["databaseId"]:
            info["steps"]["ci"]["audited_run"] = completed_run["databaseId"]
    except Exception as e:
        info["steps"]["ci"] = {"error": str(e)}
        fails.append(f"ci_list_failed: {e}")

    ci_ok = not fails
    ci_run = None
    if ci_ok and completed_run:
        ci_run = {"id": completed_run["databaseId"], "updated_at": completed_run.get("updatedAt")}

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

            # gate on the 'upload' subsection written by upload_to_supabase.py —
            # verify runs BEFORE upload, so integrity ok can be true while the
            # upload is stuck. Without this the UPLOAD_STUCK signal never alerts.
            up = supa_report.get("upload")
            if up is None:
                fails.append("supabase integrity_report missing 'upload' section (re-upload failed or stale)")
            elif not up.get("ok", True):
                fails.append(
                    f"upload not ok: failed={up.get('failed')} stuck={up.get('stuck_count')} "
                    f"classes={up.get('fail_by_class')}"
                )
            info["steps"]["upload"] = up

        # Step 4 — HEAD probe per-bot files
        code, snap = supa_get_json(url, key, "snapshot.json")
        if code != 200 or not snap:
            fails.append(f"supabase snapshot.json fetch http={code}")
            info["steps"]["files"] = {"error": f"snapshot_http={code}"}
        else:
            # Pipeline wall-clock dead-man: if the whole cron/CI died, the deployed
            # snapshot.generated_at stops advancing (the vps_freshness inside it is
            # frozen, so it cannot self-detect this). Precedent: mcp-health dead 12d.
            snap_t = parse_iso(snap.get("generated_at"))
            snap_age = (datetime.now(timezone.utc) - snap_t).total_seconds() if snap_t else None
            info["steps"]["snapshot_age_sec"] = int(snap_age) if snap_age is not None else None
            if snap_age is None:
                fails.append("supabase snapshot.json has no parseable generated_at")
            elif snap_age > 90 * 60:
                fails.append(f"pipeline dead-man: snapshot {int(snap_age/60)}min old (>90min — cron/CI stalled)")
            bots = [b for b in snap.get("bots", []) if b.get("magic", 0) != 0]
            missing = head_all_bot_files(url, key, bots)
            info["steps"]["files"] = {
                "total": len(bots),
                "missing": len(missing),
                "samples": [f"{p}={c}" for p, c in missing[:5]],
            }
            if missing:
                fails.append(f"supabase missing files: {len(missing)} of {len(bots)}")
            # Per-VPS freshness emitted by post_merge.py — surface stale VPSs
            # in the issue body so triage is one click instead of a grep.
            vf = snap.get("vps_freshness") or {}
            stale_vps = []
            for v_id in sorted(vf.keys()):
                v = vf[v_id] or {}
                if not v.get("present"):
                    stale_vps.append(f"{v_id}=missing")
                elif v.get("stale"):
                    lag_min = round((v.get("lag_sec") or 0) / 60, 1)
                    stale_vps.append(f"{v_id}={lag_min}min")
            info["steps"]["vps_freshness"] = {
                "summary": {k: {"lag_min": round((vf[k].get("lag_sec") or 0) / 60, 1),
                                 "stale": bool(vf[k].get("stale"))}
                            for k in vf if vf[k].get("present")},
                "stale": stale_vps,
                "partial_data": bool(snap.get("partial_data")),
            }
            if stale_vps:
                fails.append(f"stale VPSs: {', '.join(stale_vps)}")
            # Carry-forward escalation: a VPS carried from last-good data is fine for
            # a few cycles (graceful degradation), but data frozen too long must alarm
            # — it means the VPS never recovered. Demo: >3h. Real (vps5): >35min.
            for v_id in sorted(vf.keys()):
                v = vf[v_id] or {}
                if v.get("carried_forward"):
                    lag = v.get("lag_sec") or 0
                    cap = 35 * 60 if v_id == "vps5" else 3 * 3600
                    if lag > cap:
                        fails.append(f"carry-forward too long: {v_id} frozen {round(lag/60)}min (>{round(cap/60)}min — VPS never recovered)")

            # Step 4c — "competencia siempre activa" monitor. A demo EA that WAS an
            # established competitor (trades ≥ 30) but stopped trading (post_merge flags
            # dormant / days_since_last_trade) has detached/crashed on its VPS. Not data
            # corruption → does NOT hard-fail integrity; raises its OWN deduped issue so
            # the competition field stays full & live.
            real_magics = set(snap.get("real_magics") or [])
            for b in snap.get("bots", []):
                if (b.get("magic", 0) != 0
                        and b.get("magic") not in real_magics
                        and (b.get("trades") or 0) >= 30
                        and b.get("dormant")):
                    dormant_eas.append({
                        "magic": b.get("magic"),
                        "vps": b.get("vps"),
                        "account": b.get("account_login"),
                        "symbol": (b.get("symbols") or [None])[0],
                        "days_since_last_trade": b.get("days_since_last_trade"),
                    })
            dormant_eas.sort(key=lambda d: -(d.get("days_since_last_trade") or 0))
            info["steps"]["dormant_eas"] = {"count": len(dormant_eas), "samples": dormant_eas[:8]}

        # Step 4b — MCP-health monitor liveness. A stale checked_at means the
        # MONITOR died (VPS1 dispatcher down + GH cron throttled), not the
        # product: Step 4's pipeline dead-man (snapshot.generated_at > 90min)
        # already hard-fails when the DATA stops advancing, with no dispatcher
        # dependency. So monitor staleness is warn-only (surfaced in the issue
        # body / health log), per kiz-tribunal verdict on c95ef57 — it must not
        # page the inbox while the data is provably fresh. An ABSENT file is
        # still a hard fail (monitor never deployed — the 12-day blind spot
        # 2026-05-26 → 2026-06-07), and any_critical stays a hard fail (real
        # VPS down/stale, already debounced by FAIL_THRESHOLD=2 upstream).
        now = datetime.now(timezone.utc)
        code, mcp = supa_get_json(url, key, "mcp_health.json")
        if code != 200 or not mcp:
            fails.append(f"mcp_health.json fetch http={code} (MCP monitor dead/undeployed?)")
            info["steps"]["mcp_health"] = {"http": code}
        else:
            checked = parse_iso(mcp.get("checked_at") or mcp.get("generated_at"))
            age = (now - checked).total_seconds() if checked else None
            info["steps"]["mcp_health"] = {
                "summary": mcp.get("summary"),
                "checked_at": mcp.get("checked_at"),
                "age_sec": int(age) if age is not None else None,
                "any_critical": mcp.get("any_critical"),
            }
            if age is None:
                fails.append("mcp_health.json has no parseable checked_at")
            elif age > MCP_DEADMAN_SEC:
                info["steps"]["mcp_health"]["stale_warn"] = (
                    f"monitor last ran {int(age/60)}min ago (>{MCP_DEADMAN_SEC//60}min) — "
                    "monitor-health warn only; data freshness is gated by Step 4"
                )
            if mcp.get("any_critical"):
                # summary is "<ok>/<total>" — name the DOWN ones, not the OK count.
                down = sorted(
                    v for v, d in (mcp.get("vps") or {}).items()
                    if isinstance(d, dict) and d.get("status") not in ("ok", "warn")
                )
                total = mcp.get("total") or len(mcp.get("vps") or {}) or "?"
                fails.append(f"mcp-health critical: {len(down)}/{total} VPS down ({', '.join(down) or 'unknown'})")

        # Step 4b — Live equity stream freshness (the 2 REAL accounts). This is the
        # only pipeline without its own watchdog; if it dies (Railway down, TS
        # authkey expired, SSH hung), the dashboard silently falls back to the
        # 30-min snapshot. Verify BOTH real logins are fresh — full denominator,
        # not "if one lives they all live".
        try:
            ep = f"{url.rstrip('/')}/rest/v1/live_real_state?select=login,ts"
            req = urlrequest.Request(ep, headers={"Authorization": f"Bearer {key}", "apikey": key})
            with urlrequest.urlopen(req, timeout=20) as r:
                live_rows = json.loads(r.read())
        except Exception as e:
            live_rows = None
            fails.append(f"live_real_state fetch failed: {e}")
        if live_rows is not None:
            ages = {}
            for row in live_rows:
                t = parse_iso(row.get("ts"))
                if t and row.get("login") in LIVE_REAL_LOGINS:
                    ages[int(row["login"])] = (now - t).total_seconds()
            info["steps"]["live_stream"] = {"ages_sec": {str(k): int(v) for k, v in ages.items()}}
            missing = LIVE_REAL_LOGINS - set(ages)
            if missing:
                fails.append(f"live-stream: no row for real login(s) {sorted(missing)}")
            stale = {k: int(v) for k, v in ages.items() if v > LIVE_DEADMAN_SEC}
            if stale:
                fails.append(
                    f"live-stream dead-man: real account(s) stale {stale}s "
                    f"(>{LIVE_DEADMAN_SEC}s — Railway worker / tailnet / MT5 down?)"
                )

    # Step 5 — Vercel version pin (warn only)
    app_v, css_v = vercel_version_pin()
    info["steps"]["vercel"] = {"app_js": app_v, "styles_css": css_v}

    duration_ms = int((time.time() - started) * 1000)
    info["duration_ms"] = duration_ms
    info["result"] = "ok" if not fails else "fail"
    info["fails"] = fails

    append_log(info)
    if url and key:
        upload_health_to_supabase(url, key, info)

    # "Competencia siempre activa" — separate deduped alert (independent of integrity fails).
    if dormant_eas and not args.no_issue:
        d_body = [
            f"**{len(dormant_eas)} EA(s) demo establecidos dejaron de operar** (dormidos > umbral)",
            "",
            "Un EA con historial (≥30 trades) que dejó de operar = probablemente se despegó o "
            "crasheó en su VPS. La competencia debe estar siempre llena y viva.",
            "",
            "| magic | símbolo | VPS | cuenta | días sin operar |",
            "|---|---|---|---|---|",
            *[f"| `{d['magic']}` | {d['symbol']} | {d['vps']} | {d['account']} | {d['days_since_last_trade']} |"
              for d in dormant_eas],
            "",
            "_Acción:_ revisar el terminal MT5 de esas cuentas (EA adjunto/AutoTrading) en el VPS.",
        ]
        ref = file_issue_dedupe("dormant EAs", "\n".join(d_body))
        print(f"[watchdog] dormant EAs={len(dormant_eas)} issue={ref}", file=sys.stderr)

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
