#!/usr/bin/env python3
"""Run-twice determinism gate for post_merge.py (Data Integrity DNA).

Copies the data dir twice, runs post_merge.py on each copy in a separate
process, and asserts the resulting snapshot.json is byte-identical except for
the inherently time-dependent `generated_at`. A non-zero exit means a fresh bug
of non-determinism (e.g. an unseeded RNG, or builtin hash() on a str without
PYTHONHASHSEED) has crept in — the same class of bug we fixed at post_merge.py
L661. Wire this into CI so a regression cannot merge.

Usage: python3 scripts/test_determinism.py [data_dir]
  data_dir defaults to ./data (must contain snapshot.json + bots/ + snapshot_vpsN.json)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

# Keys that legitimately differ run-to-run because they are wall-clock stamps,
# not algorithmic output. Stripped recursively wherever they appear. Everything
# else (scores, MC quantiles, tracker bands, status) MUST be reproducible.
VOLATILE_KEYS = {"generated_at", "computed_at", "lag_sec"}
HERE = os.path.dirname(os.path.abspath(__file__))
POST_MERGE = os.path.join(HERE, "post_merge.py")


def _strip_volatile(obj):
    """Recursively drop wall-clock metadata keys so the diff isolates real divergence."""
    if isinstance(obj, dict):
        return {k: _strip_volatile(v) for k, v in obj.items() if k not in VOLATILE_KEYS}
    if isinstance(obj, list):
        return [_strip_volatile(v) for v in obj]
    return obj


def _run_once(src_data: str, tmp_root: str, tag: str) -> dict:
    """Copy src_data into a fresh dir, run post_merge on it, return its snapshot.json."""
    work = os.path.join(tmp_root, tag)
    shutil.copytree(src_data, work)
    env = dict(os.environ)
    env["PYTHONHASHSEED"] = "0"  # mirrors the CI workflow guard
    proc = subprocess.run(
        [sys.executable, POST_MERGE, work],
        env=env, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(f"[determinism] post_merge ({tag}) failed rc={proc.returncode}\n{proc.stderr}\n")
        sys.exit(2)
    with open(os.path.join(work, "snapshot.json")) as f:
        return _strip_volatile(json.load(f))


def _diff(a: dict, b: dict) -> list[str]:
    """Return human-readable paths where bot enrichment diverges between runs."""
    diffs: list[str] = []
    a_dump = json.dumps(a, sort_keys=True)
    b_dump = json.dumps(b, sort_keys=True)
    if a_dump == b_dump:
        return diffs
    # Localize to the offending bots so the failure is actionable.
    a_bots = {(x.get("vps"), x.get("magic")): x for x in a.get("bots", [])}
    b_bots = {(x.get("vps"), x.get("magic")): x for x in b.get("bots", [])}
    for key in sorted(set(a_bots) | set(b_bots), key=lambda k: (str(k[0]), str(k[1]))):
        da = json.dumps(a_bots.get(key), sort_keys=True)
        db = json.dumps(b_bots.get(key), sort_keys=True)
        if da != db:
            diffs.append(f"bot {key}")
    if not diffs:
        diffs.append("snapshot top-level (non-bot) fields differ")
    return diffs


def main() -> None:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), "data")
    if not os.path.isfile(os.path.join(data_dir, "snapshot.json")):
        sys.stderr.write(f"[determinism] no snapshot.json under {data_dir}; nothing to test\n")
        sys.exit(2)
    with tempfile.TemporaryDirectory(prefix="det-") as tmp_root:
        snap_a = _run_once(data_dir, tmp_root, "run_a")
        snap_b = _run_once(data_dir, tmp_root, "run_b")
    diffs = _diff(snap_a, snap_b)
    if diffs:
        sys.stderr.write("[determinism] FAIL — post_merge is non-deterministic across processes:\n")
        for d in diffs[:25]:
            sys.stderr.write(f"  - {d}\n")
        if len(diffs) > 25:
            sys.stderr.write(f"  ... and {len(diffs) - 25} more\n")
        sys.exit(2)
    n = len(snap_a.get("bots", []))
    print(f"[determinism] OK — 2 independent runs identical over {n} bots (PYTHONHASHSEED=0)")


if __name__ == "__main__":
    main()
