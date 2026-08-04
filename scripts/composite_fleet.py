#!/usr/bin/env python3
"""
composite_fleet.py — búsqueda semanal de cestas 4-6 sobre la flota demo,
con la honestidad metodológica del lab (composite_gold_mine.py).

Port de la metodología, no del código: beam search sobre las series diarias
demo + MODELO NULO. La barra NO es "la cesta gana al mejor miembro" (el 88% de
combos aleatorios lo logran mecánicamente: los profits suman y los drawdowns
no). La barra es estar en el top 5% de 200 combos ALEATORIOS del mismo tamaño.
Si no lo está, el veredicto es BASKET_NO_CONCLUYENTE y así se publica.

Elegibles: bots demo en etapa CANDIDATE u OBSERVATION (lifecycle fase 2),
≥30 trades, ≥60 días de serie, magic fuera de reales. Ventana: últimos 180
días; OOS = último 30%. Restricción pairwise |ρ| ≤ 0.5 (solape ≥30 días).

Corre SEMANAL en su propio workflow (no en el loop de 15 min). Determinista:
RNG con semilla fija; el timestamp del output es el generated_at del snapshot.

Salida: data/basket_recommendations.json → subida directa al bucket (+R2).
Consultivo: recomendar una cesta jamás despliega nada. Fail-open total: si no
hay datos suficientes se publica un reporte vacío con el porqué.
"""
from __future__ import annotations

import itertools
import json
import math
import os
import random
import ssl
import sys
from pathlib import Path
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import r2_read  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ENV_FILE = ROOT / ".env.local"
BUCKET = "dashboard-data"
OUT_OBJ = "basket_recommendations.json"

WINDOW_DAYS = 180
OOS_FRACTION = 0.30
MIN_TRADES = 30
MIN_SERIES_DAYS = 60
MAX_PAIR_RHO = 0.50
MIN_OVERLAP = 30
SIZES = (4, 5, 6)
BEAM_WIDTH = 3
NULL_COMBOS = 200
NULL_PERCENTILE = 95
MC_RUNS = 200
MC_BLOCK = 20
SEED = 20260804
MAX_ELIGIBLE = 60  # techo de descargas per-bot (top por promotion_score_shrunk)

try:
    import certifi  # type: ignore

    _CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _CTX = ssl.create_default_context()


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def fetch_obj(env, obj: str) -> bytes | None:
    """R2-first con fallback Supabase; None si no existe / error (fail-open)."""
    if r2_read.read_source() == "r2":
        try:
            return r2_read.r2_get_bytes(obj)
        except Exception:  # noqa: BLE001
            pass
    url, skey = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not skey:
        return None
    encoded = "/".join(urlparse.quote(p, safe="") for p in obj.split("/"))
    endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{encoded}"
    req = urlrequest.Request(endpoint, headers={"Authorization": f"Bearer {skey}", "apikey": skey})
    try:
        with urlrequest.urlopen(req, timeout=30, context=_CTX) as resp:
            return resp.read()
    except Exception:  # noqa: BLE001
        return None


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx < 1e-12 or sy < 1e-12:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)


def mar_segment(daily_by_key, keys, segment_dates):
    """MAR de la cesta sobre un segmento de fechas = net / max_dd (dd piso $1)."""
    cum = peak = 0.0
    max_dd = 0.0
    net = 0.0
    for d in segment_dates:
        x = sum(daily_by_key[k].get(d, 0.0) for k in keys)
        net += x
        cum += x
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)
    return net / max(max_dd, 1.0), net, max_dd


def main() -> int:
    env = load_env()
    body = fetch_obj(env, "snapshot.json")
    report = {
        "schema": 1, "generated_at": None, "status": "SIN_DATOS",
        "note": ("la barra honesta del lab: una cesta solo tiene señal si supera al "
                 f"P{NULL_PERCENTILE} de {NULL_COMBOS} combos aleatorios del mismo tamaño"),
        "baskets": [], "eligible": 0,
    }

    def publish(rep) -> int:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        out_body = json.dumps(rep, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        (DATA_DIR / OUT_OBJ).write_bytes(out_body)
        url, skey = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
        if url and skey:
            endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{OUT_OBJ}"
            req = urlrequest.Request(endpoint, data=out_body, method="POST", headers={
                "Authorization": f"Bearer {skey}", "apikey": skey,
                "Content-Type": "application/json", "x-upsert": "true",
                "cache-control": "public, max-age=300",
            })
            try:
                with urlrequest.urlopen(req, timeout=60, context=_CTX) as resp:
                    if resp.status >= 300:
                        raise RuntimeError(f"http {resp.status}")
            except Exception as exc:  # noqa: BLE001
                print(f"[composite-fleet] upload supabase: {exc}", file=sys.stderr)
        try:
            client, bucket = r2_read._r2()
            if client:
                client.put_object(Bucket=bucket, Key=OUT_OBJ, Body=out_body,
                                  ContentType="application/json")
        except Exception as exc:  # noqa: BLE001
            print(f"[composite-fleet] upload r2: {exc}", file=sys.stderr)
        print(f"[composite-fleet] publicado: status={rep['status']} baskets={len(rep['baskets'])} "
              f"eligible={rep['eligible']}")
        return 0

    if body is None:
        report["note_error"] = "snapshot.json inaccesible"
        return publish(report)
    snap = json.loads(body)
    report["generated_at"] = snap.get("generated_at")
    real_magics = set(snap.get("real_magics") or [])

    elig_bots = [b for b in snap.get("bots", [])
                 if (b.get("lifecycle") or {}).get("stage") in ("CANDIDATE", "OBSERVATION")
                 and b.get("magic") not in real_magics
                 and (b.get("trades") or 0) >= MIN_TRADES]
    elig_bots.sort(key=lambda b: (-(b.get("promotion_score_shrunk") or b.get("promotion_score") or 0),
                                  str(b.get("magic"))))
    elig_bots = elig_bots[:MAX_ELIGIBLE]

    daily_by_key = {}
    meta_by_key = {}
    for b in elig_bots:
        key = f"{b.get('vps')}-{b.get('account_login')}-{b.get('magic')}"
        pb = fetch_obj(env, f"bots/{b.get('vps')}/{b.get('account_login')}-{b.get('magic')}.json")
        if pb is None:
            continue
        try:
            sr = json.loads(pb).get("daily_equity_series") or []
        except Exception:  # noqa: BLE001
            continue
        daily = {r["date"]: (r.get("daily_net") or 0.0) for r in sr if r.get("date")}
        # La serie es SPARSE (solo días con trades): la elegibilidad se mide por
        # span de calendario, no por filas — un bot de 2 trades/semana con 1 año
        # de historia es perfectamente elegible (bug real: exigir 60 filas
        # dejaba 4/21 elegibles el 2026-08-04).
        span_ok = False
        if len(daily) >= 20:
            d0, d1 = min(daily), max(daily)
            try:
                from datetime import date
                span = (date.fromisoformat(d1) - date.fromisoformat(d0)).days
                span_ok = span >= MIN_SERIES_DAYS
            except ValueError:
                span_ok = False
        if span_ok:
            daily_by_key[key] = daily
            meta_by_key[key] = {"vps": b.get("vps"), "login": b.get("account_login"),
                                "magic": b.get("magic"), "symbols": b.get("symbols") or [],
                                "score_shrunk": b.get("promotion_score_shrunk"),
                                "stage": (b.get("lifecycle") or {}).get("stage")}
    report["eligible"] = len(daily_by_key)
    if len(daily_by_key) < min(SIZES):
        report["status"] = "SIN_DATOS"
        report["note_error"] = f"solo {len(daily_by_key)} bots con serie suficiente"
        return publish(report)

    all_dates = sorted(set(itertools.chain.from_iterable(daily_by_key.values())))
    dates = all_dates[-WINDOW_DAYS:]
    oos_idx = int(len(dates) * (1 - OOS_FRACTION))
    keys = sorted(daily_by_key)

    # Pairwise ρ para la restricción.
    rho = {}
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            sa, sb = daily_by_key[a], daily_by_key[b]
            common = [d for d in dates if d in sa and d in sb]
            if len(common) >= MIN_OVERLAP:
                r = pearson([sa[d] for d in common], [sb[d] for d in common])
                if r is not None:
                    rho[(a, b)] = r

    def compatible(combo, k):
        for other in combo:
            pair = (min(other, k), max(other, k))
            r = rho.get(pair)
            if r is not None and abs(r) > MAX_PAIR_RHO:
                return False
        return True

    # Beam search por tamaño.
    results = []
    for size in SIZES:
        beam = [((), 0.0)]
        for _ in range(size):
            nxt = []
            for combo, _score in beam:
                for k in keys:
                    if k in combo or not compatible(combo, k):
                        continue
                    cand = tuple(sorted(combo + (k,)))
                    # La búsqueda optimiza SOLO in-sample: el OOS queda virgen
                    # para el veredicto (mismo protocolo que el lab).
                    m, _net, _dd = mar_segment(daily_by_key, cand, dates[:oos_idx])
                    nxt.append((cand, m))
            seen = set()
            uniq = []
            for c, m in sorted(nxt, key=lambda t: (-t[1], t[0])):
                if c not in seen:
                    seen.add(c)
                    uniq.append((c, m))
            beam = uniq[:BEAM_WIDTH]
            if not beam:
                break
        if not beam or len(beam[0][0]) < size:
            continue
        best = beam[0][0]
        best_mar = mar_segment(daily_by_key, best, dates[oos_idx:])[0]

        # Modelo nulo: combos aleatorios del mismo tamaño, SIN restricción de ρ
        # (el nulo debe ser fácil de ganar solo si hay señal real).
        rng = random.Random(SEED + size)
        null_mars = []
        for _ in range(NULL_COMBOS):
            combo = tuple(sorted(rng.sample(keys, size)))
            null_mars.append(mar_segment(daily_by_key, combo, dates[oos_idx:])[0])
        null_sorted = sorted(null_mars)
        pct = sum(1 for x in null_sorted if x < best_mar) / len(null_sorted) * 100

        # Block bootstrap MC sobre el OOS combinado.
        oos_daily = [sum(daily_by_key[k].get(d, 0.0) for k in best) for d in dates[oos_idx:]]
        mc_pass = None
        if len(oos_daily) >= MC_BLOCK * 2:
            rng2 = random.Random(SEED * 7 + size)
            nets = []
            n_blocks = max(1, len(oos_daily) // MC_BLOCK)
            for _ in range(MC_RUNS):
                sim = []
                for _b in range(n_blocks):
                    start = rng2.randrange(0, len(oos_daily) - MC_BLOCK + 1)
                    sim.extend(oos_daily[start:start + MC_BLOCK])
                nets.append(sum(sim))
            nets.sort()
            mc_pass = nets[int(0.05 * len(nets))] > 0

        _, net, dd = mar_segment(daily_by_key, best, dates[oos_idx:])
        status = "BASKET_SENAL" if (pct >= NULL_PERCENTILE and mc_pass) else "BASKET_NO_CONCLUYENTE"
        results.append({
            "size": size,
            "members": [meta_by_key[k] for k in best],
            "oos_mar": round(best_mar, 3),
            "oos_net_usd": round(net, 2),
            "oos_max_dd_usd": round(dd, 2),
            "null_percentile": round(pct, 1),
            "null_median_mar": round(null_sorted[len(null_sorted) // 2], 3),
            "mc_p5_positive": mc_pass,
            "status": status,
        })

    report["baskets"] = results
    report["status"] = ("BASKET_SENAL" if any(r["status"] == "BASKET_SENAL" for r in results)
                        else ("BASKET_NO_CONCLUYENTE" if results else "SIN_DATOS"))
    report["window_days"] = len(dates)
    report["oos_days"] = len(dates) - oos_idx
    return publish(report)


if __name__ == "__main__":
    sys.exit(main())
