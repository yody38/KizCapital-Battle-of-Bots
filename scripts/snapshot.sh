#!/bin/bash
# Battle of Bots — snapshot fetcher.
# SSH to VPS, run snapshot_builder.py, atomically write result to data/snapshot.json.

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$DIR/data"
LOG="$DATA_DIR/snapshot.log"
OUT="$DATA_DIR/snapshot.json"
TMP="$DATA_DIR/snapshot.json.tmp"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_HOST="${SSH_HOST:-trader@100.81.54.93}"
REMOTE_PY='C:\mt5-mcp\venv\Scripts\python.exe'
REMOTE_SCRIPT='C:\mt5-mcp\snapshot_builder.py'

mkdir -p "$DATA_DIR"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

{
  echo "[$(ts)] snapshot.sh starting"
  if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 \
      "$SSH_HOST" "$REMOTE_PY $REMOTE_SCRIPT" > "$TMP" 2>>"$LOG"; then
    if [ -s "$TMP" ] && head -c 1 "$TMP" | grep -q '{'; then
      mv "$TMP" "$OUT"
      echo "[$(ts)] snapshot.sh OK — $(wc -c < "$OUT") bytes"
    else
      echo "[$(ts)] snapshot.sh FAIL — empty or invalid JSON"
      rm -f "$TMP"
      exit 1
    fi
  else
    echo "[$(ts)] snapshot.sh FAIL — ssh/script error"
    rm -f "$TMP"
    exit 1
  fi
} >> "$LOG" 2>&1
