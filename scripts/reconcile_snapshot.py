#!/usr/bin/env python3
"""
reconcile_snapshot.py — Refresh snapshot.bots[] from per-bot files (source of truth).

Each VPS builder writes snapshot.json and per-bot files at slightly different
times. When mirror.sh pulls during an in-flight builder pass, snapshot.bots[i]
fields (trades, net_profit, last_trade) can lag behind the per-bot file by a
few minutes. Per-bot files are the canonical, complete history — this script
makes the merged snapshot consistent with them.

Updates for each bot in snapshot.bots[] when its per-bot file exists:
  - trades                 = len(per_bot.trades)
  - net_profit             = sum(profit + swap) over per_bot.trades
  - wins / losses          = recomputed from per_bot.trades
  - win_rate_pct           = recomputed
  - first_trade / last_trade = from per_bot.trades[0|-1].close_time
  - gross_profit / gross_loss = recomputed

Runs after the merge step, before post_merge.py (so promotion scores see
fresh data). Safe to run any time — idempotent.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SNAPSHOT = DATA_DIR / "snapshot.json"
BOTS_DIR = DATA_DIR / "bots"


def to_iso(ts: int | float | None) -> str | None:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def reconcile_bot(bot: dict) -> tuple[bool, str | None]:
    """Returns (updated, reason). reason is None when nothing to do."""
    vps = bot.get("vps")
    login = bot.get("account_login")
    magic = bot.get("magic")
    if not vps or login is None or not magic:
        return False, None
    pb_path = BOTS_DIR / vps / f"{login}-{magic}.json"
    if not pb_path.exists():
        return False, "per-bot missing"
    try:
        pb = json.loads(pb_path.read_text(encoding="utf-8"))
    except Exception:
        return False, "per-bot unreadable"
    trades = pb.get("trades")
    if not isinstance(trades, list):
        return False, "trades not list"

    n = len(trades)
    wins = sum(1 for t in trades if (t.get("profit", 0) + t.get("swap", 0)) > 0)
    losses = n - wins
    gross_profit = round(sum(max(t.get("profit", 0) + t.get("swap", 0), 0) for t in trades), 2)
    gross_loss = round(sum(min(t.get("profit", 0) + t.get("swap", 0), 0) for t in trades), 2)
    net_profit = round(sum(t.get("profit", 0) + t.get("swap", 0) for t in trades), 2)
    win_rate = round((wins / n * 100) if n else 0.0, 2)
    first_close = trades[0].get("close_time") if n else None
    last_close = trades[-1].get("close_time") if n else None

    before = (bot.get("trades"), bot.get("net_profit"))
    bot["trades"] = n
    bot["net_profit"] = net_profit
    bot["wins"] = wins
    bot["losses"] = losses
    bot["win_rate_pct"] = win_rate
    bot["gross_profit"] = gross_profit
    bot["gross_loss"] = gross_loss
    if first_close:
        bot["first_trade"] = to_iso(first_close) or bot.get("first_trade")
    if last_close:
        bot["last_trade"] = to_iso(last_close) or bot.get("last_trade")
    after = (bot["trades"], bot["net_profit"])
    return (before != after), None


def main() -> int:
    if not SNAPSHOT.exists():
        print(f"FATAL: {SNAPSHOT} missing", file=sys.stderr)
        return 1
    snap = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    bots = snap.get("bots", [])
    updated = 0
    skipped_missing = 0
    skipped_unreadable = 0
    for bot in bots:
        if bot.get("magic", 0) == 0:
            continue
        was_updated, reason = reconcile_bot(bot)
        if was_updated:
            updated += 1
        if reason == "per-bot missing":
            skipped_missing += 1
        elif reason == "per-bot unreadable":
            skipped_unreadable += 1

    bots.sort(key=lambda b: b.get("net_profit", 0), reverse=True)
    snap["bots"] = bots
    snap["reconciled_at"] = datetime.now(timezone.utc).isoformat()

    tmp = SNAPSHOT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(SNAPSHOT)

    print(
        f"[reconcile] bots={len(bots)} updated={updated} "
        f"skipped_missing={skipped_missing} skipped_unreadable={skipped_unreadable}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
