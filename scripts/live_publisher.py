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
import threading
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

# Roster de cuentas reales por VPS — se define en .live_publisher.env de cada
# VPS (REAL_LOGINS=comma-list, LIVE_VPS_TAG=vpsN, LOGIN_TERMINAL_MAP=
# login=path;login=path). Este default solo aplica si el env file no lo trae.
# Sync con verify_integrity.EXPECTED_REAL y post_merge.detect_real_accounts.
REAL_LOGINS: set[int] = {25425, 32081, 43306}
TERMINAL_GLOB = r"C:\Program Files\MetaTrader 5 *\terminal64.exe"

# Exit (so Railway restarts the SSH session) after a login is missing this many
# consecutive cycles — indicates that terminal is unreachable / down.
MAX_MISSING_STREAK = 6

# Historia intradía persistente (F1): 1 de cada N ciclos publicados también se
# INSERTa en public.live_real_history (~30s con interval=3). Best-effort: un
# fallo aquí NUNCA rompe el stream de live_real_state. La retención la aplica
# el RPC prune_live_real_history() (ver supabase/live_real_history.sql) que
# este proceso invoca una vez por hora.
HISTORY_EVERY_N = int(os.environ.get("LIVE_HISTORY_EVERY_N", "10"))
PRUNE_EVERY_SECS = 3600

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
        for raw in ENV_PATH.read_text(encoding="utf-8-sig").splitlines():
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


def configure(env: dict[str, str]) -> None:
    """Apply per-VPS roster/tag/terminal-map from env (process env wins over
    the env file, file wins over module defaults)."""
    global LIVE_VPS_TAG, PUBLISHER_ID, REAL_LOGINS

    def _val(key: str) -> str:
        return os.environ.get(key) or env.get(key) or ""

    tag = _val("LIVE_VPS_TAG")
    if tag:
        LIVE_VPS_TAG = tag
        PUBLISHER_ID = f"{LIVE_VPS_TAG}-{socket.gethostname()}"

    logins_raw = _val("REAL_LOGINS")
    if logins_raw:
        REAL_LOGINS = {int(x) for x in logins_raw.replace(";", ",").split(",") if x.strip()}

    # Seed the login->terminal cache so the first cycle skips the full scan
    # (a cold scan of ~14 terminals overruns the cycle timeout).
    map_raw = _val("LOGIN_TERMINAL_MAP")
    for pair in map_raw.split(";"):
        if "=" not in pair:
            continue
        login_s, path = pair.split("=", 1)
        try:
            _login_path_cache[int(login_s.strip())] = path.strip()
        except ValueError:
            log.warning("LOGIN_TERMINAL_MAP: bad login %r", login_s)


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

        # DNA: never publish a fresh ts over stale data. If the terminal lost
        # its broker link, account_info still returns the last cached snapshot —
        # publishing it would paint the pill green over dead numbers. Skip the
        # row instead; ts stops advancing and the dashboard goes stale → red.
        ti = mt5.terminal_info()
        if ti is None or not getattr(ti, "connected", False):
            log.warning("terminal login=%s not connected to broker — skipping cycle", login)
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

# Reintentos intra-ciclo del upsert: un blip de red <3s recupera el tick sin
# perderlo (antes: 1 intento y el ciclo entero se daba por perdido). Corto a
# propósito — el loop de ~3s ya es el retry de fondo.
UPSERT_BACKOFF = (0.5, 2.0)

# Generación del ciclo vigente. Un retry (o un thread colgado de un ciclo
# anterior, ver publish_once_timed) que despierte cuando ya arrancó un ciclo
# más nuevo debe abortar: upsertaría equity vieja y el trigger set_ts la
# estamparía como fresca (pill verde sobre números muertos).
_cycle_gen = 0


def upsert_state(env: dict[str, str], rows: list[dict[str, Any]], gen: int) -> bool:
    if not rows:
        return True
    headers = {
        "apikey": env["SUPABASE_SERVICE_KEY"],
        "Authorization": f'Bearer {env["SUPABASE_SERVICE_KEY"]}',
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    url = f'{env["SUPABASE_URL"].rstrip("/")}/rest/v1/live_real_state?on_conflict=login'
    last_err = ""
    for attempt in range(len(UPSERT_BACKOFF) + 1):
        if gen != _cycle_gen:
            log.warning("upsert abandoned: cycle %d superseded by %d", gen, _cycle_gen)
            return False
        try:
            r = requests.post(url, headers=headers, json=rows, timeout=HTTP_TIMEOUT)
            if r.status_code < 300:
                if attempt:
                    log.info("supabase upsert recovered on retry %d", attempt)
                return True
            last_err = f"HTTP {r.status_code} body={r.text[:300]}"
            if r.status_code < 500:
                break  # 4xx no es transitorio — reintentar no ayuda
        except requests.RequestException as exc:
            last_err = f"network error: {exc}"
        if attempt < len(UPSERT_BACKOFF):
            time.sleep(UPSERT_BACKOFF[attempt])
    log.error("supabase upsert failed: %s", last_err)
    return False


def _service_headers(env: dict[str, str]) -> dict[str, str]:
    return {
        "apikey": env["SUPABASE_SERVICE_KEY"],
        "Authorization": f'Bearer {env["SUPABASE_SERVICE_KEY"]}',
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


def insert_history(env: dict[str, str], rows: list[dict[str, Any]]) -> None:
    """Downsampled INSERT into live_real_history. Best-effort: log-and-continue."""
    if not rows:
        return
    hist = []
    for r in rows:
        margin = float(r.get("margin") or 0)
        equity = float(r.get("equity") or 0)
        hist.append({
            "login": r["login"],
            "equity": equity,
            "balance": r.get("balance"),
            "floating_pnl": r.get("profit"),
            "margin_level": round(equity / margin * 100, 2) if margin > 0 else None,
        })
    url = f'{env["SUPABASE_URL"].rstrip("/")}/rest/v1/live_real_history'
    try:
        resp = requests.post(url, headers=_service_headers(env), json=hist, timeout=HTTP_TIMEOUT)
        if resp.status_code >= 300:
            log.warning("history insert HTTP %s body=%s", resp.status_code, resp.text[:200])
    except requests.RequestException as exc:
        log.warning("history insert network error: %s", exc)


# Heartbeat activo: una fila por publisher, cada ciclo, PUBLIQUE o no. El
# watchdog distingue así "publisher muerto" (heartbeat viejo) de "MT5/broker
# caído" (heartbeat fresco con published_logins vacío). 1 intento corto —
# el ciclo siguiente (~3s) es el retry. Si la tabla aún no existe (404) se
# desactiva para no llenar el log.
_hb_disabled = False


def upsert_heartbeat(
    env: dict[str, str],
    published: set[int],
    missing_streak: dict[int, int],
    cycle_ms: int,
    interval: float,
) -> None:
    global _hb_disabled
    if _hb_disabled:
        return
    row = {
        "publisher_id": PUBLISHER_ID,
        "vps": LIVE_VPS_TAG,
        "cycle_ms": cycle_ms,
        "published_logins": sorted(published),
        "missing_streak": {str(k): v for k, v in missing_streak.items()},
        "interval_secs": interval,
    }
    headers = dict(_service_headers(env))
    headers["Prefer"] = "resolution=merge-duplicates,return=minimal"
    url = f'{env["SUPABASE_URL"].rstrip("/")}/rest/v1/publisher_heartbeat?on_conflict=publisher_id'
    try:
        r = requests.post(url, headers=headers, json=row, timeout=HTTP_TIMEOUT)
        if r.status_code == 404:
            _hb_disabled = True
            log.warning("publisher_heartbeat table missing (404) — heartbeat off; run supabase/publisher_heartbeat.sql")
        elif r.status_code >= 300:
            log.warning("heartbeat HTTP %s body=%s", r.status_code, r.text[:200])
    except requests.RequestException as exc:
        log.warning("heartbeat network error: %s", exc)


def prune_history(env: dict[str, str]) -> None:
    """Hourly retention/compaction via RPC. Best-effort."""
    url = f'{env["SUPABASE_URL"].rstrip("/")}/rest/v1/rpc/prune_live_real_history'
    try:
        resp = requests.post(url, headers=_service_headers(env), json={}, timeout=30)
        if resp.status_code >= 300:
            log.warning("history prune HTTP %s body=%s", resp.status_code, resp.text[:200])
        else:
            log.info("history prune ok")
    except requests.RequestException as exc:
        log.warning("history prune network error: %s", exc)


# --- Tuning shadow (aprendizaje continuo) ----------------------------------
# SHADOW MODE: lee data/tuning.json de Storage 1×/hora y loguea la cadencia que
# el adaptive_tuner recomendaría vs la vigente. NO aplica nada — el cambio de
# intervalo real requiere veredicto del owner tras ≥1 semana de shadow.
_TUNING_FETCH_SECS = 3600
_last_tuning_fetch = 0.0


def log_tuning_shadow(env: dict[str, str]) -> None:
    global _last_tuning_fetch
    now = time.monotonic()
    if _last_tuning_fetch and now - _last_tuning_fetch < _TUNING_FETCH_SECS:
        return
    _last_tuning_fetch = now
    url = f'{env["SUPABASE_URL"].rstrip("/")}/storage/v1/object/dashboard-data/tuning.json'
    headers = {
        "apikey": env["SUPABASE_SERVICE_KEY"],
        "Authorization": f'Bearer {env["SUPABASE_SERVICE_KEY"]}',
    }
    try:
        r = requests.get(url, headers=headers, timeout=HTTP_TIMEOUT)
        if r.status_code != 200:
            return
        rec = (r.json().get("recommendations") or {}).get("live_tick_secs") or {}
        if rec and rec.get("recommended") != rec.get("current"):
            log.info(
                "tuning shadow: recomendaría tick=%ss (vigente %ss) — %s [NO aplicado]",
                rec.get("recommended"), rec.get("current"), rec.get("reason"),
            )
    except (requests.RequestException, ValueError):
        pass  # shadow es best-effort puro


# --- Main loop -----------------------------------------------------------

# Cycle counter for the downsampled history insert (module-level so
# publish_once keeps its signature for --once and the timed wrapper).
_cycle_count = 0
_last_prune = 0.0


def publish_once(env: dict[str, str]) -> set[int]:
    """Return the set of logins successfully published this cycle (empty on failure)."""
    global _cycle_count, _last_prune, _cycle_gen
    _cycle_gen += 1
    gen = _cycle_gen
    rows = collect_real_snapshots()
    if not rows:
        return set()
    ok = upsert_state(env, rows, gen)
    if not ok:
        return set()

    # Historia persistente: cada N ciclos buenos + prune horario (best-effort).
    _cycle_count += 1
    if _cycle_count % HISTORY_EVERY_N == 1:  # también cubre el primer ciclo
        insert_history(env, rows)
    now_mono = time.monotonic()
    if now_mono - _last_prune >= PRUNE_EVERY_SECS:
        _last_prune = now_mono
        prune_history(env)
    log.info(
        "published %d rows (logins=%s ages_ms=%s)",
        len(rows),
        ",".join(str(r["login"]) for r in rows),
        ",".join(str(r["source_age_ms"]) for r in rows),
    )
    return {int(r["login"]) for r in rows}


def publish_once_timed(env: dict[str, str], timeout: float) -> set[int]:
    """Run one cycle with a hard wall-clock cap. A hung mt5.initialize would
    otherwise freeze the loop forever (zombie that never trips the exit guard);
    here the loop keeps advancing, the per-login streak grows, and exit(1) lets
    the Railway supervisor restart with a fresh process (which reaps the leaked
    daemon thread)."""
    box: dict[str, set[int]] = {}
    def _run() -> None:
        try:
            box["v"] = publish_once(env)
        except Exception as exc:  # noqa: BLE001
            log.exception("publish_once crashed: %s", exc)
            box["v"] = set()
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        log.error("publish cycle exceeded %ss (MT5 hung?) — treating as empty", timeout)
        return set()
    return box.get("v", set())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="single cycle then exit")
    ap.add_argument("--loop", action="store_true", help="continuous (default)")
    ap.add_argument("--interval", type=float, default=DEFAULT_INTERVAL, help="seconds between cycles")
    args = ap.parse_args()

    interval = max(1.0, float(args.interval))
    env = load_env()
    configure(env)
    log.info(
        "live_publisher starting · interval=%ss · target_logins=%s · publisher=%s",
        interval, sorted(REAL_LOGINS), PUBLISHER_ID,
    )

    backoff = interval
    cycle_timeout = max(10.0, interval * 4)
    # Per-login miss streak: a login missing for MAX_MISSING_STREAK cycles trips
    # exit(1). Tracking per-login (not a global empty counter) catches the case
    # where one terminal is permanently dead while the other keeps publishing —
    # the old global counter reset every cycle and never fired.
    missing_streak = {lg: 0 for lg in REAL_LOGINS}

    while True:
        loop_start = time.monotonic()
        published = publish_once_timed(env, cycle_timeout)
        for lg in REAL_LOGINS:
            missing_streak[lg] = 0 if lg in published else missing_streak[lg] + 1

        cycle_ms = int((time.monotonic() - loop_start) * 1000)
        upsert_heartbeat(env, published, missing_streak, cycle_ms, interval)
        log_tuning_shadow(env)

        if published == REAL_LOGINS:
            backoff = interval
        else:
            backoff = min(20, max(interval * 2, backoff * 2))
            log.warning(
                "partial publish %d/%d · missing_streak=%s · next sleep=%ss",
                len(published), len(REAL_LOGINS), missing_streak, backoff,
            )

        if args.once:
            return

        worst = max(missing_streak.values())
        if worst >= MAX_MISSING_STREAK:
            log.error(
                "login(s) missing %d consecutive cycles (%s) — exiting so the supervisor restarts",
                worst, {k: v for k, v in missing_streak.items() if v >= MAX_MISSING_STREAK},
            )
            sys.exit(1)

        elapsed = time.monotonic() - loop_start
        time.sleep(max(0.5, backoff - elapsed))


if __name__ == "__main__":
    main()
