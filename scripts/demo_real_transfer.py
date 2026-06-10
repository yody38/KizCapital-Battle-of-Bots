"""
Kiz Capital LLC · Battle of Bots — Test de transferencia demo→real (tribunal P1)

Responde la pregunta nunca testeada del sistema: ¿el track record demo predice
el resultado real del MISMO bot? Para cada magic corriendo en cuenta real con
gemelo demo (mismo magic en cuenta demo), alinea trades por
(símbolo_base, side, open_time ±TOLERANCE) dentro de la ventana de solapamiento
y mide la divergencia per-trade: Δnet, Δprecio de entrada (proxy slippage) y
fills que solo existen en un lado.

Corre en CI tras reconcile y ANTES de post_merge (mirror.sh): post_merge
preserva los campos `transfer` al re-escribir el snapshot. Determinista:
sin reloj ni RNG — misma data, mismo output byte a byte.

Usage: demo_real_transfer.py <data_dir>
  - escribe <data_dir>/demo_real_transfer.json
  - decora bots[].transfer en los bots de cuentas reales del snapshot
"""
from __future__ import annotations

import json
import math
import os
import re
import sys

TOLERANCE_SEC = 120
REAL_LOGINS = {25425, 32081, 3446}


def base_symbol(s: str) -> str:
    """EURUSD.b / EURUSD.pro / EURUSDmicro -> EURUSD (sufijos de broker fuera)."""
    m = re.match(r"[A-Z0-9]{4,8}", (s or "").upper())
    return m.group(0) if m else (s or "")


def load_per_bot(data_dir: str, vps: str, login, magic):
    p = os.path.join(data_dir, "bots", str(vps), f"{login}-{magic}.json")
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None


def match_trades(real_trades: list, demo_trades: list, t0: int, t1: int) -> dict:
    """Greedy 1:1 por cercanía de open_time dentro de (base_symbol, side)."""
    rs = [t for t in real_trades if t0 <= (t.get("open_time") or 0) <= t1]
    ds = [t for t in demo_trades if t0 <= (t.get("open_time") or 0) <= t1]
    pool: dict[tuple, list] = {}
    for i, d in enumerate(ds):
        pool.setdefault((base_symbol(d.get("symbol")), d.get("side")), []).append([i, d, False])
    pairs = []
    real_only = 0
    for r in sorted(rs, key=lambda t: t.get("open_time") or 0):
        cands = pool.get((base_symbol(r.get("symbol")), r.get("side")), [])
        best = None
        for slot in cands:
            if slot[2]:
                continue
            dt = abs((slot[1].get("open_time") or 0) - (r.get("open_time") or 0))
            if dt <= TOLERANCE_SEC and (best is None or dt < best[1]):
                best = (slot, dt)
        if best is None:
            real_only += 1
            continue
        best[0][2] = True
        d = best[0][1]
        # Δprecio en la dirección del trade: positivo = el real entró PEOR.
        dp = (d.get("open_price") or 0) - (r.get("open_price") or 0)
        if r.get("side") == "SELL":
            dp = -dp
        pairs.append({
            "open_dt_sec": best[1],
            "delta_net": round((r.get("net") or 0.0) - (d.get("net") or 0.0), 2),
            "entry_slip": round(dp, 6),
            "real_net": r.get("net"), "demo_net": d.get("net"),
            "real_vol": r.get("volume"), "demo_vol": d.get("volume"),
            "symbol": base_symbol(r.get("symbol")),
        })
    demo_only = sum(1 for slots in pool.values() for s in slots if not s[2])
    return {"pairs": pairs, "real_only": real_only, "demo_only": demo_only,
            "n_real_window": len(rs), "n_demo_window": len(ds)}


def aggregate(magic, real_ref: str, demo_ref: str, m: dict) -> dict:
    pairs = m["pairs"]
    n = len(pairs)
    dn = [p["delta_net"] for p in pairs]
    mean_dn = sum(dn) / n if n else None
    te = math.sqrt(sum((x - mean_dn) ** 2 for x in dn) / (n - 1)) if n > 1 else None
    denom = m["n_real_window"]
    return {
        "magic": magic,
        "real": real_ref,
        "demo_twin": demo_ref,
        "n_pairs": n,
        "match_rate_pct": round(100.0 * n / denom, 1) if denom else None,
        "real_only": m["real_only"],
        "demo_only": m["demo_only"],
        "net_real_window": round(sum(p["real_net"] or 0 for p in pairs), 2),
        "net_demo_window": round(sum(p["demo_net"] or 0 for p in pairs), 2),
        "mean_delta_net": round(mean_dn, 3) if mean_dn is not None else None,
        "tracking_error": round(te, 3) if te is not None else None,
        "entry_slip_avg": round(sum(p["entry_slip"] for p in pairs) / n, 6) if n else None,
        "vol_ratio_real_demo": round(
            sum(p["real_vol"] or 0 for p in pairs) / max(sum(p["demo_vol"] or 0 for p in pairs), 1e-9), 3) if n else None,
    }


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: demo_real_transfer.py <data_dir>", file=sys.stderr)
        sys.exit(2)
    data_dir = sys.argv[1]
    snap_path = os.path.join(data_dir, "snapshot.json")
    with open(snap_path) as f:
        snap = json.load(f)

    bots = snap.get("bots", [])
    demo_by_magic: dict[int, list] = {}
    for b in bots:
        if b.get("account_login") not in REAL_LOGINS and b.get("magic"):
            demo_by_magic.setdefault(b["magic"], []).append(b)

    results = []
    decorated = 0
    for b in bots:
        if b.get("account_login") not in REAL_LOGINS or not b.get("magic"):
            continue
        twins = demo_by_magic.get(b["magic"], [])
        per_real = load_per_bot(data_dir, b.get("vps"), b.get("account_login"), b.get("magic"))
        if not per_real or not twins:
            b["transfer"] = {"twins": len(twins), "status": "no_twin" if not twins else "no_data"}
            continue
        rt = per_real.get("trades") or []
        if not rt:
            b["transfer"] = {"twins": len(twins), "status": "no_real_trades"}
            continue
        t0 = min(t.get("open_time") or 0 for t in rt)
        t1 = max(t.get("close_time") or 0 for t in rt)
        # Mejor gemelo = el de más pares (los demás se reportan igual en el JSON).
        best = None
        for tw in twins:
            per_demo = load_per_bot(data_dir, tw.get("vps"), tw.get("account_login"), tw.get("magic"))
            if not per_demo:
                continue
            m = match_trades(rt, per_demo.get("trades") or [], t0, t1)
            agg = aggregate(b["magic"],
                            f"{b.get('vps')}/{b.get('account_login')}",
                            f"{tw.get('vps')}/{tw.get('account_login')}", m)
            results.append(agg)
            if best is None or (agg["n_pairs"] or 0) > (best["n_pairs"] or 0):
                best = agg
        if best:
            b["transfer"] = {"status": "ok", "twins": len(twins), **{k: best[k] for k in (
                "demo_twin", "n_pairs", "match_rate_pct", "mean_delta_net",
                "tracking_error", "entry_slip_avg", "real_only", "demo_only")}}
            decorated += 1

    out = {
        "schema_version": "transfer-v1-2026-06-10",
        "tolerance_sec": TOLERANCE_SEC,
        "real_logins": sorted(REAL_LOGINS),
        "comparisons": sorted(results, key=lambda r: (str(r["magic"]), r["real"], r["demo_twin"])),
    }
    tmp = os.path.join(data_dir, "demo_real_transfer.json.tmp")
    with open(tmp, "w") as f:
        json.dump(out, f, separators=(",", ":"), sort_keys=True)
    os.replace(tmp, os.path.join(data_dir, "demo_real_transfer.json"))

    with open(snap_path + ".tmp", "w") as f:
        json.dump(snap, f, separators=(",", ":"))
    os.replace(snap_path + ".tmp", snap_path)

    n_pairs = sum(r["n_pairs"] for r in results)
    rates = [r["match_rate_pct"] for r in results if r["match_rate_pct"] is not None]
    print(f"[demo-real-transfer] comparisons={len(results)} bots_decorated={decorated} "
          f"pairs={n_pairs} match_rate_avg={round(sum(rates)/len(rates),1) if rates else None}%")


if __name__ == "__main__":
    main()
