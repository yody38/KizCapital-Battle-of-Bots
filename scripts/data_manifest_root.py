"""
Kiz Capital LLC · Battle of Bots — Data manifest root (Fase D-sustituto, tribunal 2026-06-09)

Builds a canonical sha256 manifest of the verified dataset (snapshot.json +
every per-bot file) and derives ONE root hash from it. The CI commits that
root to the PUBLIC repo each cycle (ledger/roots.log) — git history provides
free, practically immutable timestamping. Any retroactive rewrite of a
per-bot file changes the recomputed root and no longer matches the root
notarized for that cycle.

Honest scope (tribunal): this anchors the data AFTER capture — it proves
nobody altered the history since MT5 delivered it, NOT that the demo broker
delivered ground truth. Full per-trade hash-chain is deferred.

Usage: python3 data_manifest_root.py <data_dir>
  - writes <data_dir>/data_manifest.json  (full manifest, uploaded to Supabase)
  - prints "ROOT <sha256> files=<n> snapshot_ts=<generated_at>"
"""
from __future__ import annotations

import hashlib
import json
import os
import sys


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: data_manifest_root.py <data_dir>", file=sys.stderr)
        sys.exit(2)
    data_dir = sys.argv[1]

    entries: dict[str, str] = {}
    snap_path = os.path.join(data_dir, "snapshot.json")
    entries["snapshot.json"] = sha256_file(snap_path)

    bots_root = os.path.join(data_dir, "bots")
    for vps in sorted(os.listdir(bots_root)):
        vdir = os.path.join(bots_root, vps)
        if not os.path.isdir(vdir) or vps.startswith("."):
            continue
        for name in sorted(os.listdir(vdir)):
            if name.endswith(".json") and not name.startswith("_"):
                entries[f"bots/{vps}/{name}"] = sha256_file(os.path.join(vdir, name))

    with open(snap_path) as f:
        snapshot_ts = json.load(f).get("generated_at", "")

    # Canonical bytes -> root. Key order is sorted and separators fixed, so the
    # root is re-derivable from the manifest file alone (Data Integrity DNA).
    manifest = {
        "schema_version": "manifest-root-v1-2026-06-09",
        "snapshot_generated_at": snapshot_ts,
        "files": dict(sorted(entries.items())),
    }
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    root = hashlib.sha256(canonical).hexdigest()
    manifest["root_sha256"] = root

    out = os.path.join(data_dir, "data_manifest.json")
    tmp = out + ".tmp"
    with open(tmp, "w") as f:
        json.dump(manifest, f, sort_keys=True, separators=(",", ":"))
    os.replace(tmp, out)

    print(f"ROOT {root} files={len(entries)} snapshot_ts={snapshot_ts}")


if __name__ == "__main__":
    main()
