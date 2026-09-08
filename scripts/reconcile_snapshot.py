#!/usr/bin/env python3
"""
reconcile_snapshot.py — Refresh snapshot.bots[] from per-bot files (source of truth).

Each VPS builder writes snapshot.json and per-bot files at slightly different
times. When mirror.sh pulls during an in-flight builder pass, snapshot.bots[i]
fields (trades, net_profit, last_trade) can lag behind the per-bot file by a
few minutes. Per-bot files are the canonical, complete history — this script
makes the merged snapshot consistent with them.

Updates for each bot in snapshot.bots[] when its per-bot file exists:
  - trades                 = len(per_bot.trades)
  - net_profit             = sum(profit + swap) over per_bot.trades
  - wins / losses          = recomputed from per_bot.trades
  - win_rate_pct           = recomputed
  - first_trade / last_trade = from per_bot.trades[0|-1].close_time
  - gross_profit / gross_loss = recomputed

Runs after the merge step, before post_merge.py (so promotion scores see
fresh data). Safe to run any time — idempotent.

[FASE 1-B · 2026-09-08] Ademas de lo anterior, que se mantiene BYTE A BYTE
igual, ahora ANADE campos con la ventana explicita en el nombre y no
sobrescribe ninguno nuevo:

  *_365d      copia del valor del builder ANTES de que estas lineas lo pisen
  *_lifetime  recalculado con comision incluida (net = profit+commission+swap)

Por que: el builder calcula sobre 365 dias y este script sobrescribia con
valores de por vida, asi que `norm_net_return` dividia dinero de por vida
entre meses de 365 dias e inflaba a los bots viejos por un factor aproximado
a su edad en anos. Los campos sin sufijo conservan su semantica mezclada
actual para no mover ni un numero de la UI viva; `metrics_meta` la documenta.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from kiz import metrics as kiz_metrics  # noqa: E402
from kiz import windows as kiz_windows  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SNAPSHOT = DATA_DIR / "snapshot.json"
BOTS_DIR = DATA_DIR / "bots"


# Campos que este script pisa con valores de por vida. Se copian a `<campo>_365d`
# ANTES de pisarlos: son los unicos valores de 365 dias que existen.
OVERWRITTEN_FIELDS = (
    "trades", "net_profit", "wins", "losses",
    "win_rate_pct", "gross_profit", "gross_loss",
)
# Campos que el builder deja intactos pero que tambien son de 365 dias: se
# duplican con sufijo para que el juego de ventanas quede completo.
BUILDER_365D_FIELDS = (
    "months_active", "max_drawdown", "calmar", "sortino", "profit_factor",
)


def to_iso(ts: int | float | None) -> str | None:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def _round4(value):
    return None if value is None else round(value, 4)


def reconcile_bot(bot: dict, generated_at: str | None = None) -> tuple[bool, str | None]:
    """Returns (updated, reason). reason is None when nothing to do."""
    vps = bot.get("vps")
    login = bot.get("account_login")
    magic = bot.get("magic")
    if not vps or login is None or not magic:
        return False, None
    pb_path = BOTS_DIR / vps / f"{login}-{magic}.json"
    if not pb_path.exists():
        return False, "per-bot missing"
    try:
        pb = json.loads(pb_path.read_text(encoding="utf-8"))
    except Exception:
        return False, "per-bot unreadable"
    trades = pb.get("trades")
    if not isinstance(trades, list):
        return False, "trades not list"

    n = len(trades)
    wins = sum(1 for t in trades if (t.get("profit", 0) + t.get("swap", 0)) > 0)
    losses = n - wins
    gross_profit = round(sum(max(t.get("profit", 0) + t.get("swap", 0), 0) for t in trades), 2)
    gross_loss = round(sum(min(t.get("profit", 0) + t.get("swap", 0), 0) for t in trades), 2)
    net_profit = round(sum(t.get("profit", 0) + t.get("swap", 0) for t in trades), 2)
    win_rate = round((wins / n * 100) if n else 0.0, 2)
    first_close = trades[0].get("close_time") if n else None
    last_close = trades[-1].get("close_time") if n else None

    # --- ADITIVO (1/2): fotografiar la ventana de 365 d del builder ---------
    # Se hace ANTES de las sobrescrituras de abajo, que es el unico momento en
    # que estos valores existen. Idempotente: si ya hay sufijo, no se toca.
    for field in OVERWRITTEN_FIELDS + BUILDER_365D_FIELDS:
        key = f"{field}_365d"
        if key not in bot and field in bot:
            bot[key] = bot[field]

    before = (bot.get("trades"), bot.get("net_profit"))
    bot["trades"] = n
    bot["net_profit"] = net_profit
    bot["wins"] = wins
    bot["losses"] = losses
    bot["win_rate_pct"] = win_rate
    bot["gross_profit"] = gross_profit
    bot["gross_loss"] = gross_loss
    if first_close:
        bot["first_trade"] = to_iso(first_close) or bot.get("first_trade")
    if last_close:
        bot["last_trade"] = to_iso(last_close) or bot.get("last_trade")
    # --- ADITIVO (2/2): agregados de por vida, con comision --------------
    # `series` reutiliza el daily_equity_series que el builder ya escribio en
    # el archivo per-bot: evita recalcularlo por bot en cada ciclo.
    series = pb.get("daily_equity_series") or None
    balance = bot.get("account_balance") or pb.get("account_balance")
    try:
        bot.update(kiz_metrics.aggregates(
            trades, balance=balance, suffix="lifetime", series=series,
        ))
        # Neto de 365 d con comision: lo consume el score v2. Se ancla al
        # generated_at del snapshot, nunca al reloj, por el gate de determinismo.
        recent = kiz_windows.filter_trades(trades, 365, generated_at)
        bot["net_after_commission_365d"] = round(
            sum(kiz_metrics.trade_net(t) for t in recent), 2
        )
        bot["return_monthly_pct_365d"] = _round4(kiz_metrics.return_monthly_pct(
            bot["net_after_commission_365d"], balance, bot.get("months_active_365d"),
        ))
        bot["return_monthly_pct_lifetime"] = _round4(kiz_metrics.return_monthly_pct(
            bot.get("net_after_commission_lifetime"), balance,
            bot.get("months_active_lifetime"),
        ))
    except Exception as exc:  # noqa: BLE001 — enriquecer nunca aborta el ciclo
        bot["metrics_error"] = f"{type(exc).__name__}: {exc}"

    after = (bot["trades"], bot["net_profit"])
    return (before != after), None


def main() -> int:
    if not SNAPSHOT.exists():
        print(f"FATAL: {SNAPSHOT} missing", file=sys.stderr)
        return 1
    snap = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    generated_at = snap.get("generated_at")
    bots = snap.get("bots", [])
    updated = 0
    skipped_missing = 0
    skipped_unreadable = 0
    for bot in bots:
        if bot.get("magic", 0) == 0:
            continue
        was_updated, reason = reconcile_bot(bot, generated_at)
        if was_updated:
            updated += 1
        if reason == "per-bot missing":
            skipped_missing += 1
        elif reason == "per-bot unreadable":
            skipped_unreadable += 1

    bots.sort(key=lambda b: b.get("net_profit", 0), reverse=True)
    snap["bots"] = bots
    snap["reconciled_at"] = datetime.now(timezone.utc).isoformat()
    # Contrato de ventanas: viaja con el dato para que ningun consumidor tenga
    # que adivinar que significa un campo sin sufijo.
    snap["metrics_meta"] = {
        "schema": 1,
        "window_days": 365,
        "commission_policy": {
            "suffixed_lifetime": "net = profit + commission + swap",
            "unsuffixed_legacy": "net = profit + swap (sin comision)",
        },
        "legacy_unsuffixed": {
            "lifetime": list(OVERWRITTEN_FIELDS) + ["first_trade", "last_trade"],
            "365d": list(BUILDER_365D_FIELDS),
        },
    }

    tmp = SNAPSHOT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(SNAPSHOT)

    print(
        f"[reconcile] bots={len(bots)} updated={updated} "
        f"skipped_missing={skipped_missing} skipped_unreadable={skipped_unreadable}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
