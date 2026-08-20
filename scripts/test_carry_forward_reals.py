#!/usr/bin/env python3
"""
test_carry_forward_reals.py — regresion de la CESTA FIJA de cuentas reales.

Protege la ruta que decide cuanto dinero real publica el dashboard. El fallo que
lo motivo (2026-08-20): VPS3 reinicio a las 05:31 UTC, volvieron 1 de 5
terminales MT5, y el ciclo publico $4,738.19 en vez de $31,758.30 —$27,020 de
dinero real presentados como perdida— con partial_data=False y el badge verde
"Datos verificados". Nadie movio un dolar: solo desaparecieron 4 cuentas de la
suma.

Sin red: storage_get y load_env se sustituyen por dobles en memoria.
Correr:  python3 scripts/test_carry_forward_reals.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import carry_forward_reals as cfr  # noqa: E402
import verify_integrity as vi  # noqa: E402
from vps_registry import CUTOVER_DATE  # noqa: E402

ROSTER = {"generated_at": "2026-08-20T06:17:56Z", "reals": {
    str(lg): {"vps": "vps3", "active": True, "last_balance": bal}
    for lg, bal in [(32081, 4738.19), (25425, 7317.36), (43306, 4977.98),
                    (43414, 4903.57), (43411, 9821.20)]}}
ALL = [32081, 25425, 43306, 43414, 43411]
FULL = round(sum(r["last_balance"] for r in ROSTER["reals"].values()), 2)  # 31758.30
ALONE = ROSTER["reals"]["32081"]["last_balance"]


def acct(login, balance=None, **extra):
    bal = ROSTER["reals"][str(login)]["last_balance"] if balance is None else balance
    return {"login": login, "vps": "vps3", "is_real": True, "balance": bal,
            "equity": bal, "profit": 0, "margin": 0,
            "server": "ADNBrokerCFD-Server", "leverage": 100, **extra}


def bot(login, magic):
    return {"account_login": login, "magic": magic, "vps": "vps3",
            "net_profit": 100.0 * magic}


def snapshot(logins, bots=(), positions=(), epoch=CUTOVER_DATE):
    accts = [acct(lg) for lg in logins]
    accts.append({"login": 999, "vps": "vps1", "is_real": False, "balance": 10.0,
                  "equity": 10.0, "profit": 0, "margin": 0})
    return {"generated_at": "2026-08-20T06:00:00+00:00", "numbering_epoch": epoch,
            "accounts": accts, "bots": list(bots), "open_positions": list(positions),
            "portfolio": {"total_balance": round(sum(a["balance"] for a in accts), 2),
                          "total_equity": round(sum(a["equity"] for a in accts), 2),
                          "total_unrealised_pnl": 0.0, "total_open_margin": 0.0,
                          "account_count": len(accts)},
            "real_portfolio": {}}


def run(current, last_good, *, missing_objects=frozenset(), roster=ROSTER):
    """Ejecuta el script sobre un data_dir temporal. Devuelve (rc, snapshot, per_bot_files, intacto)."""
    data_dir = Path(tempfile.mkdtemp()) / "data"
    data_dir.mkdir(parents=True)
    snap_file = data_dir / "snapshot.json"
    snap_file.write_text(json.dumps(current))
    before = snap_file.read_text()
    objects = {"real_roster.json": json.dumps(roster).encode(),
               "snapshot.json": json.dumps(last_good).encode()}

    def fake_get(_url, _key, path):
        if path in missing_objects:
            raise OSError("404 simulado")
        return objects.get(path) or json.dumps({"per_bot": path}).encode()

    real_get, real_env = cfr.storage_get, cfr.load_env
    cfr.storage_get, cfr.load_env = fake_get, (lambda _d: ("http://stub", "key"))
    try:
        sys.argv = ["carry_forward_reals.py", str(data_dir)]
        rc = cfr.main()
    finally:
        cfr.storage_get, cfr.load_env = real_get, real_env
    out = json.loads(snap_file.read_text())
    untouched = before == snap_file.read_text()
    bots_dir = data_dir / "bots" / "vps3"
    files = sorted(p.name for p in bots_dir.glob("*.json")) if bots_dir.exists() else []
    shutil.rmtree(data_dir.parent)
    return rc, out, files, untouched


CHECKS = 0


def ok(cond, msg):
    global CHECKS
    assert cond, f"FALLO: {msg}"
    CHECKS += 1
    print(f"  OK {msg}")


def test_cesta_sana_no_toca_nada():
    print("1 - cesta sana: no se hereda nada")
    rc, s, _, _ = run(snapshot(ALL), snapshot(ALL))
    rp = s["real_portfolio"]
    ok(rc == 0, "rc=0")
    ok(rp["account_count"] == 5 and rp["live_count"] == 5, "5/5 en vivo")
    ok(rp["total_balance"] == FULL, f"balance intacto ${rp['total_balance']}")
    ok(s["degraded_reals"] == [], "sin degradadas")
    ok(s["portfolio"]["account_count"] == 6, "totales globales sin tocar")


def test_cuatro_terminales_cerrados():
    print("2 - el fallo real: 4 terminales cerrados, VPS fresca")
    rc, s, _, _ = run(snapshot([32081]), snapshot(ALL))
    rp = s["real_portfolio"]
    ok(rc == 0 and rp["account_count"] == 5, "la cesta vuelve a 5")
    ok(rp["live_count"] == 1, "solo 1 trae dato de este ciclo")
    ok(rp["total_balance"] == FULL,
       f"${rp['total_balance']} y no ${ALONE} — la caida no se publica como perdida")
    ok(sorted(d["login"] for d in s["degraded_reals"]) == [25425, 43306, 43411, 43414],
       "las 4 quedan nombradas en degraded_reals")
    ok(all(a.get("as_of") for a in rp["accounts"] if a.get("disconnected")),
       "cada heredada dice de cuando es su dato")
    ok(s["portfolio"]["account_count"] == 6, "los totales globales tampoco caen")


def test_caida_prolongada_cae_al_roster():
    print("3 - caida de varios ciclos: el ultimo bueno ya esta degradado")
    rc, s, _, _ = run(snapshot([32081]), snapshot([32081]))
    rp = s["real_portfolio"]
    ok(rc == 0 and rp["total_balance"] == FULL, "se recupera del roster")
    ok(all(d["carry_source"] == "roster" for d in s["degraded_reals"]),
       "marcadas como recuperadas del roster, no del snapshot")


def test_guarda_de_epoca():
    print("4 - guarda de epoca de numeracion")
    rc, s, _, untouched = run(snapshot([32081]), snapshot(ALL, epoch="2020-01-01"))
    ok(rc != 0, "rc != 0 — no se hereda de otra numeracion")
    ok(untouched, "el snapshot queda intacto")


def test_bots_y_per_bot_files():
    print("5 - bots heredados y su compuerta de per-bot files")
    lg = snapshot(ALL, bots=[bot(25425, 1), bot(25425, 2), bot(32081, 9)],
                  positions=[{"login": 25425, "magic": 1, "symbol": "EURUSD"}])
    cur = snapshot([32081], bots=[bot(32081, 9)])

    rc, s, files, _ = run(cur, lg)
    magics = sorted(b["magic"] for b in s["bots"] if b["account_login"] == 25425)
    ok(rc == 0 and magics == [1, 2], "los bots de la cuenta caida no desaparecen del ranking")
    ok(files == ["25425-1.json", "25425-2.json"], f"sus per-bot files quedan en disco: {files}")
    nets = [b["net_profit"] for b in s["bots"]]
    ok(nets == sorted(nets, reverse=True), "el ranking se reordena por net_profit")
    ok(any(p.get("stale") for p in s["open_positions"]), "las posiciones heredadas van marcadas")

    # Un per-bot file que no se puede bajar NO puede colarse en el snapshot:
    # verify_integrity --strict abortaria el ciclo y congelaria el dashboard.
    rc, s, files, _ = run(cur, lg, missing_objects={"bots/vps3/25425-2.json"})
    magics = sorted(b["magic"] for b in s["bots"] if b["account_login"] == 25425)
    ok(rc == 0 and magics == [1], "el bot sin archivo se omite en vez de romper el ciclo")
    ok(s["real_portfolio"]["account_count"] == 5, "la cuenta se hereda igual")


def test_compuerta_del_cartel():
    print("6 - partial_data: una cuenta caida abre el cartel aunque la VPS este fresca")

    def partial(snap, vps_level=False):
        # Misma expresion que post_merge.py tras computar vps_freshness.
        if any(a.get("disconnected")
               for a in (snap.get("real_portfolio") or {}).get("accounts", [])):
            return True
        return vps_level

    _, sane, _, _ = run(snapshot(ALL), snapshot(ALL))
    _, down, _, _ = run(snapshot([32081]), snapshot(ALL))
    ok(partial(sane) is False, "cesta sana -> sin cartel")
    ok(partial(down) is True, "4 caidas -> cartel (antes era False: badge verde mintiendo)")


def test_verify_marca_las_heredadas():
    print("7 - verify_integrity sigue marcandolas pese a estar reinyectadas")
    _, s, _, _ = run(snapshot([32081]), snapshot(ALL))
    snap = {"vps_freshness": {"vps3": {"present": True, "stale": False,
                                       "carried_forward": False, "lag_sec": 300}},
            "accounts": s["real_portfolio"]["accounts"],
            "real_portfolio": s["real_portfolio"]}
    hard, _warn, degraded, detail = vi.check_freshness(snap, set(int(x) for x in ROSTER["reals"]), None)
    ok(not hard, "ninguna es hard: el ciclo NO aborta (el dashboard nunca se detiene)")
    ok(sorted(d["login"] for d in degraded) == [25425, 43306, 43411, 43414],
       "las 4 salen en el informe de integridad")
    ok([r["login"] for r in detail["real_accounts"] if r["live_feed"]] == [32081],
       "solo 32081 cuenta como feed vivo")


if __name__ == "__main__":
    for fn in (test_cesta_sana_no_toca_nada, test_cuatro_terminales_cerrados,
               test_caida_prolongada_cae_al_roster, test_guarda_de_epoca,
               test_bots_y_per_bot_files, test_compuerta_del_cartel,
               test_verify_marca_las_heredadas):
        fn()
    print(f"\n{CHECKS} comprobaciones OK")
