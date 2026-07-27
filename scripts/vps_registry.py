#!/usr/bin/env python3
"""Lector del registry de VPS (config/vps_registry.json) — fuente unica de verdad.

Ningun script debe volver a hardcodear la lista de VPS ni sus IPs. Importar desde
aqui (Python) o llamar por CLI (bash):

    python3 scripts/vps_registry.py ids       -> vps1 vps2 ... (una por linea)
    python3 scripts/vps_registry.py entries   -> vps1=trader@100.118.159.44
    python3 scripts/vps_registry.py ips       -> 100.118.159.44 ...

La numeracion es la del owner (#N Package del proveedor). Ver el _doc del JSON.
"""
import json
import sys
from pathlib import Path

_CONFIG = Path(__file__).resolve().parent.parent / "config"
REGISTRY_PATH = _CONFIG / "vps_registry.json"
# Overlay gitignored con los endpoints RDP publicos. ESTE repo es publico, asi que
# las IPs publicas no se commitean: publicarlas es senalar donde apuntar un ataque
# de fuerza bruta contra RDP. Nada operativo depende de ellas — se conecta por
# Tailscale — por eso su ausencia nunca es un error.
LOCAL_PATH = _CONFIG / "vps_registry.local.json"

_data = json.loads(REGISTRY_PATH.read_text())
SSH_USER = _data.get("ssh_user", "trader")
CUTOVER_DATE = _data.get("cutover_date")
RECORDS = _data["vps"]

RDP_PORT = None
if LOCAL_PATH.exists():
    _local = json.loads(LOCAL_PATH.read_text())
    RDP_PORT = _local.get("rdp_port")
    for _r in RECORDS:
        _ip = (_local.get("public_ip") or {}).get(_r["id"])
        if _ip:
            _r["public_ip"] = _ip

_BY_ID = {r["id"]: r for r in RECORDS}
_BY_LEGACY = {r["legacy_id"]: r for r in RECORDS if r.get("legacy_id")}


def ids():
    """['vps1', ..., 'vps6'] en orden canonico."""
    return [r["id"] for r in RECORDS]


def ssh_host(vps_id):
    """'trader@100.118.159.44' — destino SSH por la tailnet."""
    return f"{SSH_USER}@{_BY_ID[vps_id]['tailscale_ip']}"


def roster():
    """[('vps1', 'trader@100.118.159.44'), ...] — para iterar la flota."""
    return [(r["id"], ssh_host(r["id"])) for r in RECORDS]


def get(vps_id):
    """Registro completo: public_ip, tailscale_ip, hostname, package, ..."""
    return _BY_ID[vps_id]


def from_legacy(legacy_id):
    """Traduce una etiqueta anterior al 2026-07-27 a la numeracion del owner."""
    r = _BY_LEGACY.get(legacy_id)
    return r["id"] if r else None


def _main(argv):
    what = argv[1] if len(argv) > 1 else "ids"
    if what == "ids":
        print("\n".join(ids()))
    elif what == "entries":
        print("\n".join(f"{i}={h}" for i, h in roster()))
    elif what == "ips":
        print("\n".join(r["tailscale_ip"] for r in RECORDS))
    elif what == "table":
        has_pub = any("public_ip" in r for r in RECORDS)
        head = f"{'ID':6} {'TAILSCALE':16} {'HOSTNAME':13} {'ANTES':6} PAQUETE"
        if has_pub:
            head = f"{'ID':6} {'RDP (local)':22} " + head[7:]
        print(head)
        for r in RECORDS:
            pub = f"{r['public_ip']}:{RDP_PORT} " if has_pub and "public_ip" in r else ""
            print(f"{r['id']:6} {pub:{22 if has_pub else 0}}{r['tailscale_ip']:16} "
                  f"{r['hostname']:13} {r['legacy_id']:6} {r['package']}")
    else:
        print(f"uso: {argv[0]} [ids|entries|ips|table]", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
