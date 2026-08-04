#!/usr/bin/env python3
"""fetch_science_pack.py — baja el science_pack.json del lab al data/ del ciclo.

Science Bridge (fase 1): el Mac del lab publica science_pack.json al bucket
(publish_science_pack.py, LaunchAgent cada 30 min); este script lo hidrata al
DATA_DIR ANTES de post_merge.py, que hace el join por magic (scientific_score,
evidence_tier, expectation_gap). Al quedar en data/, el upload normal del ciclo
lo re-publica con dual-write, propagándolo a R2 (el Mac no tiene credenciales R2).

Semántica FAIL-OPEN — el dashboard nunca depende del lab:
  - 404 / error de red  -> exit 0, se conserva el pack local previo si existe
                           (post_merge marcará su edad); sin pack, campos science
                           en null y el ciclo sigue.
  - JSON corrupto o schema inesperado -> se DESCARTA (no se escribe), exit 0.
Nunca aborta el ciclo: la ausencia del lab degrada confianza, no disponibilidad.

Lectura R2-first vía r2_read (kill-switch CI_READ_SOURCE) — egress 2026-08-04.
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
BUCKET = "dashboard-data"
OBJ = "science_pack.json"
LOCAL = DATA_DIR / "science_pack.json"

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


def valid_pack(body: bytes) -> bool:
    """Schema mínimo: dict con schema==1, gms dict no vacío, generated_at str."""
    try:
        pack = json.loads(body)
    except json.JSONDecodeError as exc:
        print(f"[fetch_science_pack] JSON corrupto — descartado: {exc}", file=sys.stderr)
        return False
    if not isinstance(pack, dict) or pack.get("schema") != 1:
        print("[fetch_science_pack] schema inesperado — descartado", file=sys.stderr)
        return False
    gms = pack.get("gms")
    if not isinstance(gms, dict) or not gms or not isinstance(pack.get("generated_at"), str):
        print("[fetch_science_pack] gms/generated_at inválidos — descartado", file=sys.stderr)
        return False
    return True


def main() -> int:
    body: bytes | None = None
    if r2_read.read_source() == "r2":
        try:
            body = r2_read.r2_get_bytes(OBJ)
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch_science_pack] r2: {exc} — fallback a Supabase", file=sys.stderr)
    if body is None:
        env = load_env()
        url, skey = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not skey:
            print("[fetch_science_pack] sin credenciales — sin pack este ciclo (fail-open)")
            return 0
        endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{OBJ}"
        req = urlrequest.Request(endpoint, headers={"Authorization": f"Bearer {skey}", "apikey": skey})
        try:
            with urlrequest.urlopen(req, timeout=30, context=_CTX) as resp:
                body = resp.read()
        except urlerror.HTTPError as exc:
            note = "aún no publicado (404)" if exc.code == 404 else f"HTTP {exc.code}"
            print(f"[fetch_science_pack] {note} — sin pack este ciclo (fail-open)")
            return 0
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch_science_pack] error de red: {exc} — sin pack este ciclo (fail-open)")
            return 0

    if not valid_pack(body):
        return 0  # corrupción: se descarta; queda el local previo si existía

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LOCAL.with_suffix(".tmp")
    tmp.write_bytes(body)
    tmp.replace(LOCAL)
    n = len(json.loads(body)["gms"])
    print(f"[fetch_science_pack] hidratado: {n} GMs, {len(body)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
