"""
Kiz Capital LLC · Battle of Bots — Floating equity sampler (all VPS)

MEASURE-ONLY, WRITE-LOCAL-ONLY. One cycle per invocation (--once, the Railway
tick default): iterates every installed MT5 terminal on this VPS, reads
account_info() + positions_get() (read-only), and records floating P&L
per-magic AND per-account. The account-level series is the point — MT5
stop-out happens per ACCOUNT, not per magic (tribunal 2026-06-09, P0).

Outputs (all local, the raw series never travels through the mirror):
    C:\\mt5-mcp\\equity_samples\\YYYYMMDD.jsonl   raw series, 1 line/account/cycle, 35d retention
    C:\\mt5-mcp\\floating_dd_summary.json        daily aggregates per bot + per account (mirror picks THIS up)
    C:\\mt5-mcp\\sampler_status.json             heartbeat {last_sample_ts, samples_last_5min, rss_mb, ...}

Denominator discipline: percentages use the DECLARED initial balance from
C:\\mt5-mcp\\initial_balances.json (default 10000 for demo) — never the live
account_balance, which co-resident bots move daily (non-stationary denominator
fails metrology; tribunal P0). All derived gating happens Mac/CI-side in
post_merge.py; this script records facts.

Spawn model: invoked one-shot via SSH (NetworkCleartext) by the Railway
kiz-live-bridge worker every 60-120s. NOT a resident daemon, NOT Task
Scheduler — mt5.initialize hangs under InteractiveToken when the RDP session
is disconnected (memory [vps-disconnected-rdp-mt5-hang]).

Run:
    C:\\mt5-mcp\\venv\\Scripts\\python.exe C:\\mt5-mcp\\equity_sampler.py --once
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import MetaTrader5 as mt5

ROOT = Path(r"C:\mt5-mcp")
SAMPLES_DIR = ROOT / "equity_samples"
SUMMARY_PATH = ROOT / "floating_dd_summary.json"
STATUS_PATH = ROOT / "sampler_status.json"
SNAPSHOT_PATH = ROOT / "snapshot.json"
INITIAL_BALANCES_PATH = ROOT / "initial_balances.json"
LOCK_PATH = ROOT / ".sampler.lock"

TERMINAL_GLOB = r"C:\Program Files\MetaTrader 5 *\terminal64.exe"
SCHEMA_VERSION = "sampler-v1-2026-06-09"
RAW_RETENTION_DAYS = 35
SUMMARY_RETENTION_DAYS = 95
PER_TERMINAL_TIMEOUT = 15.0   # a hung mt5.initialize must not freeze the cycle
LOCK_STALE_SECS = 300
DEFAULT_INITIAL_BALANCE = 10000.0


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse_prev_ts(s: str):
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def atomic_write(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


# --- Lock (overlapping one-shot invocations only; MT5 concurrency with the
# builder is already proven safe by live_publisher on VPS5) -----------------

def acquire_lock() -> bool:
    # O_CREAT|O_EXCL = atómico (tribunal post-impl): dos one-shots simultáneos
    # no pueden ganar ambos el check-then-write anterior.
    for _ in range(2):
        try:
            fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, json.dumps({"pid": os.getpid(), "ts": time.time()}).encode())
            os.close(fd)
            return True
        except FileExistsError:
            prev = load_json(LOCK_PATH, {})
            if time.time() - float(prev.get("ts", 0)) < LOCK_STALE_SECS:
                return False
            try:
                LOCK_PATH.unlink()   # stale: retry the atomic create once
            except OSError:
                return False
    return False


def release_lock() -> None:
    try:
        LOCK_PATH.unlink()
    except OSError:
        pass


# --- Active-bot universe from the local snapshot ---------------------------

def load_active_magics() -> dict[int, set[int]]:
    """login -> set of active magics (magic != 0, already year-filtered by the
    builder). Bots outside this set are counted but not given a per-magic row."""
    snap = load_json(SNAPSHOT_PATH, {})
    out: dict[int, set[int]] = {}
    for b in snap.get("bots", []):
        login = int(b.get("account_login") or b.get("login") or 0)
        magic = int(b.get("magic") or 0)
        if login and magic:
            out.setdefault(login, set()).add(magic)
    return out


def load_initial_balances() -> dict[int, float]:
    raw = load_json(INITIAL_BALANCES_PATH, {})
    return {int(k): float(v) for k, v in raw.get("accounts", {}).items()}


# --- One terminal ----------------------------------------------------------

def _read_terminal(path: str) -> dict[str, Any] | None:
    if not mt5.initialize(path=path):
        return None
    try:
        info = mt5.account_info()
        if info is None:
            return None
        ti = mt5.terminal_info()
        if ti is None or not getattr(ti, "connected", False):
            # Same DNA rule as live_publisher: never emit a fresh ts over a
            # cached/disconnected terminal snapshot.
            return {"login": int(info.login), "skipped": "not_connected"}
        by_magic: dict[int, dict[str, Any]] = {}
        floating_total = 0.0
        for p in (mt5.positions_get() or []):
            pd = p._asdict()
            magic = int(pd.get("magic") or 0)
            pnl = float(pd.get("profit") or 0.0) + float(pd.get("swap") or 0.0)
            floating_total += pnl
            slot = by_magic.setdefault(magic, {"floating": 0.0, "positions": 0})
            slot["floating"] = round(slot["floating"] + pnl, 2)
            slot["positions"] += 1
        return {
            "login": int(info.login),
            "balance": float(info.balance or 0),
            "equity": float(info.equity or 0),
            "margin_level": float(info.margin_level or 0),
            "floating": round(floating_total, 2),
            "by_magic": by_magic,
        }
    finally:
        try:
            mt5.shutdown()
        except Exception:
            pass
        time.sleep(0.05)


def read_terminal_timed(path: str) -> dict[str, Any] | None:
    box: dict[str, Any] = {}
    t = threading.Thread(target=lambda: box.update(v=_read_terminal(path)), daemon=True)
    t.start()
    t.join(PER_TERMINAL_TIMEOUT)
    if t.is_alive():
        return {"skipped": "timeout", "path": path}
    return box.get("v")


# --- Aggregation -----------------------------------------------------------

def update_summary(summary: dict[str, Any], ts: str, day: str, row: dict[str, Any],
                   active: set[int], initial_balance: float, cadence_min: float) -> None:
    login = str(row["login"])
    accounts = summary.setdefault("accounts", {})
    acc_days = accounts.setdefault(login, {})
    a = acc_days.setdefault(day, {
        "samples": 0, "min_equity": None, "max_floating_deficit": 0.0,
        "worst_floating_dd_pct": 0.0, "time_underwater_min": 0.0,
    })
    a["samples"] += 1
    eq = row["equity"]
    a["min_equity"] = eq if a["min_equity"] is None else min(a["min_equity"], eq)
    deficit = max(0.0, row["balance"] - eq)   # how far floating drags equity below balance
    a["max_floating_deficit"] = round(max(a["max_floating_deficit"], deficit), 2)
    a["worst_floating_dd_pct"] = round(max(
        a["worst_floating_dd_pct"], deficit / initial_balance * 100.0), 3)
    if row["floating"] < 0:
        a["time_underwater_min"] = round(a["time_underwater_min"] + cadence_min, 1)

    bots = summary.setdefault("bots", {})
    for magic, slot in row["by_magic"].items():
        if int(magic) not in active:
            continue
        key = f"{login}-{magic}"
        b = bots.setdefault(key, {}).setdefault(day, {
            "samples": 0, "min_floating": 0.0, "worst_floating_dd_pct": 0.0,
            "time_underwater_min": 0.0, "max_positions": 0,
        })
        b["samples"] += 1
        b["min_floating"] = round(min(b["min_floating"], slot["floating"]), 2)
        b["worst_floating_dd_pct"] = round(max(
            b["worst_floating_dd_pct"], max(0.0, -slot["floating"]) / initial_balance * 100.0), 3)
        if slot["floating"] < 0:
            b["time_underwater_min"] = round(b["time_underwater_min"] + cadence_min, 1)
        b["max_positions"] = max(b["max_positions"], slot["positions"])
    summary["generated_at"] = ts
    summary["schema_version"] = SCHEMA_VERSION
    summary["initial_balance_source"] = str(INITIAL_BALANCES_PATH.name)


def prune(summary: dict[str, Any]) -> None:
    cutoff = (utcnow() - timedelta(days=SUMMARY_RETENTION_DAYS)).strftime("%Y-%m-%d")
    for section in ("accounts", "bots"):
        for key, days in list(summary.get(section, {}).items()):
            for day in list(days):
                if day < cutoff:
                    del days[day]
            if not days:
                del summary[section][key]
    cut_raw = (utcnow() - timedelta(days=RAW_RETENTION_DAYS)).strftime("%Y%m%d")
    for f in SAMPLES_DIR.glob("*.jsonl"):
        if f.stem < cut_raw:
            try:
                f.unlink()
            except OSError:
                pass


def rss_mb() -> float | None:
    try:
        import ctypes
        import ctypes.wintypes as wt

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD)] + [
                (n, ctypes.c_size_t) for n in (
                    "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                    "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                    "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        k32 = ctypes.windll.kernel32
        fn = getattr(k32, "K32GetProcessMemoryInfo", None) or ctypes.windll.psapi.GetProcessMemoryInfo
        fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(PMC), wt.DWORD]
        # GetCurrentProcess() pseudo-handle is -1; without an explicit void_p it
        # truncates to 32 bits on x64 and the call fails with ret=0.
        if fn(ctypes.c_void_p(-1), ctypes.byref(pmc), pmc.cb):
            return round(pmc.WorkingSetSize / (1024 * 1024), 1)
    except Exception:
        pass
    return None


# --- Cycle -----------------------------------------------------------------

def run_cycle(cadence_secs: float) -> dict[str, Any]:
    SAMPLES_DIR.mkdir(exist_ok=True)
    active_by_login = load_active_magics()
    initial_balances = load_initial_balances()
    summary = load_json(SUMMARY_PATH, {})
    status_prev = load_json(STATUS_PATH, {})

    now = utcnow()
    ts = now.isoformat(timespec="seconds")
    day = now.strftime("%Y-%m-%d")
    raw_path = SAMPLES_DIR / f"{now.strftime('%Y%m%d')}.jsonl"

    # ts monotonicity assertion (tribunal: >=2 assertions per write)
    last_ts = status_prev.get("last_sample_ts", "")
    if last_ts and ts <= last_ts:
        return {"ok": False, "reason": f"non-monotonic ts {ts} <= {last_ts}"}

    # time_underwater determinista (tribunal post-impl): dt = gap real desde la
    # muestra anterior, capado a 2*cadencia — huecos largos no inflan el tiempo
    # bajo agua y multi-driver denso no lo duplica (clamp inferior = 0).
    dt_min = cadence_secs / 60.0
    prev_dt = _parse_prev_ts(last_ts)
    if prev_dt is not None:
        gap = (now - prev_dt).total_seconds()
        dt_min = max(0.0, min(gap, 2 * cadence_secs)) / 60.0

    sampled_accounts = 0
    sampled_magics = 0
    unknown_magics = 0
    skipped: list[dict[str, Any]] = []
    lines: list[str] = []

    for path in sorted(glob.glob(TERMINAL_GLOB)):
        row = read_terminal_timed(path)
        if not row:
            continue
        if row.get("skipped"):
            skipped.append({"login": row.get("login"), "why": row["skipped"]})
            continue
        login = row["login"]
        active = active_by_login.get(login, set())
        # unknown = magics con posición que NO están en el snapshot, excluyendo
        # magic=0 (trades manuales/pseudo-bot conocido, no es anomalía).
        unknown_magics += sum(1 for m in row["by_magic"] if int(m) not in active and int(m) != 0)
        ib = initial_balances.get(login, DEFAULT_INITIAL_BALANCE)
        lines.append(json.dumps({
            "ts": ts, "login": login, "balance": row["balance"], "equity": row["equity"],
            "margin_level": row["margin_level"], "floating": row["floating"],
            "by_magic": {str(m): s for m, s in row["by_magic"].items()},
        }, separators=(",", ":")))
        update_summary(summary, ts, day, row, active, ib, dt_min)
        sampled_accounts += 1
        sampled_magics += sum(1 for m in row["by_magic"] if int(m) in active)

    if lines:
        with raw_path.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        prune(summary)
        atomic_write(SUMMARY_PATH, summary)

    # heartbeat: rolling 5-min sample timestamps survive across one-shot runs
    recent = [t for t in status_prev.get("recent_ts", []) if t > (now - timedelta(minutes=5)).isoformat()]
    if lines:
        recent.append(ts)
    status = {
        "schema_version": SCHEMA_VERSION,
        "last_sample_ts": ts if lines else last_ts,
        "samples_last_5min": len(recent),
        "recent_ts": recent[-10:],
        "accounts_sampled": sampled_accounts,
        "magics_sampled": sampled_magics,
        "unknown_magics": unknown_magics,
        "skipped": skipped,
        "rss_mb": rss_mb(),
        "cadence_secs": cadence_secs,
    }
    atomic_write(STATUS_PATH, status)
    return {"ok": sampled_accounts > 0, **status}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="single cycle (Railway tick default)")
    ap.add_argument("--cadence", type=float, default=120.0,
                    help="seconds between ticks (for time_underwater accounting)")
    args = ap.parse_args()
    if not acquire_lock():
        print(json.dumps({"ok": False, "reason": "another sampler cycle is running"}))
        sys.exit(0)   # benign overlap: skip, don't error
    try:
        result = run_cycle(args.cadence)
        # stdout llega a logs PÚBLICOS (GH Actions en repo público): redactar
        # detalle de skipped (contiene logins); el sampler_status.json local
        # conserva el detalle completo.
        out = {k: v for k, v in result.items() if k not in ("recent_ts", "skipped")}
        out["skipped_count"] = len(result.get("skipped", []) or [])
        print(json.dumps(out))
        sys.exit(0 if result.get("ok") else 1)
    finally:
        release_lock()


if __name__ == "__main__":
    main()
