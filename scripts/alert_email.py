#!/usr/bin/env python3
"""
alert_email.py — Out-of-band email alerts for Kiz Capital Battle of Bots.

Sends SMTP email via Gmail using an App Password stored in macOS Keychain.
Independent of GitHub Actions — runs on the Mac so it alerts even when the
GH-Actions pipeline is fully down (e.g., billing blocked).

One-time Keychain setup (user runs once):
    security add-generic-password \\
        -a yoderiznaga21@gmail.com \\
        -s kizcapital-gmail-apppass \\
        -w '<16-char Gmail App Password, no spaces>'

Usage:
    alert_email.py --subject S --body B --dedupe-key K [--dedupe-window-min N]
    alert_email.py --self-test           # send a test email to confirm wiring

Exit codes:
    0  email sent (or skipped due to dedupe — both are success)
    2  send failed (network, auth, keychain miss)
"""
from __future__ import annotations

import argparse
import json
import os
import smtplib
import ssl
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = ROOT / "data" / ".alert_state.json"

GMAIL_USER = "yoderiznaga21@gmail.com"
GMAIL_TO = "yoderiznaga21@gmail.com"
KEYCHAIN_SERVICE = "kizcapital-gmail-apppass"
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def dedupe_should_skip(key: str, window_min: int) -> tuple[bool, str | None]:
    if not key or window_min <= 0:
        return False, None
    state = load_state()
    last_iso = state.get(key)
    if not last_iso:
        return False, None
    try:
        last = datetime.fromisoformat(last_iso)
    except Exception:
        return False, None
    age = datetime.now(timezone.utc) - last
    if age < timedelta(minutes=window_min):
        return True, last_iso
    return False, last_iso


def mark_sent(key: str) -> None:
    if not key:
        return
    state = load_state()
    state[key] = now_iso()
    save_state(state)


def read_app_password() -> str:
    """Returns the Gmail App Password from macOS Keychain. Never prints it."""
    try:
        out = subprocess.run(
            ["security", "find-generic-password",
             "-a", GMAIL_USER, "-s", KEYCHAIN_SERVICE, "-w"],
            check=True, capture_output=True, text=True, timeout=10,
        )
        pw = out.stdout.strip()
        if not pw:
            raise RuntimeError("empty keychain value")
        return pw
    except subprocess.CalledProcessError:
        raise RuntimeError(
            f"Keychain entry '{KEYCHAIN_SERVICE}' for '{GMAIL_USER}' not found. "
            "Create with: security add-generic-password -a yoderiznaga21@gmail.com "
            f"-s {KEYCHAIN_SERVICE} -w '<app-password>'"
        )


def send(subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["From"] = GMAIL_USER
    msg["To"] = GMAIL_TO
    msg["Subject"] = subject
    msg.set_content(body)

    pw = read_app_password()
    ctx = ssl.create_default_context()
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
        s.ehlo()
        s.starttls(context=ctx)
        s.ehlo()
        s.login(GMAIL_USER, pw)
        s.send_message(msg)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--subject", default="")
    p.add_argument("--body", default="")
    p.add_argument("--body-file", default="", help="Read body from a file (overrides --body)")
    p.add_argument("--dedupe-key", default="")
    p.add_argument("--dedupe-window-min", type=int, default=30)
    p.add_argument("--self-test", action="store_true")
    args = p.parse_args()

    if args.self_test:
        args.subject = "[Kiz Capital] alert_email.py self-test"
        args.body = (
            f"Self-test sent at {now_iso()} from {os.uname().nodename}.\n"
            "If you see this, SMTP + Keychain wiring is working."
        )
        args.dedupe_key = ""

    if not args.subject:
        print("error: --subject required", file=sys.stderr)
        return 2

    body = args.body
    if args.body_file:
        body = Path(args.body_file).read_text(encoding="utf-8")
    if not body:
        body = args.subject

    skip, last = dedupe_should_skip(args.dedupe_key, args.dedupe_window_min)
    if skip:
        print(f"[alert_email] skip dedupe key={args.dedupe_key} last={last}")
        return 0

    try:
        send(args.subject, body)
    except Exception as e:
        print(f"[alert_email] FAIL: {e}", file=sys.stderr)
        return 2

    mark_sent(args.dedupe_key)
    print(f"[alert_email] sent subject={args.subject!r} dedupe={args.dedupe_key or '-'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
