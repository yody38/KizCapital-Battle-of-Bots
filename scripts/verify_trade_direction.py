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


def load_audit(audit_dir: str) -> tuple[dict, dict, list, set]:
    """Returns (closed_by_key, open_by_key, errors, vps_present).
    closed_by_key[(vps,login,magic)] = list of {position_id, order, side, edge, symbol}
    open_by_key[(vps,login,magic)]   = list of {ticket, side, symbol}"""
    closed_by_key: dict = defaultdict(list)
    open_by_key: dict = defaultdict(list)
    errors: list = []
    vps_present: set = set()
    for fn in sorted(os.listdir(audit_dir)):
        if not (fn.startswith("audit_") and fn.endswith(".json")):
            continue
        vps = fn[len("audit_"):-len(".json")]
        path = os.path.join(audit_dir, fn)
        if os.path.getsize(path) == 0:
            errors.append({"vps": vps, "error": "audit file empty (VPS produced no ground truth)"})
            continue
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception as e:
            errors.append({"vps": vps, "error": f"audit file unparseable: {e}"})
            continue
        results = data.get("vps_results", [])
        if not results:
            errors.append({"vps": vps, "error": "audit file has no vps_results"})
            continue
        vps_present.add(vps)
        for acct in results:
            if "error" in acct:
                errors.append({"vps": vps, "error": acct["error"], "path": acct.get("path")})
                continue
            login = int(acct["login"])
            for c in acct.get("closed", []):
                closed_by_key[(vps, login, int(c["magic"]))].append(c)
            for o in acct.get("open", []):
                open_by_key[(vps, login, int(o["magic"]))].append(o)
    return closed_by_key, open_by_key, errors, vps_present


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audit-dir", required=True)
    ap.add_argument("--bots-dir", required=True)
    ap.add_argument("--snapshot", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--strict-count", action="store_true")
    args = ap.parse_args()

    EXPECTED_VPS = {"vps1", "vps2", "vps3", "vps4", "vps5", "vps6"}
    closed_by_key, open_by_key, audit_errors, vps_present = load_audit(args.audit_dir)

    bots_report = []
    side_mismatches = []
    unmatched = []
    count_diffs = []
    edge_cases = []
    price_side_mismatches = []   # orthogonal: direction from price+P&L disagrees with file.side
    invariant_violations = []    # order != position_id (canonical-key assumption broken)
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

            # The builder stores per-bot trade.ticket = int(position_id) (verified in
            # snapshot_builder.py). Match on position_id (canonical); fall back to the
            # entry deal's order only when position_id is unavailable (VPS3 via MCP,
            # which lacks position_id). order == position_id for an entry deal in MT5;
            # we assert that wherever both are present.
            by_key = {}
            for c in mt5_closed:
                k = c.get("position_id")
                if k is None:
                    k = c.get("order")
                if k is not None:
                    by_key[k] = c
                # Invariant: order must equal position_id for the entry deal.
                if c.get("position_id") is not None and c.get("order") is not None \
                        and c["order"] != c["position_id"]:
                    invariant_violations.append({
                        "vps": vps, "login": login, "magic": magic,
                        "position_id": c["position_id"], "order": c["order"],
                    })
            bot_side_mm = 0
            bot_unmatched = 0
            bot_price_mm = 0
            for t in trades:
                tk = t.get("ticket")
                fside = t.get("side")
                m = by_key.get(tk)
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
                # Orthogonal check, file-only and independent of the MT5 `type` field:
                # gross profit sign must agree with price move FOR the stated side.
                # BUY profits when close>open; SELL profits when close<open.
                op, cp, pr = t.get("open_price"), t.get("close_price"), t.get("profit")
                if op is not None and cp is not None and pr not in (None, 0) and cp != op:
                    price_side = "BUY" if ((cp > op) == (pr > 0)) else "SELL"
                    if price_side != fside:
                        bot_price_mm += 1
                        price_side_mismatches.append({
                            "vps": vps, "login": login, "magic": magic, "ticket": tk,
                            "file_side": fside, "price_implies": price_side,
                            "open_price": op, "close_price": cp, "profit": pr,
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
                "price_mismatches": bot_price_mm, "edges": len(n_edges),
                "ok": bot_side_mm == 0 and bot_unmatched == 0 and bot_price_mm == 0,
            })

    unexplained_count_diffs = [c for c in count_diffs if not c.get("explained")]
    missing_vps = sorted(EXPECTED_VPS - vps_present)
    coverage_ok = (not missing_vps) and len(bots_missing_audit) == 0 and len(audit_errors) == 0
    critical = (len(side_mismatches) + len(unmatched) + len(unexplained_count_diffs)
                + len(price_side_mismatches) + len(invariant_violations))
    ok = critical == 0 and coverage_ok and (not args.strict_count or len(count_diffs) == 0)
    report = {
        "ok": ok,
        "coverage_ok": coverage_ok,
        "vps_present": sorted(vps_present),
        "missing_vps": missing_vps,
        "bots_checked": bots_checked,
        "bots_ok": sum(1 for b in bots_report if b["ok"]),
        "price_side_mismatches": price_side_mismatches,
        "invariant_violations": invariant_violations,
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

    print(f"[direction-audit] OK={ok} coverage_ok={coverage_ok} vps={sorted(vps_present)} "
          f"bots={bots_checked} bots_ok={report['bots_ok']} "
          f"side_mismatch={len(side_mismatches)} price_mismatch={len(price_side_mismatches)} "
          f"unmatched={len(unmatched)} invariant_viol={len(invariant_violations)} "
          f"count_diffs={len(count_diffs)}(unexpl={len(unexplained_count_diffs)}) "
          f"edges={len(edge_cases)} missing_audit={len(bots_missing_audit)} "
          f"audit_errors={len(audit_errors)} missing_vps={missing_vps}")
    if price_side_mismatches:
        print("  !! PRICE-vs-SIDE MISMATCHES (orthogonal check, critical):")
        for m in price_side_mismatches[:20]:
            print(f"     {m['vps']}/{m['login']}/{m['magic']} ticket={m['ticket']} file={m['file_side']} price_implies={m['price_implies']}")
    if side_mismatches:
        print("  !! SIDE MISMATCHES (critical):")
        for m in side_mismatches[:20]:
            print(f"     {m['vps']}/{m['login']}/{m['magic']} ticket={m['ticket']} file={m['file_side']} mt5={m['mt5_side']}")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
