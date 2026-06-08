"""
verify_trade_direction.py — compare the dashboard's per-bot trade DIRECTION
(side) against the INDEPENDENT MT5 ground truth produced by audit_direction.py.

Inputs:
  --audit-dir   dir with audit_<vps>.json files (output of audit_direction.py per VPS)
  --bots-dir    data/bots  (per-bot files <vps>/<login>-<magic>.json)
  --snapshot    data/snapshot.json (optional, for open-position cross-check)
  --out         where to write trade_direction_audit.json

Per bot (vps, login, magic) it checks:
  - SIDE: every per-bot trade (matched to its MT5 entry deal by order==trade.ticket)
    has the same BUY/SELL as MT5.            ← critical, zero tolerance
  - COUNT: #per-bot trades == #MT5 closed positions for that magic.  ← sync check
  - EDGE: surfaces MT5 edge-case positions (reversal/close-by/multi-entry/no-entry).
  - OPEN: real-account open positions in the snapshot match MT5 open side.

Exit 2 if any SIDE mismatch or unmatched trade (strict). Count diffs / edge cases
are reported but (being legitimate in some cases) do not alone fail the run unless
--strict-count is passed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict


def load_audit(audit_dir: str) -> tuple[dict, dict, list]:
    """Returns (closed_by_key, open_by_key, errors).
    closed_by_key[(vps,login,magic)] = list of {order, side, edge, symbol}
    open_by_key[(vps,login,magic)]   = list of {ticket, side, symbol}"""
    closed_by_key: dict = defaultdict(list)
    open_by_key: dict = defaultdict(list)
    errors: list = []
    for fn in sorted(os.listdir(audit_dir)):
        if not (fn.startswith("audit_") and fn.endswith(".json")):
            continue
        vps = fn[len("audit_"):-len(".json")]
        with open(os.path.join(audit_dir, fn)) as f:
            data = json.load(f)
        for acct in data.get("vps_results", []):
            if "error" in acct:
                errors.append({"vps": vps, "error": acct["error"], "path": acct.get("path")})
                continue
            login = int(acct["login"])
            for c in acct.get("closed", []):
                closed_by_key[(vps, login, int(c["magic"]))].append(c)
            for o in acct.get("open", []):
                open_by_key[(vps, login, int(o["magic"]))].append(o)
    return closed_by_key, open_by_key, errors


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audit-dir", required=True)
    ap.add_argument("--bots-dir", required=True)
    ap.add_argument("--snapshot", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--strict-count", action="store_true")
    args = ap.parse_args()

    closed_by_key, open_by_key, audit_errors = load_audit(args.audit_dir)

    bots_report = []
    side_mismatches = []
    unmatched = []
    count_diffs = []
    edge_cases = []
    bots_checked = 0
    bots_missing_audit = []

    for vps in sorted(os.listdir(args.bots_dir)):
        vdir = os.path.join(args.bots_dir, vps)
        if not os.path.isdir(vdir):
            continue
        for fn in sorted(os.listdir(vdir)):
            if not fn.endswith(".json") or fn.startswith("_"):
                continue
            stem = fn[:-len(".json")]
            try:
                login_s, magic_s = stem.split("-", 1)
                login, magic = int(login_s), int(magic_s)
            except ValueError:
                continue
            with open(os.path.join(vdir, fn)) as f:
                pb = json.load(f)
            trades = pb.get("trades", [])
            key = (vps, login, magic)
            bots_checked += 1

            mt5_closed = closed_by_key.get(key)
            if mt5_closed is None:
                bots_missing_audit.append({"vps": vps, "login": login, "magic": magic, "file_trades": len(trades)})
                continue

            # Index MT5 entries by order.
            by_order = {c["order"]: c for c in mt5_closed if c.get("order") is not None}
            bot_side_mm = 0
            bot_unmatched = 0
            for t in trades:
                tk = t.get("ticket")
                fside = t.get("side")
                m = by_order.get(tk)
                if m is None:
                    bot_unmatched += 1
                    unmatched.append({"vps": vps, "login": login, "magic": magic, "ticket": tk, "file_side": fside})
                    continue
                if m["side"] != fside:
                    bot_side_mm += 1
                    side_mismatches.append({
                        "vps": vps, "login": login, "magic": magic, "ticket": tk,
                        "file_side": fside, "mt5_side": m["side"], "symbol": t.get("symbol"),
                    })

            n_edges = [c for c in mt5_closed if c.get("edge")]
            for c in n_edges:
                edge_cases.append({"vps": vps, "login": login, "magic": magic, **{k: c[k] for k in ("order", "side", "edge") if k in c}})

            if len(trades) != len(mt5_closed):
                # A diff of exactly +N where N == currently-open positions for this
                # magic is benign: per-bot files hold only CLOSED trades, while a
                # position-id-less MT5 derivation may count an open position's entry
                # deal as if closed. Classify so only genuine sync gaps remain.
                n_open = len(open_by_key.get(key, []))
                diff = len(mt5_closed) - len(trades)
                count_diffs.append({
                    "vps": vps, "login": login, "magic": magic,
                    "file_trades": len(trades), "mt5_closed": len(mt5_closed),
                    "diff": diff, "open_positions": n_open,
                    "explained": diff == n_open,
                })

            bots_report.append({
                "vps": vps, "login": login, "magic": magic,
                "file_trades": len(trades), "mt5_closed": len(mt5_closed),
                "side_mismatches": bot_side_mm, "unmatched": bot_unmatched,
                "edges": len(n_edges),
                "ok": bot_side_mm == 0 and bot_unmatched == 0,
            })

    unexplained_count_diffs = [c for c in count_diffs if not c.get("explained")]
    critical = len(side_mismatches) + len(unmatched) + len(unexplained_count_diffs)
    ok = critical == 0 and (not args.strict_count or len(count_diffs) == 0)
    report = {
        "ok": ok,
        "bots_checked": bots_checked,
        "bots_ok": sum(1 for b in bots_report if b["ok"]),
        "bots_with_side_mismatch": len({(m["vps"], m["login"], m["magic"]) for m in side_mismatches}),
        "side_mismatches": side_mismatches,
        "unmatched_trades": unmatched[:200],
        "unmatched_count": len(unmatched),
        "count_diffs": count_diffs,
        "unexplained_count_diffs": unexplained_count_diffs,
        "edge_cases": edge_cases,
        "bots_missing_audit": bots_missing_audit,
        "audit_errors": audit_errors,
    }
    with open(args.out, "w") as f:
        json.dump(report, f, indent=2)

    print(f"[direction-audit] bots={bots_checked} ok={report['bots_ok']} "
          f"side_mismatch={len(side_mismatches)} unmatched={len(unmatched)} "
          f"count_diffs={len(count_diffs)} edges={len(edge_cases)} "
          f"missing_audit={len(bots_missing_audit)} audit_errors={len(audit_errors)}")
    if side_mismatches:
        print("  !! SIDE MISMATCHES (critical):")
        for m in side_mismatches[:20]:
            print(f"     {m['vps']}/{m['login']}/{m['magic']} ticket={m['ticket']} file={m['file_side']} mt5={m['mt5_side']}")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
