"""
Kiz Capital LLC · Battle of Bots — Live equity publisher (VPS5)

Loops every --interval seconds (default 3), queries MetaTrader5 for the 2 real
accounts (#25425 and #32081 on VPS5), and UPSERTs the snapshot into Supabase
table public.live_real_state. The dashboard subscribes to that table via
Supabase Realtime for ~3s updates.

Auth pattern matches real_accounts.py / snapshot_builder.py — iterates
installed MT5 terminals (`C:\\Program Files\\MetaTrader 5 *\\terminal64.exe`)
and uses the live GUI session. Zero stored passwords. After the first cycle the
terminal path that hosts each real login is cached, so subsequent cycles init
only those 2 terminals — that is what makes a 3s cadence feasible.

Runs inside a long-lived SSH NetworkCleartext session held open by the Railway
"kiz-live-bridge" worker (NOT Task Scheduler — `mt5.initialize` hangs under
InteractiveToken when the RDP session is disconnected; see memory
[vps-disconnected-rdp-mt5-hang]). On persistent failure the process exits
non-zero so the Railway supervisor re-establishes the session.

Required env (read from C:\\mt5-mcp\\.live_publisher.env, ACL-locked):
    SUPABASE_URL          https://sudnilwqhbfcjqnzzmhi.supabase.co
    SUPABASE_SERVICE_KEY  service_role key (write-capable, NEVER commit)

Run modes:
    ... live_publisher.py --once                # single cycle (test)
    ... live_publisher.py --loop --interval 3   # continuous (Railway default)
"""
from __future__ import annotations

import argparse
import glob
import logging
import os
import socket
import sys
import time
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import requests
import MetaTrader5 as mt5

# --- Config --------------------------------------------------------------

ROOT = Path(r"C:\mt5-mcp")
LOG_PATH = ROOT / "live_publisher.log"
ENV_PATH = ROOT / ".live_publisher.env"

DEFAULT_INTERVAL = int(os.environ.get("LIVE_INTERVAL_SECS", "3"))
LIVE_VPS_TAG = os.environ.get("LIVE_VPS_TAG", "vps5")
PUBLISHER_ID = f"{LIVE_VPS_TAG}-{socket.gethostname()}"
HTTP_TIMEOUT = 5

REAL_LOGINS: set[int] = {25425, 32081}
TERMINAL_GLOB = r"C:\Program Files\MetaTrader 5 *\terminal64.exe"

# Exit (so Railway restarts the SSH session) after this many consecutive cycles
# that publish zero rows — indicates MT5 is unreachable / terminals are down.
MAX_CONSECUTIVE_EMPTY = 20

# login -> terminal path, learned on the first successful cycle so later cycles
# init only the 2 real terminals instead of all ~12.
_login_path_cache: dict[int, str] = {}

# --- Logging -------------------------------------------------------------

_handler = RotatingFileHandler(str(LOG_PATH), maxBytes=2_000_000, backupCount=5, encoding="utf-8")
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S"))
logging.basicConfig(level=logging.INFO, handlers=[_handler, logging.StreamHandler(sys.stdout)])
log = logging.getLogger("live_publisher")


# --- Env loading ---------------------------------------------------------

def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if ENV_PATH.exists():
        for raw in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if k in os.environ and os.environ[k]:
            env[k] = os.environ[k]
        if k not in env or not env[k]:
            raise SystemExit(f"missing required env var: {k}")
    return env


# --- MT5 helpers ---------------------------------------------------------

def _snapshot_terminal(path: str) -> dict[str, Any] | None:
    """Init one terminal, and if its live session is one of REAL_LOGINS return
    a state row. Returns None otherwise. Always shuts the connection down."""
    t0 = time.monotonic()
    if not mt5.initialize(path=path):
        log.debug("mt5.initialize failed for %s err=%s", path, mt5.last_error())
        return None
    try:
        info = mt5.account_info()
        if info is None:
            return None
        login = int(info.login)
        if login not in REAL_LOGINS:
            return None

        _login_path_cache[login] = path

        positions_raw = mt5.positions_get() or []
        positions = []
        for p in positions_raw:
            pd = p._asdict()
            positions.append({
                "ticket": pd.get("ticket"),
                "magic": pd.get("magic"),
                "symbol": pd.get("symbol"),
                "type": "BUY" if pd.get("type") == 0 else "SELL" if pd.get("type") == 1 else str(pd.get("type")),
                "volume": pd.get("volume"),
                "price_open": pd.get("price_open"),
                "price_current": pd.get("price_current"),
                "sl": pd.get("sl") or None,
                "tp": pd.get("tp") or None,
                "swap": pd.get("swap"),
                "profit": pd.get("profit"),
                "time_open": pd.get("time"),
                "comment": pd.get("comment"),
            })

        return {
            "login": login,
            "vps": LIVE_VPS_TAG,
            "ts": datetime.now(timezone.utc).isoformat(),
            "balance": float(info.balance or 0),
            "equity": float(info.equity or 0),
            "margin": float(info.margin or 0),
            "free_margin": float(info.margin_free or 0),
            "profit": float(info.profit or 0),
            "positions": positions,
            "publisher_id": PUBLISHER_ID,
            "source_age_ms": int((time.monotonic() - t0) * 1000),
        }
    finally:
        try:
            mt5.shutdown()
        except Exception:
            pass
        time.sleep(0.05)


def collect_real_snapshots() -> list[dict[str, Any]]:
    """Snapshot the 2 real accounts. Uses the path cache when warm (fast path:
    2 inits); otherwise scans every installed terminal to (re)learn the paths."""
    rows: list[dict[str, Any]] = []
    seen: set[int] = set()

    # Fast path: hit only the cached terminal for each real login.
    for login in list(REAL_LOGINS):
        path = _login_path_cache.get(login)
        if not path:
            continue
        row = _snapshot_terminal(path)
        if row and row["login"] == login:
            rows.append(row)
            seen.add(login)

    # Slow path: any login still missing → full scan (also self-heals a stale
    # cache after a terminal restart relocated the session).
    if REAL_LOGINS - seen:
        for path in sorted(glob.glob(TERMINAL_GLOB)):
            if REAL_LOGINS <= seen:
                break
            if path in _login_path_cache.values():
                continue  # already tried above
            row = _snapshot_terminal(path)
            if row and row["login"] not in seen:
                rows.append(row)
                seen.add(row["login"])

    missing = REAL_LOGINS - seen
    if missing:
        log.warning("missed real logins this cycle: %s", sorted(missing))
    return rows


# --- Supabase upsert -----------------------------------------------------

def upsert_state(env: dict[str, str], rows: list[dict[str, Any]]) -> bool:
    if not rows:
        return True
    headers = {
        "apikey": env["SUPABASE_SERVICE_KEY"],
        "Authorization": f'Bearer {env["SUPABASE_SERVICE_KEY"]}',
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    url = f'{env["SUPABASE_URL"].rstrip("/")}/rest/v1/live_real_state?on_conflict=login'
    try:
        r = requests.post(url, headers=headers, json=rows, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        log.error("supabase upsert network error: %s", exc)
        return False
    if r.status_code >= 300:
        log.error("supabase upsert HTTP %s body=%s", r.status_code, r.text[:300])
        return False
    return True


# --- Main loop -----------------------------------------------------------

def publish_once(env: dict[str, str]) -> int:
    rows = collect_real_snapshots()
    if not rows:
        return 0
    ok = upsert_state(env, rows)
    if ok:
        log.info(
            "published %d rows (logins=%s ages_ms=%s)",
            len(rows),
            ",".join(str(r["login"]) for r in rows),
            ",".join(str(r["source_age_ms"]) for r in rows),
        )
    return len(rows) if ok else 0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="single cycle then exit")
    ap.add_argument("--loop", action="store_true", help="continuous (default)")
    ap.add_argument("--interval", type=float, default=DEFAULT_INTERVAL, help="seconds between cycles")
    args = ap.parse_args()

    interval = max(1.0, float(args.interval))
    env = load_env()
    log.info(
        "live_publisher starting · interval=%ss · target_logins=%s · publisher=%s",
        interval, sorted(REAL_LOGINS), PUBLISHER_ID,
    )

    backoff = interval
    consecutive_empty = 0

    while True:
        loop_start = time.monotonic()
        try:
            count = publish_once(env)
            if count == len(REAL_LOGINS):
                backoff = interval
                consecutive_empty = 0
            else:
                if count == 0:
                    consecutive_empty += 1
                else:
                    consecutive_empty = 0
                backoff = min(60, max(interval * 2, backoff * 2))
                log.warning("partial publish %d/%d · next sleep=%ss", count, len(REAL_LOGINS), backoff)
        except Exception as exc:  # noqa: BLE001
            log.exception("publish_once crashed: %s", exc)
            consecutive_empty += 1
            backoff = min(60, max(interval * 2, backoff * 2))

        if args.once:
            return

        if consecutive_empty >= MAX_CONSECUTIVE_EMPTY:
            log.error("%d consecutive empty cycles — exiting so the supervisor restarts", consecutive_empty)
            sys.exit(1)

        elapsed = time.monotonic() - loop_start
        time.sleep(max(0.5, backoff - elapsed))


if __name__ == "__main__":
    main()
