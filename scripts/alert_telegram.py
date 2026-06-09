"""
Kiz Capital LLC · Battle of Bots — Telegram alert helper

Single send() used by mcp_health.py and integrity_watchdog.py at the exact
points where they create/refresh a GitHub Issue — those paths are already
deduped (1 issue per kind per day), which keeps the alert budget naturally
bounded (tribunal 2026-06-09: max ~2 alerts/day, consolidation over spam).

Covers the documented blind window (Las Vegas sleep, 05:00-16:00 UTC): the
phone buzzes instead of an Issue waiting unseen until morning.

Env (GitHub Actions secrets → step env):
    TELEGRAM_BOT_TOKEN   from @BotFather
    TELEGRAM_CHAT_ID     numeric chat id (getUpdates after messaging the bot)

No-op (returns "skipped") when env is absent — the pipeline NEVER fails or
blocks on alerting. Network errors are swallowed and reported in the return
string for the caller's log line.

Manual test:
    TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... python3 alert_telegram.py --test
"""
from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request

API_TIMEOUT = 10
MAX_LEN = 3900  # Telegram hard limit 4096; keep headroom for the header


def send(text: str, *, source: str = "battle-of-bots") -> str:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        return "skipped (no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)"
    body = f"🤖 Kiz Capital · {source}\n{text}"
    if len(body) > MAX_LEN:
        body = body[: MAX_LEN - 12] + "\n…(truncado)"
    payload = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": body,
        "disable_web_page_preview": "true",
    }).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage", data=payload)
    try:
        with urllib.request.urlopen(req, timeout=API_TIMEOUT) as r:
            ok = json.loads(r.read().decode()).get("ok", False)
            return "sent" if ok else "api_not_ok"
    except Exception as e:  # noqa: BLE001 — alerting must never break the caller
        return f"send_failed: {type(e).__name__}"


if __name__ == "__main__":
    if "--test" in sys.argv:
        print(send("Mensaje de prueba — canal de alertas operativo ✅", source="test"))
    else:
        print(send(sys.stdin.read().strip() or "(vacío)", source="stdin"))
