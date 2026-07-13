#!/usr/bin/env python3
"""Fase 7½ del Ultra Tribunal — publica el veredicto para el dashboard.

1. Copia TODOS los verdict_*.json de la skill local (o del dir que indique
   TRIBUNAL_VERDICT_SRC) a tribunal/data/ del repo → fuente de verdad
   versionada que post_merge.py lee en cada ciclo CI.
2. Sube el veredicto MÁS RECIENTE como tribunal_verdict.json al bucket
   Supabase dashboard-data (redundancia de lectura directa).
3. git commit + push de los veredictos nuevos (autor Kiz Capital LLC; push
   vía GIT_ASKPASS con token de `gh auth token` para no colgar en keychain).

Uso: python3 sync_verdict.py [--no-push] [--no-upload]
"""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from build_expediente import load_env, BUCKET

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEST_DIR = REPO_ROOT / "tribunal" / "data"
DEFAULT_SRC = Path.home() / ".claude" / "skills" / "kiz-bot-tribunal" / "data"
VERDICT_RE = re.compile(r"^verdict_(\d{8})\S*\.json$")
GIT_AUTHOR = ("Kiz Capital LLC", "yoderiznaga21@gmail.com")


def copy_verdicts(src_dir: Path) -> list[Path]:
    DEST_DIR.mkdir(parents=True, exist_ok=True)
    copied = []
    for f in sorted(src_dir.glob("verdict_*.json")):
        if not VERDICT_RE.match(f.name):
            continue
        dest = DEST_DIR / f.name
        if dest.exists() and dest.read_bytes() == f.read_bytes():
            continue
        shutil.copy2(f, dest)
        copied.append(dest)
    return copied


def latest_verdict() -> Path | None:
    cands = [(VERDICT_RE.match(f.name).group(1), f)
             for f in DEST_DIR.glob("verdict_*.json") if VERDICT_RE.match(f.name)]
    return max(cands)[1] if cands else None


def upload_supabase(path: Path) -> bool:
    env = load_env()
    url = env["SUPABASE_URL"].rstrip("/")
    key = env["SUPABASE_SERVICE_ROLE_KEY"]
    req = urllib.request.Request(
        f"{url}/storage/v1/object/{BUCKET}/tribunal_verdict.json",
        data=path.read_bytes(),
        method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json", "x-upsert": "true"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return 200 <= resp.status < 300


def git(*args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(REPO_ROOT), *args],
                          capture_output=True, text=True, env=env)


def commit_and_push(copied: list[Path], push: bool) -> str:
    if not copied:
        return "sin cambios"
    env = dict(os.environ)
    env.update({
        "GIT_AUTHOR_NAME": GIT_AUTHOR[0], "GIT_AUTHOR_EMAIL": GIT_AUTHOR[1],
        "GIT_COMMITTER_NAME": GIT_AUTHOR[0], "GIT_COMMITTER_EMAIL": GIT_AUTHOR[1],
    })
    rels = [str(p.relative_to(REPO_ROOT)) for p in copied]
    git("add", "--", *rels)
    names = ", ".join(p.name for p in copied)
    r = git("commit", "-m", f"tribunal: sync veredicto(s) {names}", env=env)
    if r.returncode != 0:
        return f"commit falló: {r.stderr.strip()[:200]}"
    if not push:
        return f"commit ok ({names}), push omitido"
    # Push sin colgar en el prompt de osxkeychain: token one-shot vía GIT_ASKPASS.
    tok = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
    if tok.returncode == 0 and tok.stdout.strip():
        with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as h:
            h.write("#!/bin/sh\ncase \"$1\" in Username*) echo x-access-token;;"
                    " *) cat \"$GH_TOK_FILE\";; esac\n")
            helper = h.name
        with tempfile.NamedTemporaryFile("w", delete=False) as tf:
            tf.write(tok.stdout.strip())
            tok_file = tf.name
        os.chmod(helper, stat.S_IRWXU)
        os.chmod(tok_file, stat.S_IRUSR | stat.S_IWUSR)
        env["GIT_ASKPASS"] = helper
        env["GH_TOK_FILE"] = tok_file
        try:
            r = git("push", "origin", "HEAD:main", env=env)
        finally:
            os.unlink(helper)
            os.unlink(tok_file)
    else:
        r = git("push", "origin", "HEAD:main", env=env)  # entorno remoto: creds propias
    return f"commit+push ok ({names})" if r.returncode == 0 else \
        f"commit ok, push falló: {r.stderr.strip()[:200]}"


def main() -> int:
    push = "--no-push" not in sys.argv
    upload = "--no-upload" not in sys.argv
    src = Path(os.environ.get("TRIBUNAL_VERDICT_SRC") or DEFAULT_SRC)
    if not src.is_dir():
        print(json.dumps({"ok": False, "error": f"src no existe: {src}"}))
        return 2

    copied = copy_verdicts(src)
    latest = latest_verdict()
    up_msg = "omitido"
    if upload and latest:
        try:
            up_msg = "ok" if upload_supabase(latest) else "falló"
        except Exception as e:
            up_msg = f"falló: {e}"
    git_msg = commit_and_push(copied, push)

    print(json.dumps({
        "ok": True, "copied": [p.name for p in copied],
        "latest": latest.name if latest else None,
        "supabase_upload": up_msg, "git": git_msg,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
