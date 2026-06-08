#!/usr/bin/env python3
"""
fetch_ledger.py — pull the append-only forward-tracker ledger from Supabase
BEFORE post_merge runs, so post_merge appends to the REAL history instead of an
empty file. The CI runner starts without data/candidates_history.jsonl (data/ is
gitignored and not mirrored from the VPS), so without this the ledger was rebuilt
empty every cycle and the upload clobbered the deployed history (down to ~today).

Behavior (fail-closed for safety):
  - GET candidates_history.jsonl from Supabase Storage.
  - 200  -> UNION with any existing local file (never shrink), write result.
  - 404  -> ledger does not exist yet (first run) — leave local as-is, exit 0.
  - other/network error -> exit 1 so mirror.sh ABORTS rather than appending to an
    empty ledger and overwriting the deployed history.

Union key = (date[:10], vps, login, magic) — one row per bot per day.
"""
from __future__ import annotations

import json
import ssl
import sys
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ENV_FILE = ROOT / ".env.local"
LEDGER = DATA_DIR / "candidates_history.jsonl"
BUCKET = "dashboard-data"
OBJ = "candidates_history.jsonl"

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


def main() -> int:
    env = load_env()
    url, skey = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not skey:
        print("[fetch_ledger] no Supabase creds — skipping (local ledger left as-is)", file=sys.stderr)
        return 0

    endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{OBJ}"
    req = urlrequest.Request(endpoint, headers={"Authorization": f"Bearer {skey}", "apikey": skey})
    try:
        with urlrequest.urlopen(req, timeout=30, context=_CTX) as resp:
            remote = parse_lines(resp.read().decode("utf-8", errors="replace"))
    except urlerror.HTTPError as exc:
        if exc.code == 404:
            print("[fetch_ledger] ledger not on Supabase yet (404) — first run, leaving local as-is")
            return 0
        print(f"[fetch_ledger] HTTP {exc.code} fetching ledger — ABORT (won't risk clobber)", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"[fetch_ledger] error fetching ledger: {exc} — ABORT (won't risk clobber)", file=sys.stderr)
        return 1

    local = parse_lines(LEDGER.read_text(encoding="utf-8")) if LEDGER.exists() else []

    # Union — never shrink. Keep local row on key collision (local is freshest write).
    seen: dict = {}
    merged: list[dict] = []
    for r in local + remote:
        k = key(r)
        if k not in seen:
            seen[k] = 1
            merged.append(r)
    merged.sort(key=lambda r: (r.get("date", "")[:10], str(r.get("vps")), str(r.get("login")), str(r.get("magic"))))

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    body = "\n".join(json.dumps(r, ensure_ascii=False) for r in merged)
    LEDGER.write_text(body + ("\n" if body else ""), encoding="utf-8")
    print(f"[fetch_ledger] remote={len(remote)} local={len(local)} -> ledger={len(merged)} lines")
    return 0


if __name__ == "__main__":
    sys.exit(main())
