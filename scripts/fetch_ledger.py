#!/usr/bin/env python3
"""
fetch_ledger.py — pull the append-only ledgers from Supabase BEFORE post_merge
runs, so the cycle appends to the REAL history instead of an empty file. The CI
runner starts without data/*.jsonl (data/ is gitignored and not mirrored from
the VPS), so without this each ledger was rebuilt empty every cycle and the
upload clobbered the deployed history (down to ~today).

Hydrates two ledgers:
  - candidates_history.jsonl (forward tracker) — union key
    (date[:10], vps, login, magic), never trimmed.
  - history.jsonl (per-account equity series for the real-account sparklines,
    appended each cycle by mirror.sh) — union key (ts, login), trimmed to a
    rolling window so the boot payload stays bounded: real accounts keep
    HISTORY_REAL_DAYS, demo accounts keep HISTORY_DEMO_HOURS.

Behavior (fail-closed for safety):
  - 200  -> UNION with any existing local file (never shrink), write result.
  - 404  -> ledger does not exist yet (first run) — leave local as-is, exit 0.
  - other/network error -> exit 1 so mirror.sh ABORTS rather than appending to an
    empty ledger and overwriting the deployed history.
"""
from __future__ import annotations

import json
import ssl
import sys
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

import r2_read

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ENV_FILE = ROOT / ".env.local"
LEDGER = DATA_DIR / "candidates_history.jsonl"
BUCKET = "dashboard-data"
OBJ = "candidates_history.jsonl"

HISTORY = DATA_DIR / "history.jsonl"
HISTORY_OBJ = "history.jsonl"
# [Fase 2 Decision Center] Ledgers de ciclo de vida — append-only, mismas
# garantías anti-clobber que candidates_history (el runner de CI arranca vacío).
LIFECYCLE_EVENTS = DATA_DIR / "lifecycle_events.jsonl"
LIFECYCLE_EVENTS_OBJ = "lifecycle_events.jsonl"
PROMOTION_EVENTS = DATA_DIR / "promotion_events.jsonl"
PROMOTION_EVENTS_OBJ = "promotion_events.jsonl"
LIFECYCLE_STATE = DATA_DIR / "lifecycle_state.json"
LIFECYCLE_STATE_OBJ = "lifecycle_state.json"
HISTORY_RECENT = DATA_DIR / "history_recent.jsonl"
HISTORY_REAL_DAYS = 14   # equity rows for is_real accounts
HISTORY_DEMO_HOURS = 48  # equity rows for demo accounts (unused by the UI today)

try:
    import certifi  # type: ignore

    _CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _CTX = ssl.create_default_context()


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if not ENV_FILE.exists():
        return env
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def _is_not_found(exc: "urlerror.HTTPError") -> bool:
    """Supabase Storage responde 400 (no 404) para objetos inexistentes, con
    statusCode 404 / not_found en el body. Ambos son 'aún no existe' — primer
    ciclo de un objeto nuevo — y NO deben abortar el pipeline (bug real
    2026-08-04: lifecycle_events.jsonl nuevo abortó el cron en producción)."""
    if exc.code == 404:
        return True
    if exc.code == 400:
        try:
            body = exc.read().decode("utf-8", errors="replace")[:300]
        except Exception:  # noqa: BLE001
            return False
        low = body.lower()
        return "not_found" in low or "object not found" in low or '"statuscode":"404"' in low or '"statuscode": "404"' in low
    return False


def parse_lines(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass  # skip corrupt remote lines; post_merge surfaces local corruption
    return out


def key(r: dict):
    return (r.get("date", "")[:10], r.get("vps"), r.get("login"), r.get("magic"))


def hydrate(url: str, skey: str, obj: str, local_path: Path, key_fn, sort_key) -> list[dict] | None:
    """Fetch obj, union with local (never shrink), write. Returns merged rows,
    [] on first-run 404, None on error (caller aborts)."""
    # [EGRESS] R2 primero cuando CI_READ_SOURCE=r2; cualquier fallo de R2
    # (incluido 404: el espejo puede ir por detrás) cae a Supabase con la
    # semántica ABORT original intacta.
    body: bytes | None = None
    source = "supabase"
    if r2_read.read_source() == "r2":
        try:
            body = r2_read.r2_get_bytes(obj)
            source = "r2"
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch_ledger] r2 {obj}: {exc} — fallback a Supabase", file=sys.stderr)
    if body is None:
        endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{obj}"
        req = urlrequest.Request(endpoint, headers={"Authorization": f"Bearer {skey}", "apikey": skey})
        try:
            with urlrequest.urlopen(req, timeout=30, context=_CTX) as resp:
                body = resp.read()
        except urlerror.HTTPError as exc:
            if _is_not_found(exc):
                print(f"[fetch_ledger] {obj} not on Supabase yet (http {exc.code} not-found) — first run, leaving local as-is")
                return []
            print(f"[fetch_ledger] HTTP {exc.code} fetching {obj} — ABORT (won't risk clobber)", file=sys.stderr)
            return None
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch_ledger] error fetching {obj}: {exc} — ABORT (won't risk clobber)", file=sys.stderr)
            return None
        if r2_read.read_source() == "supabase":
            r2_read.shadow_compare(obj, body, "[fetch_ledger]")
    remote = parse_lines(body.decode("utf-8", errors="replace"))

    local = parse_lines(local_path.read_text(encoding="utf-8")) if local_path.exists() else []

    # Union — never shrink. Keep local row on key collision (local is freshest write).
    seen: dict = {}
    merged: list[dict] = []
    for r in local + remote:
        k = key_fn(r)
        if k not in seen:
            seen[k] = 1
            merged.append(r)
    merged.sort(key=sort_key)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    body = "\n".join(json.dumps(r, ensure_ascii=False) for r in merged)
    local_path.write_text(body + ("\n" if body else ""), encoding="utf-8")
    print(f"[fetch_ledger] {obj} [{source}]: remote={len(remote)} local={len(local)} -> {len(merged)} lines")
    return merged


def trim_history(rows: list[dict]) -> list[dict]:
    """Rolling window: real accounts keep HISTORY_REAL_DAYS, demos HISTORY_DEMO_HOURS."""
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    real_cut = (now - timedelta(days=HISTORY_REAL_DAYS)).isoformat()
    demo_cut = (now - timedelta(hours=HISTORY_DEMO_HOURS)).isoformat()
    kept = [
        r for r in rows
        if str(r.get("ts", "")) >= (real_cut if r.get("is_real") else demo_cut)
    ]
    return kept


def main() -> int:
    env = load_env()
    url, skey = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not skey:
        print("[fetch_ledger] no Supabase creds — skipping (local ledgers left as-is)", file=sys.stderr)
        return 0

    merged = hydrate(
        url, skey, OBJ, LEDGER, key,
        sort_key=lambda r: (r.get("date", "")[:10], str(r.get("vps")), str(r.get("login")), str(r.get("magic"))),
    )
    if merged is None:
        return 1

    hist = hydrate(
        url, skey, HISTORY_OBJ, HISTORY,
        key_fn=lambda r: (r.get("ts"), r.get("login")),
        sort_key=lambda r: (str(r.get("ts", "")), str(r.get("login"))),
    )
    if hist is None:
        return 1
    if hist:
        trimmed = trim_history(hist)
        if len(trimmed) != len(hist):
            body = "\n".join(json.dumps(r, ensure_ascii=False) for r in trimmed)
            HISTORY.write_text(body + ("\n" if body else ""), encoding="utf-8")
            print(f"[fetch_ledger] history.jsonl trimmed {len(hist)} -> {len(trimmed)} rows "
                  f"(real {HISTORY_REAL_DAYS}d / demo {HISTORY_DEMO_HOURS}h)")
        # history_recent.jsonl (delta sync): solo las filas que el dashboard
        # renderiza — cuentas reales (sparklines + curva semanal del War Room).
        # El cliente baja este recorte (~KB); history.jsonl completo queda en
        # Storage como archivo histórico. Corre aquí porque este es el único
        # punto del ciclo con la historia hidratada completa (el runner de CI
        # arranca con data/ vacío).
        recent = [r for r in trimmed if r.get("is_real")]
        body = "\n".join(json.dumps(r, ensure_ascii=False) for r in recent)
        HISTORY_RECENT.write_text(body + ("\n" if body else ""), encoding="utf-8")
        print(f"[fetch_ledger] history_recent.jsonl -> {len(recent)} real rows")

    # [Fase 2] lifecycle_events / promotion_events: unión anti-clobber (ABORT en
    # error de red — perder un evento PROMOTED sería reescribir la historia).
    lev = hydrate(
        url, skey, LIFECYCLE_EVENTS_OBJ, LIFECYCLE_EVENTS,
        key_fn=lambda r: (r.get("ts"), r.get("magic"), r.get("from"), r.get("to")),
        sort_key=lambda r: (str(r.get("ts", "")), str(r.get("magic"))),
    )
    if lev is None:
        return 1
    pev = hydrate(
        url, skey, PROMOTION_EVENTS_OBJ, PROMOTION_EVENTS,
        key_fn=lambda r: (r.get("magic"), r.get("promoted_at")),
        sort_key=lambda r: (str(r.get("promoted_at", "")), str(r.get("magic"))),
    )
    if pev is None:
        return 1

    # lifecycle_state.json: estado previo (no ledger — se sobreescribe entero
    # cada ciclo por post_merge). 404 = primer ciclo, arranque limpio; error de
    # red = ABORT: sin estado previo cada transición se re-emitiría como nueva.
    body = None
    if r2_read.read_source() == "r2":
        try:
            body = r2_read.r2_get_bytes(LIFECYCLE_STATE_OBJ)
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch_ledger] r2 {LIFECYCLE_STATE_OBJ}: {exc} — fallback a Supabase", file=sys.stderr)
    if body is None:
        endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{LIFECYCLE_STATE_OBJ}"
        req = urlrequest.Request(endpoint, headers={"Authorization": f"Bearer {skey}", "apikey": skey})
        try:
            with urlrequest.urlopen(req, timeout=30, context=_CTX) as resp:
                body = resp.read()
        except urlerror.HTTPError as exc:
            if _is_not_found(exc):
                print(f"[fetch_ledger] lifecycle_state.json aún no existe (http {exc.code} not-found) — primer ciclo")
                body = None
            else:
                print(f"[fetch_ledger] HTTP {exc.code} en lifecycle_state — ABORT", file=sys.stderr)
                return 1
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch_ledger] error de red en lifecycle_state: {exc} — ABORT", file=sys.stderr)
            return 1
    if body is not None:
        try:
            json.loads(body)  # validación mínima antes de escribir
            LIFECYCLE_STATE.write_bytes(body)
            print("[fetch_ledger] lifecycle_state.json hidratado")
        except json.JSONDecodeError:
            print("[fetch_ledger] lifecycle_state corrupto en remoto — se ignora (arranque limpio)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
