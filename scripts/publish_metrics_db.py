#!/usr/bin/env python3
"""
publish_metrics_db.py — escritor SOMBRA de la capa Postgres (Fase 2).

Escribe, en paralelo al pipeline que ya existe, la historia que snapshot.json
NO puede contestar: cuando aparecio un bot, como evoluciono su score dia a
dia, que dia cambio de estado o de maquina, y como se ha portado el pipeline.

SOMBRA quiere decir exactamente eso: NADIE lo lee todavia. No hay consumidor
en app.js, ni en el dashboard, ni en ningun script. Se escribe para que
cuando exista la pregunta, ya exista la respuesta — un historial no se puede
crear retroactivamente.

CONTRATO DURO: este script NUNCA rompe un ciclo. Sin credenciales, con la
tabla sin migrar (404), con la red caida o con un 500 del servidor, imprime
un mensaje claro y sale 0. mirror.sh ademas lo llama con guarda.

Kill switch:  DB_SHADOW_WRITE=0  lo desactiva por completo.

Entradas (todas de data/, ninguna toca una VPS):
  data/snapshot.json            obligatorio
  data/pipeline_timing.json     opcional (etapas de la fila de salud)
  data/integrity_report.json    opcional (ok / verify_rc de la fila de salud)
  data/shadow/db_state.json     estado del ciclo anterior, para los eventos.
                                Si no existe se crea y el primer ciclo emite
                                un `first_seen` por bot y nada mas.

Salida HTTP: mismo estilo que upload_to_supabase.py — urllib de la stdlib,
cabeceras apikey + Authorization: Bearer, Prefer: resolution=merge-duplicates
,return=minimal, y reintentos SOLO en errores de red.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import ssl
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ENV_FILE = ROOT / ".env.local"
SNAPSHOT = DATA_DIR / "snapshot.json"
TIMING_FILE = DATA_DIR / "pipeline_timing.json"
REPORT_FILE = DATA_DIR / "integrity_report.json"
SHADOW_DIR = DATA_DIR / "shadow"
STATE_FILE = SHADOW_DIR / "db_state.json"

BATCH = 500          # filas por POST. PostgREST traga mas, pero 500 mantiene
                     # cada cuerpo < ~250 KB y un fallo cuesta poco reintentar.
STATE_SCHEMA = 1

# Tipos de evento permitidos — mismo contrato que el comentario de
# supabase/migrations/004_bot_events.sql.
EVENT_TYPES = {
    "first_seen", "status_change", "seat_change", "vps_move",
    "dormant", "decay_flag", "drift_flag", "missing", "real_promoted",
}

# Estados que ocupan asiento (READY es el cap de 3 del ranking). Un cambio de
# entrar/salir de asiento es lo que el owner mira, no el score en si.
SEATED_STATUSES = {"READY"}

# Dias sin un cierre nuevo tras los que un bot se considera dormido. 30 dias
# es una ventana entera de `net_30d`: por debajo de eso, un bot de cadencia
# lenta (el arquetipo "sparse" opera 1 dia de cada 5) generaria falsos
# positivos cada vez que se toma unas semanas libres.
DORMANT_DAYS = 30

# Mismo contexto SSL explicito que upload_to_supabase.py.
try:
    import certifi  # type: ignore

    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _SSL_CTX = ssl.create_default_context()

_RETRYABLE = (ssl.SSLError, socket.timeout, TimeoutError, ConnectionError)


def log(msg: str) -> None:
    print(f"[db-shadow] {msg}")


def warn(msg: str) -> None:
    print(f"[db-shadow] {msg}", file=sys.stderr)


# ----------------------- HTTP (copia del estilo del uploader) -----------------------

def urlopen_retry(req, timeout: int, tries: int = 3):
    """urlopen con contexto SSL explicito + backoff SOLO en errores de red.

    Un HTTPError es un estado del servidor, no algo transitorio: reintentarlo
    solo retrasa el diagnostico. Identico al helper de upload_to_supabase.py.
    """
    last: BaseException | None = None
    for attempt in range(tries):
        try:
            return urlrequest.urlopen(req, timeout=timeout, context=_SSL_CTX)
        except urlerror.HTTPError:
            raise
        except urlerror.URLError as exc:
            last = exc
            if not isinstance(getattr(exc, "reason", None), _RETRYABLE):
                raise
        except _RETRYABLE as exc:
            last = exc
        if attempt < tries - 1:
            time.sleep(1.5 * (attempt + 1))
    assert last is not None
    raise last


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if not ENV_FILE.exists():
        return env
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def creds() -> tuple[str | None, str | None]:
    env = load_env()
    url = os.environ.get("SUPABASE_URL") or env.get("SUPABASE_URL")
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
           or env.get("SUPABASE_SERVICE_ROLE_KEY"))
    return url, key


def post_rows(base: str, key: str, table: str, rows: list[dict],
              on_conflict: str | None) -> tuple[bool, str]:
    """UPSERT de un lote. Devuelve (ok, nota). Nunca lanza."""
    if not rows:
        return True, "vacio"
    endpoint = f"{base.rstrip('/')}/rest/v1/{table}"
    if on_conflict:
        endpoint += f"?on_conflict={on_conflict}"
    body = json.dumps(rows, ensure_ascii=False, allow_nan=False).encode()
    req = urlrequest.Request(
        endpoint,
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "apikey": key,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        method="POST",
    )
    try:
        with urlopen_retry(req, timeout=30) as resp:
            if resp.status >= 300:
                return False, f"http {resp.status}"
            return True, ""
    except urlerror.HTTPError as exc:
        if exc.code == 404:
            return False, (f"http 404 — la tabla `{table}` no existe todavia; "
                           f"corre `scripts/migrate.py --check-rest` y aplica "
                           f"supabase/migrations/")
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        return False, f"http {exc.code} {detail}".strip()
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


# ----------------------- helpers de datos -----------------------

def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def num(value):
    """Numero JSON-serializable o None. Filtra NaN/Infinity, que PostgREST
    rechaza y que el frontend tampoco sabe pintar."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
        if f != f or f in (float("inf"), float("-inf")):
            return None
        return value
    return None


def as_int(value):
    v = num(value)
    return None if v is None else int(v)


def iso_utc(value):
    """ISO-8601 aware en UTC, o None. Acepta epoch y cadenas del snapshot."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
        except (ValueError, OSError, OverflowError):
            return None
    try:
        txt = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(txt)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def as_of_date(generated_at) -> str:
    """Fecha UTC de snapshot.generated_at. Se ancla al snapshot y NUNCA al
    reloj de pared: dos corridas del mismo snapshot deben caer en la misma
    fila (es la misma regla que kiz/windows.anchor_ts y el gate de
    determinismo)."""
    iso = iso_utc(generated_at)
    if iso:
        return iso[:10]
    return datetime.now(timezone.utc).date().isoformat()


def bot_key(bot: dict) -> str | None:
    """'<login>-<magic>'. SIN el VPS: el renumerado del 2026-07-27 probo que
    una etiqueta de maquina no es una identidad, y meterla en la clave habria
    partido en dos la historia de cada bot ese dia. Ver 002_bot_registry.sql."""
    login = bot.get("account_login")
    magic = bot.get("magic")
    if login is None or not magic:
        return None
    return f"{login}-{magic}"


def drift_flag_of(bot: dict):
    """post_merge escribe `drift` como dict con `flag`; no hay campo plano."""
    drift = bot.get("drift")
    if isinstance(drift, dict) and "flag" in drift:
        return bool(drift.get("flag"))
    return None


def is_real_of(bot: dict) -> bool:
    """post_merge deja `is_real` plano en el bot; el respaldo es real_vs_demo,
    que fue la fuente antes del arreglo de QUERY_FIELDS."""
    if "is_real" in bot:
        return bool(bot.get("is_real"))
    rvd = bot.get("real_vs_demo")
    if isinstance(rvd, dict):
        return bool(rvd.get("is_real"))
    return False


# ----------------------- construccion de filas -----------------------

# Campos que entran en metrics_hash: SOLO valores metricos. cycle_sha y
# updated_at quedan fuera a proposito — cambian cada ciclo y harian que el
# hash no sirviera para decir "este bot no se movio".
HASH_FIELDS = (
    "trades_lifetime", "net_profit_lifetime", "net_after_commission_lifetime",
    "net_365d", "net_30d", "win_rate_pct_lifetime", "profit_factor_lifetime",
    "max_drawdown_lifetime", "max_drawdown_365d", "dd_pct_of_balance",
    "calmar_365d", "sortino_365d", "months_active_lifetime",
    "months_active_365d", "return_monthly_pct_365d", "promotion_score",
    "promotion_score_v2", "promotion_status", "decay_flag", "drift_flag",
    "balance",
)


def metrics_hash(row: dict) -> str:
    """sha256 estable de los valores metricos de la fila.

    `sort_keys` + separadores fijos para que el hash no dependa del orden de
    insercion del dict ni de la version de Python.
    """
    payload = {k: row.get(k) for k in HASH_FIELDS}
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def balances_by_login(snap: dict) -> dict:
    out = {}
    for acc in snap.get("accounts") or []:
        login = acc.get("login")
        if login is not None:
            out[login] = acc.get("balance")
    return out


def build_metric_row(bot: dict, as_of: str, cycle_sha: str,
                     balance) -> dict | None:
    key = bot_key(bot)
    if not key:
        return None
    row = {
        "bot_key": key,
        "as_of": as_of,
        "cycle_sha": cycle_sha,
        "trades_lifetime": as_int(bot.get("trades_lifetime")),
        # `net_profit` sin sufijo YA es de por vida tras reconcile_snapshot,
        # pero SIN comision (metrics_meta.legacy_unsuffixed lo documenta).
        "net_profit_lifetime": num(bot.get("net_profit")),
        "net_after_commission_lifetime": num(bot.get("net_after_commission_lifetime")),
        # Canonico de 365 d = con comision; el legado `net_profit_365d` es el
        # respaldo cuando el bot no llego a pasar por kiz/metrics.
        "net_365d": num(bot.get("net_after_commission_365d")
                        if bot.get("net_after_commission_365d") is not None
                        else bot.get("net_profit_365d")),
        "net_30d": num(bot.get("net_30d")),
        "win_rate_pct_lifetime": num(bot.get("win_rate_pct_lifetime")),
        "profit_factor_lifetime": num(bot.get("profit_factor_lifetime")),
        "max_drawdown_lifetime": num(bot.get("max_drawdown_lifetime")),
        "max_drawdown_365d": num(bot.get("max_drawdown_365d")),
        "dd_pct_of_balance": num(bot.get("dd_pct_of_balance")),
        "calmar_365d": num(bot.get("calmar_365d")),
        "sortino_365d": num(bot.get("sortino_365d")),
        "months_active_lifetime": as_int(bot.get("months_active_lifetime")),
        "months_active_365d": as_int(bot.get("months_active_365d")),
        "return_monthly_pct_365d": num(bot.get("return_monthly_pct_365d")),
        "promotion_score": num(bot.get("promotion_score")),
        "promotion_score_v2": num(bot.get("promotion_score_v2")),
        "promotion_status": bot.get("promotion_status"),
        "decay_flag": (None if bot.get("decay_flag") is None
                       else bool(bot.get("decay_flag"))),
        "drift_flag": drift_flag_of(bot),
        "balance": num(balance),
    }
    row["metrics_hash"] = metrics_hash(row)
    return row


def build_registry_row(bot: dict, now_iso: str) -> dict | None:
    key = bot_key(bot)
    if not key:
        return None
    symbols = bot.get("symbols")
    return {
        "bot_key": key,
        "login": int(bot["account_login"]),
        "magic": int(bot["magic"]),
        "vps": bot.get("vps") or "unknown",
        "symbols": list(symbols) if isinstance(symbols, list) else None,
        "is_real": is_real_of(bot),
        "last_seen": now_iso,
        "active": True,
        "meta": {"promotion_status": bot.get("promotion_status")},
        # first_seen / first_trade solo se mandan cuando los conocemos: en un
        # UPSERT, mandar first_seen cada ciclo lo re-escribiria y borraria
        # justo el dato que esta tabla existe para guardar.
    }


def build_rows(snap: dict, cycle_sha: str, now_iso: str) -> tuple[list, list]:
    """(registry_rows, metric_rows) a partir de un snapshot ya cargado."""
    as_of = as_of_date(snap.get("generated_at"))
    balances = balances_by_login(snap)
    registry, metrics = [], []
    for bot in snap.get("bots") or []:
        if not bot.get("magic"):
            continue  # magic 0 = actividad manual, no es un bot
        reg = build_registry_row(bot, now_iso)
        if reg is None:
            continue
        first_trade = iso_utc(bot.get("first_trade"))
        if first_trade:
            reg["first_trade"] = first_trade
        registry.append(reg)
        met = build_metric_row(bot, as_of,
                               cycle_sha, balances.get(bot.get("account_login")))
        if met is not None:
            metrics.append(met)
    return registry, metrics


# ----------------------- eventos (diff contra el ciclo anterior) -----------------------

def is_dormant(bot: dict, generated_at) -> bool:
    """Sin cierres nuevos en DORMANT_DAYS. Se ancla a snapshot.generated_at y
    no al reloj: la misma entrada debe dar el mismo veredicto siempre."""
    last = iso_utc(bot.get("last_trade"))
    anchor = iso_utc(generated_at)
    if not last or not anchor:
        return False
    try:
        age_days = ((datetime.fromisoformat(anchor)
                     - datetime.fromisoformat(last)).total_seconds() / 86400.0)
    except (TypeError, ValueError):
        return False
    return age_days > DORMANT_DAYS


def state_from(snap: dict, now_iso: str) -> dict:
    """Estado minimo que hay que recordar para detectar transiciones."""
    generated_at = snap.get("generated_at")
    bots = {}
    for bot in snap.get("bots") or []:
        key = bot_key(bot)
        if not key or not bot.get("magic"):
            continue
        bots[key] = {
            "vps": bot.get("vps"),
            "promotion_status": bot.get("promotion_status"),
            "seated": bot.get("promotion_status") in SEATED_STATUSES,
            "decay_flag": bool(bot.get("decay_flag")),
            "drift_flag": bool(drift_flag_of(bot)),
            "is_real": is_real_of(bot),
            "dormant": is_dormant(bot, generated_at),
            "trades_lifetime": as_int(bot.get("trades_lifetime")),
        }
    return {
        "schema": STATE_SCHEMA,
        "generated_at": snap.get("generated_at"),
        "written_at": now_iso,
        "bots": bots,
    }


def _event(key, kind, before, after, cycle_sha, now_iso, detail=None) -> dict:
    assert kind in EVENT_TYPES, f"tipo de evento fuera de contrato: {kind}"
    row = {
        "bot_key": key,
        "event_type": kind,
        "from_value": None if before is None else str(before),
        "to_value": None if after is None else str(after),
        "cycle_sha": cycle_sha,
        "occurred_at": now_iso,
    }
    if detail:
        row["detail"] = detail
    return row


def diff_events(prev: dict | None, cur: dict, cycle_sha: str,
                now_iso: str) -> list[dict]:
    """Eventos entre el ciclo anterior y este.

    PRIMER CICLO (prev vacio): un `first_seen` por bot y NADA mas. Sin estado
    previo no hay transicion que observar, y emitir status_change/decay para
    los 623 bots a la vez llenaria la bitacora de ruido que nadie pidio.
    """
    cur_bots = cur.get("bots") or {}
    prev_bots = (prev or {}).get("bots") or {}
    out: list[dict] = []

    if not prev_bots:
        for key in sorted(cur_bots):
            out.append(_event(key, "first_seen", None,
                              cur_bots[key].get("promotion_status"),
                              cycle_sha, now_iso))
        return out

    for key in sorted(cur_bots):
        now_b = cur_bots[key]
        old_b = prev_bots.get(key)
        if old_b is None:
            out.append(_event(key, "first_seen", None,
                              now_b.get("promotion_status"), cycle_sha, now_iso))
            continue

        if old_b.get("promotion_status") != now_b.get("promotion_status"):
            out.append(_event(key, "status_change", old_b.get("promotion_status"),
                              now_b.get("promotion_status"), cycle_sha, now_iso))
        if bool(old_b.get("seated")) != bool(now_b.get("seated")):
            out.append(_event(key, "seat_change", bool(old_b.get("seated")),
                              bool(now_b.get("seated")), cycle_sha, now_iso))
        if old_b.get("vps") != now_b.get("vps"):
            # Cambio de maquina, NO cambio de identidad: por eso bot_key no
            # lleva el VPS (renumerado 2026-07-27).
            out.append(_event(key, "vps_move", old_b.get("vps"),
                              now_b.get("vps"), cycle_sha, now_iso))
        if bool(old_b.get("decay_flag")) != bool(now_b.get("decay_flag")):
            out.append(_event(key, "decay_flag", bool(old_b.get("decay_flag")),
                              bool(now_b.get("decay_flag")), cycle_sha, now_iso))
        if bool(old_b.get("drift_flag")) != bool(now_b.get("drift_flag")):
            out.append(_event(key, "drift_flag", bool(old_b.get("drift_flag")),
                              bool(now_b.get("drift_flag")), cycle_sha, now_iso))
        if bool(old_b.get("dormant")) != bool(now_b.get("dormant")):
            out.append(_event(key, "dormant", bool(old_b.get("dormant")),
                              bool(now_b.get("dormant")), cycle_sha, now_iso,
                              detail={"threshold_days": DORMANT_DAYS}))
        if (not old_b.get("is_real")) and now_b.get("is_real"):
            out.append(_event(key, "real_promoted", False, True,
                              cycle_sha, now_iso))

    # Bots que estaban y este ciclo no vinieron. NO se marcan inactivos aqui:
    # un VPS caido no es un bot muerto (regla de la cesta fija). Solo se anota.
    for key in sorted(set(prev_bots) - set(cur_bots)):
        out.append(_event(key, "missing", prev_bots[key].get("promotion_status"),
                          None, cycle_sha, now_iso,
                          detail={"last_vps": prev_bots[key].get("vps")}))
    return out


# ----------------------- fila de salud del pipeline -----------------------

def build_health_row(snap: dict, cycle_sha: str, now_iso: str) -> dict | None:
    """None cuando no hay GITHUB_RUN_ID: en local no se inventa un id, porque
    un run_id falso contamina las estadisticas de la tabla para siempre."""
    run_id = os.environ.get("GITHUB_RUN_ID")
    if not run_id or not run_id.isdigit():
        return None

    timing = read_json(TIMING_FILE) or {}
    report = read_json(REPORT_FILE) or {}
    cycle = timing.get("cycle") if isinstance(timing.get("cycle"), dict) else {}

    stale = snap.get("stale_vps")
    n_stale = len(stale) if isinstance(stale, list) else None

    started_at = None
    e2e_ms = cycle.get("end_to_end_ms") if isinstance(cycle, dict) else None
    finished_at = iso_utc(report.get("generated_at")) or now_iso
    if isinstance(e2e_ms, (int, float)) and e2e_ms > 0:
        try:
            fin_dt = datetime.fromisoformat(finished_at)
            started_at = (fin_dt.timestamp() - float(e2e_ms) / 1000.0)
            started_at = datetime.fromtimestamp(started_at, tz=timezone.utc).isoformat()
        except (ValueError, OSError, OverflowError):
            started_at = None

    ok = report.get("ok")
    return {
        "run_id": int(run_id),
        "started_at": started_at,
        "finished_at": finished_at,
        "cycle_sha": cycle_sha,
        "ok": None if ok is None else bool(ok),
        "stages": cycle or None,
        "bots": len(snap.get("bots") or []),
        "vps_stale": n_stale,
        "partial_data": (None if snap.get("partial_data") is None
                         else bool(snap.get("partial_data"))),
        # verify_rc: 0 si el reporte dice ok, 1 si no. mirror.sh aborta antes
        # de llegar aqui cuando verify falla en modo estricto, asi que en la
        # practica esta fila casi siempre trae 0 — el valor esta por si el
        # dia de manana se llama fuera de esa compuerta.
        "verify_rc": None if ok is None else (0 if ok else 1),
    }


# ----------------------- envio -----------------------

def send_batched(base, key, table, rows, on_conflict) -> tuple[int, list[str]]:
    sent, notes = 0, []
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        ok, note = post_rows(base, key, table, chunk, on_conflict)
        if ok:
            sent += len(chunk)
        else:
            notes.append(f"{table}[{i}:{i + len(chunk)}]: {note}")
            break  # si un lote falla, los siguientes fallaran igual
    return sent, notes


# ----------------------- main -----------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="publish_metrics_db.py",
        description="Escritor sombra de la capa Postgres (nadie la lee todavia).",
    )
    ap.add_argument("--dry-run", action="store_true",
                    help="imprime lo que enviaria (conteos + fila de muestra) "
                         "y NO escribe absolutamente nada")
    ap.add_argument("--data-dir", default=None,
                    help="directorio data/ alternativo (para pruebas offline)")
    args = ap.parse_args(argv)

    # Kill switch. Primero de todo, antes de leer nada.
    if os.environ.get("DB_SHADOW_WRITE", "1") == "0":
        log("DB_SHADOW_WRITE=0 — capa sombra desactivada, no se escribe nada")
        return 0

    global DATA_DIR, SNAPSHOT, TIMING_FILE, REPORT_FILE, SHADOW_DIR, STATE_FILE
    if args.data_dir:
        DATA_DIR = Path(args.data_dir).resolve()
        SNAPSHOT = DATA_DIR / "snapshot.json"
        TIMING_FILE = DATA_DIR / "pipeline_timing.json"
        REPORT_FILE = DATA_DIR / "integrity_report.json"
        SHADOW_DIR = DATA_DIR / "shadow"
        STATE_FILE = SHADOW_DIR / "db_state.json"

    if not SNAPSHOT.exists():
        warn(f"sin {SNAPSHOT} — nada que publicar (no es un fallo del ciclo)")
        return 0
    snap = read_json(SNAPSHOT)
    if not isinstance(snap, dict):
        warn(f"{SNAPSHOT} ilegible — nada que publicar")
        return 0

    cycle_sha = file_sha256(SNAPSHOT)
    now_iso = datetime.now(timezone.utc).isoformat()
    as_of = as_of_date(snap.get("generated_at"))

    registry, metrics = build_rows(snap, cycle_sha, now_iso)
    prev_state = read_json(STATE_FILE) if STATE_FILE.exists() else None
    cur_state = state_from(snap, now_iso)
    events = diff_events(prev_state, cur_state, cycle_sha, now_iso)
    health = build_health_row(snap, cycle_sha, now_iso)

    # first_seen solo para los bots que el estado anterior no conocia: asi el
    # UPSERT no re-escribe el first_seen de un bot que ya estaba.
    known = set((prev_state or {}).get("bots") or {})
    for reg in registry:
        if reg["bot_key"] not in known:
            reg["first_seen"] = now_iso

    ev_kinds: dict[str, int] = {}
    for ev in events:
        ev_kinds[ev["event_type"]] = ev_kinds.get(ev["event_type"], 0) + 1

    log(f"snapshot as_of={as_of} cycle_sha={cycle_sha[:12]} "
        f"bots={len(snap.get('bots') or [])}")
    log(f"filas: registry={len(registry)} metric_daily={len(metrics)} "
        f"events={len(events)} pipeline_health={1 if health else 0}")
    if ev_kinds:
        log("eventos: " + " ".join(f"{k}={v}" for k, v in sorted(ev_kinds.items())))
    elif prev_state:
        log("eventos: ninguno — nada cambio respecto del ciclo anterior")

    if args.dry_run:
        log("DRY-RUN — no se envia ni se escribe nada (ni db_state.json)")
        if metrics:
            log("muestra bot_metric_daily:")
            print(json.dumps(metrics[0], indent=2, ensure_ascii=False,
                             sort_keys=True))
        if registry:
            log("muestra bot_registry:")
            print(json.dumps(registry[0], indent=2, ensure_ascii=False,
                             sort_keys=True))
        if events:
            log("muestra bot_events:")
            print(json.dumps(events[0], indent=2, ensure_ascii=False,
                             sort_keys=True))
        if health:
            log("muestra pipeline_health:")
            print(json.dumps(health, indent=2, ensure_ascii=False, sort_keys=True))
        else:
            log("pipeline_health: omitida (sin GITHUB_RUN_ID; no se inventa un id)")
        return 0

    base, key = creds()
    if not base or not key:
        warn("sin SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — capa sombra "
             "omitida este ciclo (el ciclo sigue siendo valido)")
        return 0

    notes: list[str] = []
    n_reg, nt = send_batched(base, key, "bot_registry", registry, "bot_key")
    notes += nt
    n_met, nt = send_batched(base, key, "bot_metric_daily", metrics,
                             "bot_key,as_of")
    notes += nt
    n_ev, nt = send_batched(base, key, "bot_events", events, None)
    notes += nt
    n_hl = 0
    if health:
        ok, note = post_rows(base, key, "pipeline_health", [health], "run_id")
        n_hl = 1 if ok else 0
        if not ok:
            notes.append(f"pipeline_health: {note}")

    log(f"enviado: registry={n_reg}/{len(registry)} "
        f"metric_daily={n_met}/{len(metrics)} events={n_ev}/{len(events)} "
        f"health={n_hl}/{1 if health else 0}")

    if notes:
        for note in notes:
            warn(note)
        warn("capa sombra INCOMPLETA este ciclo — el ciclo NO se ve afectado")
        # db_state NO se actualiza cuando algo fallo: si lo guardaramos, la
        # transicion que no llego a la base se perderia para siempre (el
        # proximo ciclo la veria como "sin cambios").
        return 0

    SHADOW_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cur_state, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    tmp.replace(STATE_FILE)
    log(f"estado guardado en {STATE_FILE.relative_to(DATA_DIR.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
