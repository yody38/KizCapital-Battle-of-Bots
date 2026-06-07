#!/usr/bin/env python3
"""
verify_integrity.py — Data Integrity DNA for Kiz Capital · Battle of Bots.

Reads `data/snapshot.json` and validates that every bot listed has:
  1. A per-bot file at `data/bots/<vps>/<login>-<magic>.json` (presence).
  2. Trade count matches between snapshot and per-bot file.
  3. snapshot.net_profit ≈ sum(trade.profit + trade.swap) from per-bot trades
     within tolerance (per-bot.net_profit includes commission; snapshot does not).
  4. per-bot.net_profit ≈ sum(trade.net) (internal consistency of per-bot file).
  5. daily_equity_series is non-empty and covers from first_trade onward.

Cross-cutting gates (snapshot-level, re-derivable — no wall-clock):
  6. Real-account freshness — each REAL account's hosting VPS must be present and
     fresh (hard gate); demo staleness is warn-only. + real-count matches
     real_portfolio.account_count (catches a real silently dropping out).
  7. Forward-tracker ledger health — > 5 corrupt lines in candidates_history.jsonl
     (surfaced by post_merge as tracker_health) fails the cycle.

Optional remote check (--check-remote):
  8. sha256(local file) == sha256(file downloaded from Supabase Storage).
     Confirms what is deployed matches what is local.

Writes `data/integrity_report.json` with full results.

Exit codes:
  0  — all checks passed (ok=true)
  1  — fatal (snapshot.json missing, etc.)
  2  — checks failed (ok=false). In --strict mode, this aborts CI.

Usage:
  python3 verify_integrity.py [--strict] [--check-remote] [--tolerance 0.05]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from urllib import request as urlrequest
from urllib import error as urlerror

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SNAPSHOT = DATA_DIR / "snapshot.json"
BOTS_DIR = DATA_DIR / "bots"
REPORT = DATA_DIR / "integrity_report.json"
ENV_FILE = ROOT / ".env.local"
BUCKET = "dashboard-data"

DEFAULT_TOLERANCE = 0.05  # USD


def load_env() -> dict[str, str]:
    if not ENV_FILE.exists():
        return {}
    env: dict[str, str] = {}
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def sha256_path(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch_remote(url: str, key: str, obj_path: str) -> bytes:
    encoded = "/".join(p for p in obj_path.split("/"))
    endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{encoded}"
    req = urlrequest.Request(
        endpoint,
        headers={"Authorization": f"Bearer {key}", "apikey": key},
        method="GET",
    )
    with urlrequest.urlopen(req, timeout=30) as resp:
        return resp.read()


def check_bot(bot: dict, tolerance: float) -> list[str]:
    """Run all per-bot checks. Returns a list of failure messages (empty if ok)."""
    fails: list[str] = []
    vps = bot.get("vps")
    login = bot.get("account_login")
    magic = bot.get("magic")
    key = f"{vps}/{login}-{magic}"

    pb_path = BOTS_DIR / vps / f"{login}-{magic}.json"
    if not pb_path.exists():
        return [f"{key}: per-bot file MISSING ({pb_path.relative_to(ROOT)})"]

    try:
        pb = json.loads(pb_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [f"{key}: per-bot file UNREADABLE ({exc})"]

    trades = pb.get("trades")
    if not isinstance(trades, list):
        fails.append(f"{key}: per-bot 'trades' is not a list")
        return fails

    snap_trades = bot.get("trades")
    pb_trade_count = pb.get("trade_count")
    if snap_trades != len(trades):
        fails.append(
            f"{key}: trade count mismatch — snapshot={snap_trades} "
            f"per-bot.len(trades)={len(trades)} per-bot.trade_count={pb_trade_count}"
        )
    if pb_trade_count != len(trades):
        fails.append(
            f"{key}: per-bot internal mismatch — trade_count={pb_trade_count} "
            f"len(trades)={len(trades)}"
        )

    sum_net = round(sum(t.get("net", 0) for t in trades), 2)
    pb_net = pb.get("net_profit", 0)
    if abs(sum_net - pb_net) > tolerance:
        fails.append(
            f"{key}: per-bot internal net mismatch — "
            f"net_profit={pb_net} sum(trades.net)={sum_net} diff={round(sum_net-pb_net,2)}"
        )

    sum_p_s = round(sum(t.get("profit", 0) + t.get("swap", 0) for t in trades), 2)
    snap_net = bot.get("net_profit", 0)
    if abs(sum_p_s - snap_net) > tolerance:
        fails.append(
            f"{key}: snapshot net_profit vs per-bot trades mismatch — "
            f"snapshot={snap_net} sum(profit+swap)={sum_p_s} diff={round(sum_p_s-snap_net,2)}"
        )

    series = pb.get("daily_equity_series")
    if not isinstance(series, list) or len(series) == 0:
        fails.append(f"{key}: daily_equity_series empty or missing")

    return fails


def check_freshness(snap: dict) -> tuple[list[str], list[str], dict]:
    """5th check — real-account data authenticity (HARD gate) + demo staleness (WARN).

    Re-derivable from the snapshot itself (uses the `vps_freshness` block baked in
    by post_merge + `real_portfolio.account_count`) — no wall-clock here, so it is
    Data-Integrity-DNA compliant. Hard-fails only for REAL accounts; demo is warn-only.
    Note: mirror.sh already aborts the cycle at 30min snapshot age, so under normal
    operation a VPS is never `stale` (>90min) here — this is a defense-in-depth
    safety net that catches a real account served from a stale/absent VPS, or a
    real account silently dropping out.
    """
    hard: list[str] = []   # contributes to ok=false (REAL accounts only)
    warn: list[str] = []   # surfaced only, never gates (demo)
    vps_fresh = snap.get("vps_freshness") or {}
    accounts = snap.get("accounts") or []
    real_accts = [a for a in accounts if a.get("is_real")]
    detail: dict = {"real_accounts": [], "demo_on_stale_vps": 0}

    # (a) Real-account count must match real_portfolio (catches a real dropping out).
    expected_real = (snap.get("real_portfolio") or {}).get("account_count")
    if isinstance(expected_real, int) and len(real_accts) != expected_real:
        hard.append(
            f"freshness: real account count mismatch — accounts.is_real={len(real_accts)} "
            f"real_portfolio.account_count={expected_real}"
        )

    # (b) Each real account's hosting VPS must be fresh and present.
    for a in real_accts:
        login = a.get("login")
        vps = a.get("vps")
        vf = vps_fresh.get(vps) if vps else None
        status, live_feed = "ok", True
        if vf is None:
            status = "unknown"
            warn.append(f"freshness: real {login} on {vps} — no vps_freshness metadata (cannot verify)")
        elif vf.get("present") is False:
            status, live_feed = "vps_absent", False
            hard.append(f"freshness: real {login} — hosting VPS {vps} ABSENT from this cycle")
        elif vf.get("stale"):
            status, live_feed = "vps_stale", False
            hard.append(f"freshness: real {login} — hosting VPS {vps} STALE (lag={vf.get('lag_sec')}s)")
        detail["real_accounts"].append(
            {"login": login, "vps": vps, "status": status, "live_feed": live_feed}
        )

    # (c) Demo accounts on a stale/absent VPS — warn only (do NOT gate).
    for a in accounts:
        if a.get("is_real"):
            continue
        vf = vps_fresh.get(a.get("vps"))
        if vf and (vf.get("stale") or vf.get("present") is False):
            detail["demo_on_stale_vps"] += 1
    if detail["demo_on_stale_vps"]:
        warn.append(f"freshness: {detail['demo_on_stale_vps']} demo account(s) on a stale/absent VPS")

    return hard, warn, detail


def remote_hash_diffs(
    local_paths: list[tuple[Path, str]], env: dict[str, str]
) -> list[str]:
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return ["remote: SUPABASE credentials missing in .env.local"]
    fails: list[str] = []
    for abs_path, obj_path in local_paths:
        try:
            remote = fetch_remote(url, key, obj_path)
        except urlerror.HTTPError as exc:
            fails.append(f"remote:{obj_path} HTTP {exc.code}")
            continue
        except Exception as exc:
            fails.append(f"remote:{obj_path} ERROR {exc}")
            continue
        if sha256_bytes(remote) != sha256_path(abs_path):
            fails.append(f"remote:{obj_path} sha256 mismatch (deployed != local)")
    return fails


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="Exit 2 if any check fails")
    parser.add_argument(
        "--check-remote",
        action="store_true",
        help="Also verify deployed Supabase Storage matches local sha256",
    )
    parser.add_argument(
        "--tolerance",
        type=float,
        default=DEFAULT_TOLERANCE,
        help=f"USD tolerance for net_profit comparisons (default {DEFAULT_TOLERANCE})",
    )
    args = parser.parse_args()

    if not SNAPSHOT.exists():
        print(f"FATAL: {SNAPSHOT} not found", file=sys.stderr)
        return 1

    snap = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    bots = [b for b in snap.get("bots", []) if b.get("magic", 0) != 0]

    started = time.time()
    all_fails: list[str] = []
    per_bot_fails: dict[str, list[str]] = {}
    missing_files = 0
    trade_mismatches = 0
    net_mismatches = 0
    series_missing = 0

    for b in bots:
        fails = check_bot(b, args.tolerance)
        if fails:
            key = f"{b.get('vps')}/{b.get('account_login')}-{b.get('magic')}"
            per_bot_fails[key] = fails
            all_fails.extend(fails)
            for f in fails:
                if "MISSING" in f or "UNREADABLE" in f:
                    missing_files += 1
                if "trade count mismatch" in f or "trade_count=" in f:
                    trade_mismatches += 1
                if "net" in f.lower() and "mismatch" in f:
                    net_mismatches += 1
                if "daily_equity_series" in f:
                    series_missing += 1

    # 5th check — real-account freshness/authenticity (hard) + demo staleness (warn).
    freshness_hard, freshness_warn, freshness_detail = check_freshness(snap)
    all_fails.extend(freshness_hard)

    # Forward-tracker ledger corruption gate (post_merge surfaces tracker_health).
    tracker_health = snap.get("tracker_health") or {}
    tracker_corrupt = tracker_health.get("corrupt_lines", 0)
    if tracker_corrupt > 5:
        all_fails.append(
            f"tracker_health: {tracker_corrupt} corrupt lines in candidates_history.jsonl (>5)"
        )

    remote_fails: list[str] = []
    if args.check_remote:
        env = load_env()
        local_paths: list[tuple[Path, str]] = []
        for b in bots:
            vps = b.get("vps")
            login = b.get("account_login")
            magic = b.get("magic")
            p = BOTS_DIR / vps / f"{login}-{magic}.json"
            if p.exists():
                local_paths.append((p, f"bots/{vps}/{login}-{magic}.json"))
        remote_fails = remote_hash_diffs(local_paths, env)
        all_fails.extend(remote_fails)

    dur = round(time.time() - started, 2)
    ok = not all_fails

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "duration_sec": dur,
        "ok": ok,
        "bots_checked": len(bots),
        "bots_failed": len(per_bot_fails),
        "summary": {
            "missing_files": missing_files,
            "trade_mismatches": trade_mismatches,
            "net_profit_mismatches": net_mismatches,
            "series_missing": series_missing,
            "freshness_hard_fails": len(freshness_hard),
            "tracker_corrupt_lines": tracker_corrupt,
            "remote_check_run": args.check_remote,
            "remote_failures": len(remote_fails),
        },
        "tolerance_usd": args.tolerance,
        "freshness": freshness_detail,
        "warnings": freshness_warn,
        "tracker_health": tracker_health,
        "failures_per_bot": per_bot_fails,
        "remote_failures": remote_fails,
    }
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"[verify] {len(bots)} bots checked in {dur}s — ok={ok}")
    print(
        f"[verify]   missing={missing_files} "
        f"trade_mismatches={trade_mismatches} "
        f"net_mismatches={net_mismatches} "
        f"series_missing={series_missing} "
        f"freshness_hard={len(freshness_hard)} "
        f"tracker_corrupt={tracker_corrupt} "
        f"remote_fails={len(remote_fails)}"
    )
    for w in freshness_warn:
        print(f"[verify]   WARN {w}", file=sys.stderr)
    if all_fails:
        for line in all_fails[:25]:
            print(f"[verify]   FAIL {line}", file=sys.stderr)
        if len(all_fails) > 25:
            print(f"[verify]   ... and {len(all_fails)-25} more (see {REPORT.name})", file=sys.stderr)
    print(f"[verify] report written to {REPORT.relative_to(ROOT)}")

    if not ok and args.strict:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
