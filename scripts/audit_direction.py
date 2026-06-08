"""
audit_direction.py — INDEPENDENT trade-direction ground truth (runs ON a VPS).

Does NOT reuse snapshot_builder.py logic — it re-derives each closed position's
direction straight from raw MT5 deals, so a bug shared with the builder cannot
hide. Iterates every installed MT5 terminal, and per account emits, per magic:
  - closed positions: {order, ticket, side, open_time, symbol, edge}
  - open positions:   {ticket, side, symbol}

Direction rule (MT5): a position's direction = its ENTRY deal (DEAL_ENTRY_IN=0).
type 0 (DEAL_TYPE_BUY) → BUY, type 1 (DEAL_TYPE_SELL) → SELL. Only trade deals
(type in {0,1}) participate; balance/credit/commission deals (type>=2) ignored.
Edge cases are FLAGGED (never silently guessed): reversals (DEAL_ENTRY_INOUT=2),
close-by (DEAL_ENTRY_OUT_BY=3), multiple/zero entry deals, position opened before
the scan window (no entry deal in range).

Output: single JSON line to stdout: {"login":..., "closed":[...], "open":[...]}
per terminal, wrapped in {"vps_results":[...]}. Small payload (no raw deals).

Run (per VPS):  C:\\mt5-mcp\\venv\\Scripts\\python.exe C:\\mt5-mcp\\audit_direction.py
"""
from __future__ import annotations

import glob
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone

import MetaTrader5 as mt5

TERMINAL_GLOB = r"C:\Program Files\MetaTrader 5 *\terminal64.exe"
# Scan from well before any bot existed so no entry deal is missed.
SCAN_START = datetime(2017, 1, 1, tzinfo=timezone.utc)


def side_of(deal_type: int) -> str | None:
    if deal_type == 0:
        return "BUY"
    if deal_type == 1:
        return "SELL"
    return None  # not a trade deal


def derive_account(path: str) -> dict | None:
    if not mt5.initialize(path=path):
        return None
    try:
        info = mt5.account_info()
        if info is None:
            return None
        login = int(info.login)

        now = datetime.now(timezone.utc)
        deals = mt5.history_deals_get(SCAN_START, now) or []

        # Group deals by position_id.
        by_pos: dict[int, list] = defaultdict(list)
        for d in deals:
            by_pos[d.position_id].append(d)

        closed: list[dict] = []
        for pos_id, ds in by_pos.items():
            if pos_id == 0:
                continue  # balance/credit operations carry position_id 0
            ds_sorted = sorted(ds, key=lambda x: (x.time, x.ticket))
            trade_deals = [x for x in ds_sorted if x.type in (0, 1)]
            in_deals = [x for x in trade_deals if x.entry == 0]
            out_deals = [x for x in trade_deals if x.entry in (1, 3)]
            inout = [x for x in trade_deals if x.entry == 2]
            if not out_deals:
                continue  # still open (handled by positions_get) or no close

            magic = ds_sorted[0].magic
            symbol = ds_sorted[0].symbol
            open_deal = in_deals[0] if in_deals else None
            edge = None
            if len(in_deals) != 1 or inout:
                edge = f"in={len(in_deals)},inout={len(inout)},out={len(out_deals)}"

            closed.append({
                "magic": magic,
                "symbol": symbol,
                "order": (open_deal.order if open_deal else None),
                "ticket": (open_deal.ticket if open_deal else None),
                "side": (side_of(open_deal.type) if open_deal else None),
                "open_time": int(open_deal.time) if open_deal else int(ds_sorted[0].time),
                "edge": edge,
            })

        opens: list[dict] = []
        for p in (mt5.positions_get() or []):
            opens.append({
                "magic": p.magic,
                "ticket": p.ticket,
                "symbol": p.symbol,
                "side": "BUY" if p.type == 0 else ("SELL" if p.type == 1 else str(p.type)),
            })

        return {"login": login, "closed": closed, "open": opens}
    finally:
        try:
            mt5.shutdown()
        except Exception:
            pass


def main() -> None:
    results = []
    for path in sorted(glob.glob(TERMINAL_GLOB)):
        try:
            r = derive_account(path)
            if r:
                results.append(r)
        except Exception as exc:  # noqa: BLE001
            results.append({"error": str(exc), "path": path})
    sys.stdout.write(json.dumps({"vps_results": results}))


if __name__ == "__main__":
    main()
