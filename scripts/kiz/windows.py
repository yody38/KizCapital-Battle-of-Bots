"""Ventanas temporales canonicas.

El defecto mas caro del sistema nacia de mezclar ventanas sin decirlo: el
builder calcula sobre 365 dias, `reconcile_snapshot` sobrescribia con valores
de por vida, y el score dividia dinero de por vida entre meses de 365 dias.
Aqui la ventana es explicita y viaja en el nombre del campo.

Sufijos: `_lifetime`, `_365d`, `_180d`, `_90d`, `_30d`, `_current`.
"""
from __future__ import annotations

from datetime import datetime, timezone

# Dias por ventana. LIFETIME es None: sin recorte.
WINDOWS = {
    "lifetime": None,
    "365d": 365,
    "180d": 180,
    "90d": 90,
    "30d": 30,
}

SECONDS_PER_DAY = 86400


def parse_iso(value):
    """ISO-8601 -> datetime aware en UTC. None si no se puede interpretar."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        txt = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(txt)
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def anchor_ts(snapshot_generated_at=None):
    """Epoch (segundos) al que se anclan las ventanas.

    Se usa `snapshot.generated_at` en vez del reloj de pared para que dos
    ejecuciones del mismo snapshot den EXACTAMENTE el mismo resultado: es lo
    que exige el gate de determinismo. Solo si falta se cae al reloj.
    """
    dt = parse_iso(snapshot_generated_at)
    if dt is None:
        dt = datetime.now(timezone.utc)
    return dt.timestamp()


def cutoff_ts(days, snapshot_generated_at=None):
    """Epoch a partir del cual un trade entra en la ventana. None = sin corte."""
    if days is None:
        return None
    return anchor_ts(snapshot_generated_at) - days * SECONDS_PER_DAY


def close_ts(trade):
    """close_time de un trade como epoch en segundos, o None."""
    raw = trade.get("close_time", trade.get("time_close"))
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    dt = parse_iso(raw)
    return dt.timestamp() if dt else None


def filter_trades(trades, days, snapshot_generated_at=None):
    """Trades cerrados dentro de la ventana. days=None devuelve la lista tal cual."""
    if days is None:
        return list(trades or [])
    cut = cutoff_ts(days, snapshot_generated_at)
    out = []
    for t in trades or []:
        ts = close_ts(t)
        if ts is not None and ts >= cut:
            out.append(t)
    return out


def month_key(trade):
    """'YYYY-MM' del cierre del trade, o None."""
    ts = close_ts(trade)
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m")


def months_active(trades):
    """Numero de meses calendario distintos con al menos un cierre.

    Misma definicion que `_consistency_metrics` del builder, para que
    `months_active_365d` calculado aqui coincida con el suyo.
    """
    return len({m for m in (month_key(t) for t in trades or []) if m})
