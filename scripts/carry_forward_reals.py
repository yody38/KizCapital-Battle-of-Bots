#!/usr/bin/env python3
"""
carry_forward_reals.py — cesta fija de cuentas reales (nivel CUENTA).

Hermano de carry_forward_stale.py, que cubre el nivel VPS: cuando la VPS entera
no responde, aquel hereda su archivo completo. Este cubre el hueco que quedaba:
la VPS responde y su snapshot es FRESCO, pero uno de sus terminales MT5 está
cerrado, así que esa cuenta real simplemente no aparece en el ciclo.

Sin este paso, `real_portfolio` (scripts/mirror.sh) suma solo las cuentas
presentes, y una cuenta ausente deja de ser "sin dato" para convertirse en una
PÉRDIDA INVENTADA. Caso real que motivó el script (2026-08-20): VPS3 reinició a
las 05:31 UTC, volvió 1 terminal de 5, y el dashboard publicó $4,738.19 en vez de
$31,758.30 —$27,020 de dinero real evaporados— con `partial_data: false` y el
badge verde "Datos verificados". El cartel amarillo ni siquiera salió.

Lo que hace, sobre el data/snapshot.json YA mergeado:

  1. Lee el roster persistente (real_roster.json) — la lista canónica de cuentas
     reales activas, que verify_integrity ya publica cada ciclo.
  2. Para cada cuenta del roster ausente en este ciclo, hereda su objeto de
     cuenta del ÚLTIMO snapshot bueno, marcado `disconnected` + `stale` + `as_of`.
  3. Hereda también sus bots (y baja sus per-bot files) para que no desaparezcan
     del ranking y para que verify_integrity --strict siga pasando.
  4. Recalcula real_portfolio sobre la cesta completa y deja constancia en
     `real_accounts_live` / `real_accounts_expected` / `degraded_reals`.

NO abre ni toca nada en ninguna VPS: solo lee objetos ya publicados en Storage.

Fail-closed en lo que podría MENTIR (último bueno ilegible, época de numeración
distinta, per-bot file que no se puede bajar) y fail-soft en lo que solo degrada
(una cuenta que no está ni en el último bueno se deja ausente y verify_integrity
la marca igual). mirror.sh lo invoca sin abortar el ciclo si falla.

Usage:  python3 carry_forward_reals.py <data_dir>
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib import error as urlerror

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carry_forward_stale import load_env, storage_get  # noqa: E402

ROSTER_OBJECT = "real_roster.json"


def _epoch_ok(snap: dict) -> bool:
    """Misma guarda que carry_forward_stale: una etiqueta de VPS no es una
    máquina. Si el último bueno es de otra época de numeración, sus cuentas
    pudieron vivir en otra máquina física — preferimos NO heredar."""
    try:
        from vps_registry import CUTOVER_DATE as current_epoch
    except Exception:
        return True
    snap_epoch = snap.get("numbering_epoch")
    if snap_epoch != current_epoch:
        print(f"carry_forward_reals: el ultimo snapshot es de otra epoca de numeracion "
              f"(snapshot={snap_epoch!r} actual={current_epoch!r}) — NO se hereda",
              file=sys.stderr)
        return False
    return True


def _recompute_real_portfolio(snap: dict, expected: int) -> None:
    real_accounts = [a for a in snap.get("accounts", []) if a.get("is_real")]
    # `live` se deriva del propio snapshot: una cuenta que llegó por el
    # carry-forward de VPS (carry_forward_stale.py) ya viene marcada
    # `disconnected` desde el ciclo anterior y no es dato de hoy.
    live = sum(1 for a in real_accounts if not a.get("disconnected"))
    real_logins = {a.get("login") for a in real_accounts}
    real_positions = [p for p in snap.get("open_positions", []) if p.get("login") in real_logins]
    snap["real_portfolio"] = {
        "total_balance": round(sum(a.get("balance", 0) or 0 for a in real_accounts), 2),
        "total_equity": round(sum(a.get("equity", 0) or 0 for a in real_accounts), 2),
        "total_unrealised_pnl": round(sum(a.get("profit", 0) or 0 for a in real_accounts), 2),
        "total_open_margin": round(sum(a.get("margin", 0) or 0 for a in real_accounts), 2),
        "account_count": len(real_accounts),
        "accounts": real_accounts,
        "open_positions": real_positions,
        # Cuántas de la cesta fija traen dato de ESTE ciclo. Si live < expected,
        # los totales de arriba incluyen cifras heredadas y la UI debe decirlo.
        "live_count": live,
        "expected_count": expected,
    }


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: carry_forward_reals.py <data_dir>")
    data_dir = Path(sys.argv[1])
    snap_path = data_dir / "snapshot.json"
    if not snap_path.exists():
        print("carry_forward_reals: no hay snapshot.json mergeado — nada que hacer", file=sys.stderr)
        return 1
    snap = json.loads(snap_path.read_text())

    url, key = load_env(data_dir)

    # 1 · Roster canónico. Sin roster no hay cesta fija que defender: se sale sin
    # tocar nada (el comportamiento de siempre), no se inventa una lista.
    try:
        roster = (json.loads(storage_get(url, key, ROSTER_OBJECT)) or {}).get("reals") or {}
    except (urlerror.URLError, json.JSONDecodeError, OSError) as e:
        print(f"carry_forward_reals: roster ilegible ({e}) — sin cesta fija este ciclo", file=sys.stderr)
        return 1
    expected_logins = {int(lg) for lg, rec in roster.items() if (rec or {}).get("active")}
    if not expected_logins:
        print("carry_forward_reals: roster vacio — nada que defender")
        return 0

    present = {a.get("login") for a in snap.get("accounts", []) if a.get("is_real")}
    missing = sorted(expected_logins - present)
    live = len(expected_logins & present)
    if not missing:
        _recompute_real_portfolio(snap, len(expected_logins))
        snap["degraded_reals"] = []
        snap_path.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")))
        print(f"carry_forward_reals: OK cesta completa {live}/{len(expected_logins)} — nada que heredar")
        return 0

    # 2 · Último snapshot bueno publicado — la única fuente con el objeto de
    # cuenta completo (server, leverage, equity, margin) que la tarjeta necesita.
    try:
        last_good = json.loads(storage_get(url, key, "snapshot.json"))
    except (urlerror.URLError, json.JSONDecodeError, OSError) as e:
        print(f"carry_forward_reals: no se puede leer el ultimo snapshot bueno: {e}", file=sys.stderr)
        return 1
    if not _epoch_ok(last_good):
        return 1

    as_of = last_good.get("generated_at")
    lg_accounts = {a.get("login"): a for a in last_good.get("accounts", []) if a.get("is_real")}
    carried, unrecoverable = [], []
    n_bots = n_files = 0

    for login in missing:
        src = lg_accounts.get(login)
        from_roster = False
        if not src:
            # El último bueno tampoco la tiene. Pasa cuando la caída lleva más de
            # un ciclo: el snapshot degradado ya se publicó y se convirtió en el
            # "último bueno", así que el objeto de cuenta completo se perdió.
            # El roster SÍ conserva `last_balance` (verify_integrity lo refresca
            # solo cuando la cuenta está presente), y un saldo real recordado —
            # marcado como tal — es infinitamente mejor que publicar la cuenta
            # como $0 y contar su desaparición como pérdida.
            rec = roster.get(str(login)) or roster.get(login) or {}
            bal = rec.get("last_balance")
            if bal is None:
                unrecoverable.append(login)
                continue
            src = {
                "login": login, "vps": rec.get("vps"), "is_real": True,
                "balance": bal, "equity": bal, "profit": 0, "margin": 0,
                "server": rec.get("server"), "leverage": rec.get("leverage"),
            }
            from_roster = True
        vps = src.get("vps")

        # 2a · Per-bot files ANTES de inyectar nada. verify_integrity --strict
        # exige un archivo por cada bot del snapshot: inyectar un bot cuyo
        # archivo no se pudo bajar abortaría el ciclo entero y congelaría el
        # dashboard — exactamente lo que este script existe para evitar.
        bots = [] if from_roster else [b for b in last_good.get("bots", [])
                                       if b.get("account_login") == login and b.get("magic")]
        ok_bots = []
        for b in bots:
            rel = f"bots/{vps}/{login}-{b['magic']}.json"
            dest = data_dir / "bots" / str(vps) / f"{login}-{b['magic']}.json"
            if dest.exists():
                ok_bots.append(b)
                continue
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(storage_get(url, key, rel))
                ok_bots.append(b)
                n_files += 1
            except Exception as e:  # noqa: BLE001
                print(f"carry_forward_reals[{login}]: per-bot fetch failed {rel}: {e} "
                      f"— ese bot no se hereda", file=sys.stderr)

        acct = dict(src)
        acct["disconnected"] = True
        acct["stale"] = True
        acct["as_of"] = as_of if not from_roster else None
        # `roster` = solo se pudo recuperar el saldo registrado; equity es una
        # aproximación (balance sin flotante) y la UI no debe presentarla como
        # una lectura del terminal.
        acct["carry_source"] = "roster" if from_roster else "snapshot"
        snap.setdefault("accounts", []).append(acct)

        for b in ok_bots:
            snap.setdefault("bots", []).append({**b, "stale": True, "as_of": as_of})
        n_bots += len(ok_bots)

        for p in last_good.get("open_positions", []):
            if p.get("login") == login:
                snap.setdefault("open_positions", []).append({**p, "stale": True, "as_of": as_of})

        carried.append({"login": login, "expected_vps": vps,
                        "as_of": as_of if not from_roster else None,
                        "carry_source": "roster" if from_roster else "snapshot"})

    if not carried:
        print(f"carry_forward_reals: {len(missing)} reales ausentes y ninguna heredable "
              f"({unrecoverable}) — se publica el total parcial", file=sys.stderr)
        _recompute_real_portfolio(snap, len(expected_logins))
        snap["degraded_reals"] = [{"login": lg, "expected_vps": None, "as_of": None}
                                  for lg in unrecoverable]
        snap_path.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")))
        return 0

    # 3 · Orden del ranking: el merge deja bots ordenados por net_profit desc y
    # el frontend numera por posición. Reinsertar sin reordenar mandaría los
    # bots heredados al final con un _rank que no les toca.
    snap["bots"].sort(key=lambda b: b.get("net_profit", 0) or 0, reverse=True)

    # Los totales globales incluyen las reales: sin esto la cifra de cartera
    # completa sufre el mismo salto falso que se está corrigiendo abajo.
    port = snap.setdefault("portfolio", {})
    injected = {c["login"] for c in carried}
    for a in (c for c in snap["accounts"] if c.get("login") in injected):
        port["total_balance"] = round((port.get("total_balance") or 0) + (a.get("balance") or 0), 2)
        port["total_equity"] = round((port.get("total_equity") or 0) + (a.get("equity") or 0), 2)
        port["total_unrealised_pnl"] = round((port.get("total_unrealised_pnl") or 0) + (a.get("profit") or 0), 2)
        port["total_open_margin"] = round((port.get("total_open_margin") or 0) + (a.get("margin") or 0), 2)
        port["account_count"] = (port.get("account_count") or 0) + 1

    _recompute_real_portfolio(snap, len(expected_logins))
    snap["degraded_reals"] = carried + [{"login": lg, "expected_vps": None, "as_of": None}
                                        for lg in unrecoverable]

    tmp = snap_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")))
    os.replace(tmp, snap_path)

    print(f"carry_forward_reals: OK live={live}/{len(expected_logins)} "
          f"heredadas={[c['login'] for c in carried]} bots={n_bots} per_bot_files={n_files} "
          f"as_of={as_of}" + (f" NO_HEREDABLES={unrecoverable}" if unrecoverable else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
