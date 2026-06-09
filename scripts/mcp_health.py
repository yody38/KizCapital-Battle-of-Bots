#!/usr/bin/env python3
"""
mcp_health.py — MCP server health monitor for the 5 MT5 VPS.

Runs every 5 min in GitHub Actions. For each VPS in the roster, verifies:
  1. SSH reachability via Tailscale (timeout 8 s, capture latency).
  2. MT5 readiness — read C:/mt5-mcp/snapshot.json `generated_at` over SSH;
     stale if > MCP_HEALTH_STALE_SEC (default 2700 s = 45 min).

Outputs:
  data/mcp_health.json        — current snapshot (uploaded to Supabase)
  data/mcp_health_state.json  — consecutive-fail counters (persisted via cache)

Side effects:
  - GitHub Issue (dedupe by UTC day + VPS) when a VPS has consecutive_fails >= 2.
  - Stdout summary: 'ok 5/5' / 'fail 4/5 down=[vps2]'

Env:
  SSH_KEY               path to private key (default ~/.ssh/id_ed25519_ci)
  MCP_HEALTH_STALE_SEC  override staleness threshold for snapshot age
  AUTO_RECOVERY         '1' to attempt sshd restart on first consecutive fail
  GH_TOKEN              required for issue creation (skipped if absent)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
HEALTH_FILE = DATA_DIR / "mcp_health.json"
STATE_FILE = DATA_DIR / "mcp_health_state.json"
ENV_FILE = ROOT / ".env.local"

BUCKET = "dashboard-data"
GH_REPO = "yody38/KizCapital-Battle-of-Bots"

VPS_ROSTER = [
    ("vps1", "trader@100.81.54.93"),
    ("vps2", "trader@100.101.9.46"),
    ("vps3", "trader@100.118.159.44"),
    ("vps4", "trader@100.125.237.26"),
    ("vps5", "trader@100.70.228.19"),
    ("vps6", "trader@100.112.112.115"),
]

SSH_KEY = os.environ.get("SSH_KEY", str(Path.home() / ".ssh" / "id_ed25519_ci"))
SSH_TIMEOUT = 8
STALE_SEC = int(os.environ.get("MCP_HEALTH_STALE_SEC", 2700))
FAIL_THRESHOLD = 2
AUTO_RECOVERY = os.environ.get("AUTO_RECOVERY", "0") == "1"
# Free-RAM early warning — INFORMATIONAL ONLY (never changes status).
# The 5 production VPS run at a steady state of 70-106MB free RAM (1-1.5GB total,
# 10-13 MT5 terminals each); that is their NORMAL operating point, and at that
# level SSH + the builder + mirror are all proven healthy every cycle. So free
# physical RAM is NOT a reliable down/degraded signal — an absolute threshold
# above the steady state just fires 24/7 (the integrity-watchdog false-positive
# flood). We still surface free_ram_mb + a low_ram_warn flag for the dashboard
# chip, but genuine exhaustion (the 2h freeze) manifests as the snapshot read
# failing above (-> degraded) — that gate, not a RAM number, catches the cascade.
LOW_RAM_WARN_MB = int(os.environ.get("MCP_HEALTH_LOW_RAM_MB", 120))

REMOTE_SNAPSHOT = "C:/mt5-mcp/snapshot.json"


# ---------- env / utils ----------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if v := os.environ.get(k):
            env[k] = v
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


# ---------- SSH probes ----------

def ssh_cmd(host: str, remote: str, timeout: int = SSH_TIMEOUT) -> tuple[int, str, str, float]:
    args = [
        "ssh", "-i", SSH_KEY,
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"ConnectTimeout={timeout}",
        "-o", "BatchMode=yes",
        host, remote,
    ]
    started = time.time()
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout + 5)
        elapsed = (time.time() - started) * 1000
        return p.returncode, p.stdout, p.stderr, elapsed
    except subprocess.TimeoutExpired:
        return 124, "", "ssh timeout", (time.time() - started) * 1000


def probe_vps(vps_id: str, host: str) -> dict:
    """Return status dict for one VPS."""
    result: dict = {
        "vps_id": vps_id,
        "host": host.split("@", 1)[-1],
        "checked_at": now_iso(),
    }

    # 1. SSH ping
    rc, stdout, stderr, ms = ssh_cmd(host, "echo pong")
    result["ssh_ms"] = round(ms, 1)
    if rc != 0 or "pong" not in stdout:
        result["status"] = "down"
        result["fail_reason"] = f"ssh_rc={rc} stderr={stderr.strip()[:120]}"
        return result

    # 2. Snapshot age (powershell reads UTF-8 JSON, prints generated_at)
    ps = (
        "powershell -NoProfile -Command "
        "\"try { (Get-Content -Raw 'C:\\mt5-mcp\\snapshot.json' | ConvertFrom-Json).generated_at } "
        "catch { '' }\""
    )
    rc, stdout, stderr, ms = ssh_cmd(host, ps, timeout=12)
    result["snap_read_ms"] = round(ms, 1)
    gen = stdout.strip()
    if rc != 0 or not gen:
        result["status"] = "degraded"
        result["fail_reason"] = f"snapshot_read_rc={rc} out='{gen[:80]}' err={stderr.strip()[:80]}"
        return result

    # Parse generated_at
    g = gen[:-1] + "+00:00" if gen.endswith("Z") else gen
    try:
        gt = datetime.fromisoformat(g)
        if gt.tzinfo is None:
            gt = gt.replace(tzinfo=timezone.utc)
    except Exception as e:
        result["status"] = "degraded"
        result["fail_reason"] = f"bad_generated_at='{gen[:60]}' err={e}"
        return result

    age = int((datetime.now(timezone.utc) - gt).total_seconds())
    result["snapshot_age_sec"] = age
    result["snapshot_generated_at"] = gen
    if age > STALE_SEC:
        result["status"] = "stale"
        result["fail_reason"] = f"snapshot age {age}s > {STALE_SEC}s"
        return result

    # 3. Free-RAM telemetry (INFORMATIONAL — never sets status). The VPS3-freeze
    #    failure mode is already gated above: if RAM is truly exhausted, the
    #    snapshot read fails (-> degraded). Here we only record the number and a
    #    soft warn flag for the dashboard chip; the VPS stays "ok" because SSH +
    #    snapshot + freshness all passed.
    ps_mem = (
        "powershell -NoProfile -Command "
        "\"[int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)\""
    )
    rc, stdout, stderr, ms = ssh_cmd(host, ps_mem, timeout=12)
    try:
        free_mb = int(stdout.strip())
        result["free_ram_mb"] = free_mb
        if free_mb < LOW_RAM_WARN_MB:
            result["low_ram_warn"] = True  # surfaced as info, does NOT degrade
    except (ValueError, TypeError):
        pass  # could not measure; hard failures are already gated by the snapshot read

    result["status"] = "ok"
    return result


# ---------- auto-recovery ----------

def attempt_recovery(vps_id: str, host: str) -> dict:
    """Best-effort sshd restart. Returns log dict."""
    log = {"vps_id": vps_id, "attempted_at": now_iso(), "actions": []}
    if not AUTO_RECOVERY:
        log["skipped"] = "AUTO_RECOVERY=0"
        return log
    # sshd restart — only thing safe to attempt without risk of corrupting MT5 mid-trade
    rc, _, stderr, _ = ssh_cmd(host, "powershell -NoProfile -Command \"Restart-Service sshd\"", timeout=20)
    log["actions"].append({"step": "restart_sshd", "rc": rc, "err": stderr.strip()[:120]})
    return log


# ---------- state ----------

def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"consecutive_fails": {}, "last_recovery": {}}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"consecutive_fails": {}, "last_recovery": {}}


def save_state(state: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


# ---------- GitHub Issue ----------

def file_issue(vps_id: str, body: str) -> str:
    if not shutil.which("gh"):
        return "gh_not_installed"
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    title = f"[mcp-health] {vps_id} unhealthy — {today}"
    # Find existing open issue with same label + title
    try:
        p = subprocess.run(
            ["gh", "issue", "list", "--repo", GH_REPO, "--state", "open",
             "--label", "mcp-health", "--json", "number,title"],
            check=True, capture_output=True, text=True, timeout=30,
        )
        existing = json.loads(p.stdout)
    except Exception:
        existing = []
    match = next((i for i in existing if i.get("title") == title), None)
    if match:
        try:
            subprocess.run(
                ["gh", "issue", "comment", str(match["number"]),
                 "--repo", GH_REPO, "--body", body],
                check=True, capture_output=True, text=True, timeout=30,
            )
            return f"#{match['number']} (commented)"
        except Exception as e:
            return f"comment_failed: {e}"
    try:
        p = subprocess.run(
            ["gh", "issue", "create", "--repo", GH_REPO,
             "--title", title, "--body", body,
             "--label", "mcp-health"],
            check=True, capture_output=True, text=True, timeout=30,
        )
        url = p.stdout.strip().splitlines()[-1]
        return f"#{url.rstrip('/').rsplit('/', 1)[-1]} (created)"
    except Exception as e:
        return f"create_failed: {e}"


# ---------- Supabase upload ----------

def upload_supabase(env: dict[str, str], object_path: str, body: bytes) -> int:
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return -1
    encoded = "/".join(urlparse.quote(p, safe="") for p in object_path.split("/"))
    endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{encoded}"
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
        "x-upsert": "true",
        "cache-control": "no-cache, max-age=0",
    }
    req = urlrequest.Request(endpoint, data=body, headers=headers, method="POST")
    try:
        with urlrequest.urlopen(req, timeout=30) as r:
            return r.status
    except urlerror.HTTPError as e:
        return e.code
    except Exception:
        return -1


# ---------- main ----------

def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()
    counts: dict[str, int] = state.get("consecutive_fails", {}) or {}

    started = time.time()
    vps_results: list[dict] = []
    for vps_id, host in VPS_ROSTER:
        r = probe_vps(vps_id, host)
        if r["status"] == "ok":
            counts[vps_id] = 0
        else:
            counts[vps_id] = counts.get(vps_id, 0) + 1
        r["consecutive_fails"] = counts[vps_id]
        vps_results.append(r)

    ok_count = sum(1 for r in vps_results if r["status"] == "ok")
    summary = {
        "checked_at": now_iso(),
        "duration_ms": int((time.time() - started) * 1000),
        "ok_count": ok_count,
        "total": len(vps_results),
        "summary": f"{ok_count}/{len(vps_results)}",
        "any_critical": any(r["consecutive_fails"] >= FAIL_THRESHOLD for r in vps_results),
        "vps": {r["vps_id"]: r for r in vps_results},
        "config": {
            "stale_threshold_sec": STALE_SEC,
            "fail_threshold": FAIL_THRESHOLD,
            "auto_recovery": AUTO_RECOVERY,
        },
    }

    # Persist health snapshot
    HEALTH_FILE.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    # Issue + recovery on consecutive_fails >= threshold
    issues_filed: list[str] = []
    for r in vps_results:
        if r["consecutive_fails"] < FAIL_THRESHOLD:
            continue
        # Auto-recovery (best-effort, logged)
        recovery = attempt_recovery(r["vps_id"], dict(VPS_ROSTER)[r["vps_id"]])
        state.setdefault("last_recovery", {})[r["vps_id"]] = recovery
        # Issue
        body_lines = [
            f"**VPS `{r['vps_id']}` unhealthy** (consecutive_fails={r['consecutive_fails']})",
            "",
            f"- status: `{r['status']}`",
            f"- ssh_ms: `{r.get('ssh_ms','n/a')}`",
            f"- snapshot_age_sec: `{r.get('snapshot_age_sec','n/a')}`",
            f"- fail_reason: `{r.get('fail_reason','')}`",
            "",
            f"Recovery attempt: `{json.dumps(recovery)}`" if recovery else "",
            "",
            f"_Run reproducer:_ `python3 'Battle of Bots/scripts/mcp_health.py'`",
        ]
        issues_filed.append(file_issue(r["vps_id"], "\n".join(body_lines)))

    state["consecutive_fails"] = counts
    state["last_run"] = summary["checked_at"]
    save_state(state)

    # Upload to Supabase (best-effort, doesn't fail the workflow if it can't)
    env = load_env()
    code = upload_supabase(env, "mcp_health.json", json.dumps(summary).encode())
    if code not in (200, 201, -1):
        print(f"[mcp_health] upload http={code}", file=sys.stderr)

    # Summary line
    down = [r["vps_id"] for r in vps_results if r["status"] != "ok"]
    line = f"[mcp_health] {summary['summary']} {summary['duration_ms']}ms"
    if down:
        line += f" down={down} issues={issues_filed}"
    print(line)

    # Exit 0 always — workflow shouldn't fail on detection; issues + dashboard are the alert channel
    return 0


if __name__ == "__main__":
    sys.exit(main())
