"""
carry_forward_stale.py — graceful-degradation helper for mirror.sh.

When a single non-real VPS fails to mirror this cycle (e.g. RAM-starved → scp
"Connection closed", or its snapshot is stale), we must NOT freeze the whole
dashboard. Instead we carry that VPS forward from the LAST-GOOD data already on
Supabase, flagged stale, so the 5 healthy VPS publish fresh and no bot vanishes.

This downloads, for one stale VPS id:
  1. The last-good merged snapshot.json from Supabase Storage, slices out that
     VPS's accounts/bots/open_positions, and writes a per-VPS-shaped file at
     data/snapshot_<vps>.json (so mirror.sh's merge ingests it like a normal one).
  2. That VPS's per-bot files (data/bots/<vps>/<login>-<magic>.json) so the
     downstream verify_integrity --strict still passes.

Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from env (CI) or .env.local (local).
Exit 0 on success (carry file written), non-zero on any failure → mirror.sh then
fails closed (we never publish a VPS we couldn't even carry forward).

Usage:  python3 carry_forward_stale.py <vps_id> <data_dir>
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib import request as urlrequest, error as urlerror

BUCKET = "dashboard-data"


def load_env(data_dir: Path) -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not (url and key):
        envf = data_dir.parent / ".env.local"
        if envf.exists():
            for raw in envf.read_text().splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip().strip('"').strip("'")
                if k.strip() == "SUPABASE_URL" and not url:
                    url = v
                if k.strip() in ("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY") and not key:
                    key = v
    if not (url and key):
        raise SystemExit("carry_forward: SUPABASE_URL / SERVICE key missing")
    return url.rstrip("/"), key


def storage_get(url: str, key: str, obj_path: str) -> bytes:
    endpoint = f"{url}/storage/v1/object/{BUCKET}/{obj_path}"
    req = urlrequest.Request(endpoint, headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urlrequest.urlopen(req, timeout=30) as r:
        return r.read()


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: carry_forward_stale.py <vps_id> <data_dir>")
    vps_id, data_dir = sys.argv[1], Path(sys.argv[2])
    url, key = load_env(data_dir)

    try:
        snap = json.loads(storage_get(url, key, "snapshot.json"))
    except (urlerror.URLError, json.JSONDecodeError) as e:
        print(f"carry_forward[{vps_id}]: cannot fetch last-good snapshot.json: {e}", file=sys.stderr)
        return 1

    accounts = [a for a in snap.get("accounts", []) if a.get("vps") == vps_id]
    bots = [b for b in snap.get("bots", []) if b.get("vps") == vps_id]
    positions = [p for p in snap.get("open_positions", []) if p.get("vps") == vps_id]
    if not accounts and not bots:
        print(f"carry_forward[{vps_id}]: last-good snapshot has no data for this VPS — cannot carry", file=sys.stderr)
        return 1

    src_gen = (snap.get("vps_sources", {}).get(vps_id, {}) or {}).get("generated_at") \
        or snap.get("oldest_source_generated_at")

    # Reconstruct a per-VPS file shaped like snapshot_builder.py output. The merge
    # re-stamps the 'vps' key, so stripping it here is optional; we keep payloads intact.
    per_vps = {
        "generated_at": src_gen,
        "window_days": snap.get("window_days"),
        "carried_forward": True,
        "portfolio": {
            "total_balance": round(sum(a.get("balance", 0) or 0 for a in accounts), 2),
            "total_equity": round(sum(a.get("equity", 0) or 0 for a in accounts), 2),
            "total_open_margin": round(sum(a.get("margin", 0) or 0 for a in accounts), 2),
            "total_unrealised_pnl": round(sum(a.get("profit", 0) or 0 for a in accounts), 2),
            "account_count": len(accounts),
            "currency": (snap.get("portfolio", {}) or {}).get("currency"),
        },
        "accounts": accounts,
        "bots": bots,
        "open_positions": positions,
        "errors": [],
    }
    out_file = data_dir / f"snapshot_{vps_id}.json"
    out_file.write_text(json.dumps(per_vps), encoding="utf-8")

    # Download this VPS's per-bot files so verify_integrity --strict passes.
    bots_dir = data_dir / "bots" / vps_id
    bots_dir.mkdir(parents=True, exist_ok=True)
    fetched, failed = 0, 0
    for b in bots:
        login, magic = b.get("account_login"), b.get("magic")
        if login is None or magic is None:
            continue
        rel = f"bots/{vps_id}/{login}-{magic}.json"
        dest = data_dir / "bots" / vps_id / f"{login}-{magic}.json"
        if dest.exists():
            fetched += 1
            continue
        try:
            dest.write_bytes(storage_get(url, key, rel))
            fetched += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"carry_forward[{vps_id}]: per-bot fetch failed {rel}: {e}", file=sys.stderr)
    if failed:
        print(f"carry_forward[{vps_id}]: {failed} per-bot files missing — cannot safely carry", file=sys.stderr)
        return 1

    print(f"carry_forward[{vps_id}]: OK accounts={len(accounts)} bots={len(bots)} "
          f"per_bot_files={fetched} src_gen={src_gen} -> {out_file.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
