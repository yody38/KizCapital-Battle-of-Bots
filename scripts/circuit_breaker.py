#!/usr/bin/env python3
"""Circuit breaker con estado (closed → open → half-open) por endpoint.

Complementa el fail-closed binario del pipeline: tras `fail_threshold` fallos
consecutivos el endpoint queda OPEN (se salta directo al fallback sin quemar
reintentos ni timeouts); pasado `cooldown_sec` entra en HALF-OPEN y permite
UNA sonda — éxito → CLOSED, fallo → OPEN de nuevo. Estado compartido en un
JSON con flock (mirror.sh corre las VPS en subshells paralelos).

Librería (upload_to_supabase.py):
    br = Breaker("supabase_storage", state_path)
    if br.allow(): ...trabajo...; br.record(ok)

CLI (mirror.sh):
    circuit_breaker.py --state FILE budget NAME FULL   # imprime intentos: FULL/1/0
    circuit_breaker.py --state FILE record NAME ok|fail
    circuit_breaker.py --state FILE status             # JSON de todos los breakers
"""
from __future__ import annotations

import fcntl
import json
import sys
import time
from pathlib import Path

DEFAULT_FAIL_THRESHOLD = 3
DEFAULT_COOLDOWN_SEC = 300


def _fresh() -> dict:
    return {"state": "closed", "fails": 0, "opened_at": 0.0, "trips": 0, "last_change": 0.0}


class Breaker:
    def __init__(
        self,
        name: str,
        state_path: str | Path,
        fail_threshold: int = DEFAULT_FAIL_THRESHOLD,
        cooldown_sec: float = DEFAULT_COOLDOWN_SEC,
    ) -> None:
        self.name = name
        self.path = Path(state_path)
        self.fail_threshold = fail_threshold
        self.cooldown_sec = cooldown_sec

    # -- persistencia (flock: subshells de mirror.sh escriben en paralelo) --

    def _mutate(self, fn):
        """Lee-modifica-escribe todo el archivo bajo lock. fn(entry) -> result."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "a+", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.seek(0)
            raw = f.read()
            try:
                allb = json.loads(raw) if raw.strip() else {}
            except ValueError:
                allb = {}  # estado corrupto → empezar limpio (breaker es best-effort)
            entry = allb.get(self.name) or _fresh()
            result = fn(entry)
            allb[self.name] = entry
            f.seek(0)
            f.truncate()
            json.dump(allb, f, indent=2, sort_keys=True)
        return result

    # -- API --

    def allow(self) -> bool:
        """True si se permite llamar al endpoint. En OPEN dentro del cooldown →
        False. Cooldown vencido → transición a half-open y permite la sonda."""
        def fn(e):
            now = time.time()
            if e["state"] == "open":
                if now - e["opened_at"] >= self.cooldown_sec:
                    e["state"] = "half_open"
                    e["last_change"] = now
                    return True  # sonda única
                return False
            return True  # closed o half_open (la sonda ya está en vuelo este proceso)

        return self._mutate(fn)

    def record(self, ok: bool) -> str:
        """Registra el resultado y devuelve el estado resultante."""
        def fn(e):
            now = time.time()
            if ok:
                if e["state"] != "closed":
                    e["last_change"] = now
                e.update(state="closed", fails=0)
            else:
                e["fails"] = int(e.get("fails", 0)) + 1
                reopen = e["state"] == "half_open" or e["fails"] >= self.fail_threshold
                if reopen and e["state"] != "open":
                    e.update(state="open", opened_at=now, last_change=now)
                    e["trips"] = int(e.get("trips", 0)) + 1
            return e["state"]

        return self._mutate(fn)

    def current_state(self) -> str:
        def fn(e):
            return e["state"]
        return self._mutate(fn)


def load_all(state_path: str | Path) -> dict:
    """Snapshot de todos los breakers para telemetría (integrity_report)."""
    try:
        return json.loads(Path(state_path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


# -- CLI para mirror.sh -----------------------------------------------------

def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[1] != "--state":
        print(__doc__, file=sys.stderr)
        return 2
    state, cmd = argv[2], argv[3]
    if cmd == "status":
        print(json.dumps(load_all(state), indent=2, sort_keys=True))
        return 0
    name = argv[4] if len(argv) > 4 else ""
    if not name:
        print("missing breaker NAME", file=sys.stderr)
        return 2
    br = Breaker(name, state)
    if cmd == "budget":
        # Intentos recomendados: FULL en closed, 1 en half-open (sonda), 0 en open.
        full = int(argv[5]) if len(argv) > 5 else 3
        if not br.allow():
            print(0)
        elif br.current_state() == "half_open":
            print(1)
        else:
            print(full)
        return 0
    if cmd == "record":
        ok = len(argv) > 5 and argv[5] == "ok"
        print(br.record(ok))
        return 0
    print(f"unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
