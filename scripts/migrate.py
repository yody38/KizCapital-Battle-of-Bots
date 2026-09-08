#!/usr/bin/env python3
"""
migrate.py — runner de migraciones de Postgres para Battle of Bots.

Tres modos, los tres seguros por construccion:

  --plan        lista los archivos de supabase/migrations/ y dice cuales
                estan pendientes. Sin URL de base de datos sigue siendo util:
                enumera el directorio y remite a --check-rest.

  --check-rest  NO necesita URL de base de datos. Usa la misma via REST que
                el resto del repo (service_role de .env.local) para sondear
                cada tabla esperada. Escribe data/schema_drift.json.

  --apply       requiere la variable de entorno SUPABASE_DB_URL. Ejecuta cada
                archivo pendiente con `psql -v ON_ERROR_STOP=1
                --single-transaction` y registra version+sha256 en
                schema_migrations DENTRO DE LA MISMA TRANSACCION.

Por que existe (2026-09-08): hasta hoy el esquema desplegado solo se podia
comprobar entrando al SQL Editor. El repo tenia cinco .sql sueltos y ninguna
prueba de cuales estaban aplicados. `--check-rest` es la pieza que convierte
"creo que esta aplicado" en un hecho verificable desde el repo, sin
credenciales de base de datos y sin tocar nada.

NUNCA se ejecuta solo: no hay cron, no lo llama mirror.sh, y el workflow que
lo expone es workflow_dispatch con confirmacion escrita.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import time
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = ROOT / "supabase" / "migrations"
DATA_DIR = ROOT / "data"
ENV_FILE = ROOT / ".env.local"
DRIFT_FILE = DATA_DIR / "schema_drift.json"

# Tabla que cada migracion deja en pie. `--check-rest` sondea justo estas: si
# el GET devuelve 200 la migracion esta aplicada, si devuelve 404 esta
# pendiente. 000 no crea nada, asi que se comprueba a traves de 001.
EXPECTED_TABLES = {
    "001_schema_migrations": "schema_migrations",
    "002_bot_registry": "bot_registry",
    "003_bot_metric_daily": "bot_metric_daily",
    "004_bot_events": "bot_events",
    "005_pipeline_health": "pipeline_health",
}

# El libro mayor no puede registrarse a si mismo antes de existir: si falta,
# 001 se aplica primero y el resto sigue el orden numerico.
LEDGER_VERSION = "001_schema_migrations"

# Mismo contexto SSL explicito que upload_to_supabase.py (los fallos
# CERTIFICATE_VERIFY_FAILED del 2026-06-07 motivaron el certifi).
try:
    import certifi  # type: ignore

    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _SSL_CTX = ssl.create_default_context()

_RETRYABLE = (ssl.SSLError, socket.timeout, TimeoutError, ConnectionError)


def urlopen_retry(req, timeout: int, tries: int = 3):
    """urlopen con contexto SSL explicito + backoff SOLO en errores de red.

    Copia deliberada del helper de upload_to_supabase.py: un HTTPError es un
    estado, no un fallo transitorio, y reintentarlo solo esconde el problema.
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
    """Mismo loader de .env.local que upload_to_supabase.py / emit_timing.py."""
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
    """(url, service_role_key). El entorno gana sobre .env.local (asi es en CI)."""
    env = load_env()
    url = os.environ.get("SUPABASE_URL") or env.get("SUPABASE_URL")
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
           or env.get("SUPABASE_SERVICE_ROLE_KEY"))
    return url, key


# ----------------------- descubrimiento de archivos -----------------------

_VERSION_RE = re.compile(r"^(\d{3})_([A-Za-z0-9_]+)\.sql$")


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def discover() -> list[dict]:
    """Migraciones ordenadas por numero. Ignora los .down.sql."""
    out: list[dict] = []
    if not MIGRATIONS_DIR.exists():
        return out
    for p in sorted(MIGRATIONS_DIR.iterdir()):
        if p.name.endswith(".down.sql"):
            continue
        m = _VERSION_RE.match(p.name)
        if not m:
            continue
        version = f"{m.group(1)}_{m.group(2)}"
        out.append({
            "version": version,
            "name": p.name,
            "path": p,
            "sha256": file_sha256(p),
            "down": (MIGRATIONS_DIR / f"{m.group(1)}_{m.group(2)}.down.sql"),
        })
    return out


# ----------------------- modo --plan -----------------------

def mode_plan(applied: set[str] | None) -> int:
    migrations = discover()
    if not migrations:
        print(f"[migrate] no hay migraciones en {MIGRATIONS_DIR}", file=sys.stderr)
        return 1

    print(f"[migrate] plan — {len(migrations)} migraciones en supabase/migrations/")
    pending = []
    for mg in migrations:
        has_down = mg["down"].exists()
        if applied is None:
            state = "?"
        elif mg["version"] in applied:
            state = "aplicada"
        else:
            state = "PENDIENTE"
            pending.append(mg)
        down = "" if has_down else "  [!] sin .down.sql"
        print(f"  {state:>10}  {mg['version']:<24} sha={mg['sha256'][:12]}{down}")

    if applied is None:
        print()
        print("[migrate] sin libro mayor a mano: no se sabe que esta aplicado.")
        print("[migrate] usa `--check-rest` (no necesita URL de base de datos)")
        print("[migrate] o `--apply` con SUPABASE_DB_URL para resolverlo.")
        return 0

    print()
    if pending:
        print(f"[migrate] PENDIENTES: {len(pending)} -> "
              + ", ".join(m["version"] for m in pending))
    else:
        print("[migrate] nada pendiente: el esquema del repo esta aplicado.")
    return 0


# ----------------------- modo --check-rest -----------------------

def probe_table(base: str, key: str, table: str) -> tuple[int | None, str]:
    """GET /rest/v1/<table>?select=count&limit=0 -> (status_http, nota).

    200 = la tabla existe. 404 = PostgREST no la conoce -> migracion
    pendiente. Cualquier otro codigo se reporta tal cual: un 401 significa
    credencial mala, no tabla ausente, y confundirlos seria peor que no mirar.
    """
    endpoint = f"{base.rstrip('/')}/rest/v1/{table}?select=count&limit=0"
    req = urlrequest.Request(
        endpoint,
        headers={
            "Authorization": f"Bearer {key}",
            "apikey": key,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urlopen_retry(req, timeout=15) as resp:
            return resp.status, ""
    except urlerror.HTTPError as exc:
        return exc.code, ""
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"


def mode_check_rest() -> int:
    url, key = creds()
    if not url or not key:
        print("[migrate] FALTAN credenciales: SUPABASE_URL / "
              "SUPABASE_SERVICE_ROLE_KEY (entorno o .env.local)", file=sys.stderr)
        return 2

    migrations = {m["version"]: m for m in discover()}
    results = []
    pending, present, unknown = [], [], []

    print(f"[migrate] check-rest — sondeando {len(EXPECTED_TABLES)} tablas via PostgREST")
    for version, table in sorted(EXPECTED_TABLES.items()):
        status, note = probe_table(url, key, table)
        if status == 200:
            verdict = "presente"
            present.append(table)
        elif status == 404:
            verdict = "PENDIENTE"
            pending.append(table)
        else:
            verdict = "desconocido"
            unknown.append(table)
        mg = migrations.get(version)
        results.append({
            "version": version,
            "table": table,
            "migration_file": mg["name"] if mg else None,
            "migration_sha256": mg["sha256"] if mg else None,
            "http_status": status,
            "verdict": verdict,
            "note": note,
        })
        extra = f" ({note})" if note else ""
        print(f"  {verdict:>12}  {table:<20} http={status}{extra}")

    overall = "ok" if (not pending and not unknown) else (
        "pending" if pending and not unknown else "unknown")

    print()
    print(f"[migrate] veredicto: {overall.upper()} — "
          f"presentes={len(present)} pendientes={len(pending)} "
          f"desconocidas={len(unknown)}")
    if pending:
        print("[migrate] para aplicarlas: workflow `migrate` -> mode=apply, "
              "confirm=APLICAR (o `--apply` con SUPABASE_DB_URL)")
    if unknown:
        print("[migrate] OJO: un codigo distinto de 200/404 NO significa "
              "'tabla ausente'. 401/403 = credencial; 5xx = el proyecto.",
              file=sys.stderr)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": "check-rest",
        "overall": overall,
        "counts": {"present": len(present), "pending": len(pending),
                   "unknown": len(unknown)},
        "tables": results,
    }
    tmp = DRIFT_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(DRIFT_FILE)
    print(f"[migrate] veredicto escrito en data/{DRIFT_FILE.name}")

    # Sale 0 siempre que la pregunta se pudo contestar: "hay pendientes" es
    # una respuesta valida, no un fallo del comando.
    return 0 if overall != "unknown" else 3


# ----------------------- modo --apply -----------------------

def _psql(db_url: str, sql: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["psql", db_url, "-v", "ON_ERROR_STOP=1", "--single-transaction",
         "-q", "-X", "-f", "-"],
        input=sql, text=True, capture_output=True,
    )


def fetch_applied(db_url: str) -> set[str] | None:
    """Versiones ya registradas. None si la tabla no existe todavia."""
    proc = subprocess.run(
        ["psql", db_url, "-t", "-A", "-X", "-v", "ON_ERROR_STOP=1", "-c",
         "select version from public.schema_migrations order by version"],
        text=True, capture_output=True,
    )
    if proc.returncode != 0:
        return None
    return {ln.strip() for ln in proc.stdout.splitlines() if ln.strip()}


def mode_apply() -> int:
    if shutil.which("psql") is None:
        print("[migrate] FATAL: no encuentro `psql` en el PATH.", file=sys.stderr)
        print("[migrate]   macOS:  brew install libpq && "
              'brew link --force libpq', file=sys.stderr)
        print("[migrate]   ubuntu: sudo apt-get install -y postgresql-client",
              file=sys.stderr)
        print("[migrate] Sin psql no se puede aplicar migracion y registro en "
              "la MISMA transaccion, que es todo el punto.", file=sys.stderr)
        return 2

    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("[migrate] FATAL: falta la variable de entorno SUPABASE_DB_URL.",
              file=sys.stderr)
        print("[migrate] Debe ser el SESSION POOLER de Supavisor, puerto 5432:",
              file=sys.stderr)
        print("[migrate]   postgresql://postgres.<ref>:<pass>"
              "@aws-0-<region>.pooler.supabase.com:5432/postgres", file=sys.stderr)
        print("[migrate] La conexion DIRECTA (db.<ref>.supabase.co:5432) es "
              "solo IPv6 y los runners de GitHub son IPv4: fallaria con "
              "'Network is unreachable'.", file=sys.stderr)
        return 2

    migrations = discover()
    if not migrations:
        print(f"[migrate] no hay migraciones en {MIGRATIONS_DIR}", file=sys.stderr)
        return 1

    applied = fetch_applied(db_url)
    if applied is None:
        print("[migrate] libro mayor ausente o inaccesible — se intentara "
              "crear con 001 antes que nada (bootstrap).")
        applied = set()

    pending = [m for m in migrations if m["version"] not in applied]
    if not pending:
        print("[migrate] nada pendiente: el esquema del repo ya esta aplicado.")
        return 0

    # BOOTSTRAP: 001 primero si el libro mayor aun no existe. 000 solo puede
    # insertar sus filas de constancia cuando la tabla ya esta creada.
    def order(mg):
        return (0 if mg["version"] == LEDGER_VERSION else 1, mg["version"])

    if LEDGER_VERSION not in applied:
        pending.sort(key=order)

    print(f"[migrate] aplicando {len(pending)} migracion(es): "
          + ", ".join(m["version"] for m in pending))

    for mg in pending:
        body = mg["path"].read_text(encoding="utf-8")
        # La migracion Y su registro viajan en la MISMA transaccion
        # (--single-transaction): o quedan las dos, o no queda ninguna. Un
        # esquema aplicado sin fila en el libro mayor seria peor que no
        # tener libro mayor, porque mentiria.
        ledger = (
            "\ninsert into public.schema_migrations (version, name, sha256)\n"
            f"values ('{mg['version']}', '{mg['name']}', '{mg['sha256']}')\n"
            "on conflict (version) do update set\n"
            "  name = excluded.name, sha256 = excluded.sha256,\n"
            "  applied_at = now();\n"
        )
        proc = _psql(db_url, body + ledger)
        if proc.returncode != 0:
            print(f"[migrate] FALLO en {mg['name']} (rc={proc.returncode}) — "
                  "la transaccion se revirtio entera, nada quedo a medias",
                  file=sys.stderr)
            if proc.stderr.strip():
                print(proc.stderr.strip()[:4000], file=sys.stderr)
            return proc.returncode
        if proc.stdout.strip():
            print(proc.stdout.strip())
        print(f"[migrate] OK {mg['version']} (sha={mg['sha256'][:12]})")

    print(f"[migrate] listo: {len(pending)} migracion(es) aplicadas y registradas.")
    return 0


# ----------------------- main -----------------------

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="migrate.py",
        description="Runner de migraciones de Postgres (Battle of Bots).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "--apply requiere SUPABASE_DB_URL, y esa URL DEBE ser el session\n"
            "pooler de Supavisor en el puerto 5432:\n"
            "  postgresql://postgres.<ref>:<pass>@aws-0-<region>.pooler.supabase.com:5432/postgres\n"
            "\n"
            "Motivo: los runners de GitHub Actions son IPv4-only y la conexion\n"
            "directa (db.<ref>.supabase.co) solo resuelve a IPv6 — daria\n"
            "'Network is unreachable'. El pooler de TRANSACCION (puerto 6543)\n"
            "tampoco sirve: no soporta transacciones de varias sentencias, que\n"
            "es justo lo que este runner necesita para aplicar y registrar\n"
            "atomicamente.\n"
            "\n"
            "Nada de esto se ejecuta solo: no hay cron y mirror.sh no lo llama.\n"
        ),
    )
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--plan", action="store_true",
                   help="lista migraciones y cuales estan pendientes")
    g.add_argument("--check-rest", action="store_true",
                   help="verifica el esquema desplegado via PostgREST (sin URL de BD)")
    g.add_argument("--apply", action="store_true",
                   help="aplica las pendientes con psql (requiere SUPABASE_DB_URL)")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.plan:
        applied = None
        db_url = os.environ.get("SUPABASE_DB_URL")
        if db_url and shutil.which("psql"):
            applied = fetch_applied(db_url)
        return mode_plan(applied)
    if args.check_rest:
        return mode_check_rest()
    if args.apply:
        return mode_apply()
    return 1


if __name__ == "__main__":
    sys.exit(main())
