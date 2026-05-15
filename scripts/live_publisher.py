"""
Kiz Capital LLC · Battle of Bots — Live equity publisher (VPS5)

Loops every LIVE_INTERVAL_SECS, queries MetaTrader5 for the 2 real accounts
(#25425 and #32081 on VPS5), and UPSERTs the snapshot into Supabase table
public.live_real_state. The dashboard subscribes to that table via Supabase
Realtime for sub-5s updates.

Deploy to VPS5 only:
    scp "Battle of Bots/scripts/live_publisher.py" trader@100.70.228.19:C:/mt5-mcp/live_publisher.py

Required env vars (read from C:\\mt5-mcp\\.live_publisher.env):
    SUPABASE_URL          https://sudnilwqhbfcjqnzzmhi.supabase.co
    SUPABASE_SERVICE_KEY  service_role key (write-capable, NEVER commit)

Per-account credentials are read from C:\\mt5-mcp\\accounts.json (same file
snapshot_builder.py uses; structure: { "vps": "vps5", "accounts": [
    { "login": 25425, "password": "...", "server": "...", "terminal": "C:\\..." },
    { "login": 32081, "password": "...", "server": "...", "terminal": "C:\\..." }
] }).

Run as a daemon under Task Scheduler (BattleOfBots_LivePublisher,
AtStartup + restart-on-failure 2 min).

Manual one-shot test:
    C:\\mt5-mcp\\venv\\Scripts\\python.exe C:\\mt5-mcp\\live_publisher.py --once
"""
from __future__ import annotations

import json
import logging
import os
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
import MetaTrader5 as mt5

# --- Config --------------------------------------------------------------

ROOT = Path(r"C:\mt5-mcp")
LOG_PATH = ROOT / "live_publisher.log"
ENV_PATH = ROOT / ".live_publisher.env"
ACCOUNTS_PATH = ROOT / "accounts.json"

LIVE_INTERVAL_SECS = int(os.environ.get("LIVE_INTERVAL_SECS", "5"))
LIVE_VPS_TAG = os.environ.get("LIVE_VPS_TAG", "vps5")
PUBLISHER_ID = f"{LIVE_VPS_TAG}-{socket.gethostname()}"
HTTP_TIMEOUT = 5

# --- Logging -------------------------------------------------------------

logging.basicConfig(
    filename=str(LOG_PATH),
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("live_publisher")
log.addHandler(logging.StreamHandler(sys.stdout))


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


def load_accounts() -> list[dict[str, Any]]:
    if not ACCOUNTS_PATH.exists():
        raise SystemExit(f"accounts file not found: {ACCOUNTS_PATH}")
    data = json.loads(ACCOUNTS_PATH.read_text(encoding="utf-8"))
    accounts = data.get("accounts", data) if isinstance(data, dict) else data
    real = [a for a in accounts if int(a.get("login", 0)) in (25425, 32081)]
    if not real:
        raise SystemExit("no real accounts (25425 / 32081) found in accounts.json")
    return real


# --- MT5 helpers ---------------------------------------------------------

def mt5_login(account: dict[str, Any]) -> bool:
    terminal = account.get("terminal") or account.get("path")
    ok = mt5.initialize(path=terminal) if terminal else mt5.initialize()
    if not ok:
        log.error("mt5.initialize failed for login=%s err=%s", account.get("login"), mt5.last_error())
        return False
    ok = mt5.login(
        login=int(account["login"]),
        password=str(account["password"]),
        server=str(account["server"]),
    )
    if not ok:
        log.error("mt5.login failed for login=%s err=%s", account.get("login"), mt5.last_error())
        mt5.shutdown()
        return False
    return True


def mt5_close() -> None:
    try:
        mt5.shutdown()
    except Exception:  # pragma: no cover
        pass


def snapshot_account(login: int) -> dict[str, Any] | None:
    info = mt5.account_info()
    if info is None:
        log.error("account_info() returned None for login=%s err=%s", login, mt5.last_error())
        return None
    info_d = info._asdict()
    if int(info_d.get("login", 0)) != int(login):
        log.warning("account mismatch: expected %s got %s", login, info_d.get("login"))
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
            "sl": pd.get("sl"),
            "tp": pd.get("tp"),
            "swap": pd.get("swap"),
            "profit": pd.get("profit"),
            "time_open": pd.get("time"),
            "comment": pd.get("comment"),
        })
    return {
        "login": int(login),
        "vps": LIVE_VPS_TAG,
        "ts": datetime.now(timezone.utc).isoformat(),
        "balance": float(info_d.get("balance") or 0),
        "equity": float(info_d.get("equity") or 0),
        "margin": float(info_d.get("margin") or 0),
        "free_margin": float(info_d.get("margin_free") or 0),
        "profit": float(info_d.get("profit") or 0),
        "positions": positions,
        "publisher_id": PUBLISHER_ID,
    }


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

def publish_once(env: dict[str, str], accounts: list[dict[str, Any]]) -> int:
    rows: list[dict[str, Any]] = []
    for account in accounts:
        t0 = time.monotonic()
        if not mt5_login(account):
            continue
        try:
            row = snapshot_account(int(account["login"]))
        finally:
            mt5_close()
        if row is None:
            continue
        row["source_age_ms"] = int((time.monotonic() - t0) * 1000)
        rows.append(row)
    ok = upsert_state(env, rows)
    if ok:
        log.info(
            "published %d rows ages_ms=%s",
            len(rows),
            ",".join(str(r.get("source_age_ms")) for r in rows),
        )
    return len(rows) if ok else 0


def main() -> None:
    env = load_env()
    accounts = load_accounts()
    log.info(
        "live_publisher starting · interval=%ss · accounts=%s · publisher=%s",
        LIVE_INTERVAL_SECS,
        [int(a["login"]) for a in accounts],
        PUBLISHER_ID,
    )

    once = "--once" in sys.argv
    backoff = LIVE_INTERVAL_SECS

    while True:
        loop_start = time.monotonic()
        try:
            count = publish_once(env, accounts)
            if count == len(accounts):
                backoff = LIVE_INTERVAL_SECS
            else:
                backoff = min(60, max(LIVE_INTERVAL_SECS * 2, backoff * 2))
                log.warning("partial publish %d/%d · next sleep=%ss", count, len(accounts), backoff)
        except Exception as exc:  # noqa: BLE001
            log.exception("publish_once crashed: %s", exc)
            backoff = min(60, max(LIVE_INTERVAL_SECS * 2, backoff * 2))
        if once:
            return
        elapsed = time.monotonic() - loop_start
        time.sleep(max(0.5, backoff - elapsed))


if __name__ == "__main__":
    main()
