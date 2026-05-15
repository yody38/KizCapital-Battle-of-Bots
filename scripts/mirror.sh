#!/bin/bash
# Battle of Bots — multi-VPS mirror + merger.
# Pulls per-VPS snapshots from VPS1 & VPS2, merges into a single snapshot.json
# annotated with `vps` field on each account/bot.

set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$DIR/data"
LOG="$DATA_DIR/mirror.log"
OUT="$DATA_DIR/snapshot.json"
TMP="$DATA_DIR/snapshot.json.mirror.tmp"

SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_FILE='C:/mt5-mcp/snapshot.json'
REMOTE_BOTS_DIR='C:/mt5-mcp/bots'
REMOTE_READY_FILE='C:/mt5-mcp/bots/.ready'
BOTS_OUT_DIR="$DATA_DIR/bots"

# Hard freshness gate: a VPS snapshot older than this is treated as a failure.
SNAPSHOT_MAX_AGE_SEC=${SNAPSHOT_MAX_AGE_SEC:-1800}
# Per-bot scp retries (kept as a defence-in-depth in case the .ready flag is
# absent on a VPS that hasn't been upgraded to builder v3 yet).
BOTS_SCP_MAX_ATTEMPTS=${BOTS_SCP_MAX_ATTEMPTS:-3}
BOTS_SCP_RETRY_DELAY_SEC=${BOTS_SCP_RETRY_DELAY_SEC:-15}
# Set to 1 to abort the cycle when a VPS lacks a valid .ready flag (strict).
# Default 0 during rollout: the .ready check is performed and logged, but
# absence falls back to the legacy bots-scp-with-retry path. Flip to 1 once
# every VPS reliably emits .ready (builder v3+).
READY_FLAG_REQUIRED=${READY_FLAG_REQUIRED:-0}

# Shared scp options: ServerAlive keeps the transfer from hanging when the link stalls.
SCP_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
          -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

# VPS roster (format "id=host"). Add entries here to scale.
VPS_ENTRIES=(
  "vps1=trader@100.81.54.93"
  "vps2=trader@100.101.9.46"
  "vps3=trader@100.118.159.44"
  "vps4=trader@100.125.237.26"
  "vps5=trader@100.70.228.19"
)

mkdir -p "$DATA_DIR" "$BOTS_OUT_DIR"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

declare -a FRESH_FILES=()

FATAL_VPS=""

# Compute the expected bot count for a VPS from its just-fetched snapshot.json
# (only bots with magic != 0, matching the merge step further down).
expected_bots_in_snapshot() {
  python3 - "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    print(sum(1 for b in data.get('bots', []) if (b.get('magic') or 0) != 0))
except Exception:
    print(-1)
PY
}

# Snapshot age in seconds (now - generated_at). Returns -1 on parse error.
snapshot_age_sec() {
  python3 - "$1" <<'PY'
import json, sys
from datetime import datetime, timezone
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
    g = data.get('generated_at')
    if not g:
        print(-1); raise SystemExit
    if g.endswith('Z'):
        g = g[:-1] + '+00:00'
    dt = datetime.fromisoformat(g)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    print(int((datetime.now(timezone.utc) - dt).total_seconds()))
except Exception:
    print(-1)
PY
}

{
  echo "[$(ts)] mirror starting"
  for entry in "${VPS_ENTRIES[@]}"; do
    id="${entry%%=*}"
    host="${entry#*=}"
    local_file="$DATA_DIR/snapshot_${id}.json"
    local_tmp="${local_file}.tmp"

    # --- snapshot.json fetch (mandatory, fail-closed with retry) ---
    # Retry absorbs transient Tailscale flakes on CI runner cold-start: the
    # first scp can hit a connection-timeout while the route is rehashing,
    # but a second attempt 15 s later normally succeeds.
    snap_scp_ok=0
    for attempt in $(seq 1 "$BOTS_SCP_MAX_ATTEMPTS"); do
      rm -f "$local_tmp"
      if scp "${SCP_OPTS[@]}" "$host:$REMOTE_FILE" "$local_tmp" 2>&1; then
        if [ -s "$local_tmp" ] && head -c 1 "$local_tmp" | grep -q '{'; then
          snap_scp_ok=1
          echo "[$(ts)] $id snapshot scp OK on attempt $attempt"
          break
        else
          echo "[$(ts)] $id snapshot INVALID JSON on attempt $attempt — retrying"
        fi
      else
        echo "[$(ts)] $id snapshot SCP error on attempt $attempt — retrying"
      fi
      if [ "$attempt" -lt "$BOTS_SCP_MAX_ATTEMPTS" ]; then
        sleep "$BOTS_SCP_RETRY_DELAY_SEC"
      fi
    done
    if [ "$snap_scp_ok" -ne 1 ]; then
      echo "[$(ts)] $id snapshot scp FAILED after $BOTS_SCP_MAX_ATTEMPTS attempts — aborting cycle (fail-closed)"
      rm -f "$local_tmp"
      FATAL_VPS="$id:snapshot_scp_exhausted"
      break
    fi
    mv "$local_tmp" "$local_file"

    age=$(snapshot_age_sec "$local_file")
    if [ "$age" -lt 0 ] || [ "$age" -gt "$SNAPSHOT_MAX_AGE_SEC" ]; then
      echo "[$(ts)] $id snapshot.json STALE age=${age}s threshold=${SNAPSHOT_MAX_AGE_SEC}s — aborting cycle"
      FATAL_VPS="$id:snapshot_stale_${age}s"
      break
    fi
    echo "[$(ts)] $id OK $(wc -c < "$local_file") bytes age=${age}s"

    expected_bots=$(expected_bots_in_snapshot "$local_file")
    if [ "$expected_bots" -lt 0 ]; then
      echo "[$(ts)] $id could not parse expected bot count — aborting"
      FATAL_VPS="$id:bots_count_parse"
      break
    fi

    # --- .ready flag (builder v3+) ---
    # The builder writes this file atomically as the LAST step of its cycle.
    # If we can read it AND its ts matches snapshot.generated_at, we're safe
    # to scp the per-bot dir — the builder is fully done with this cycle.
    ready_local="$DATA_DIR/.ready_${id}.json"
    rm -f "$ready_local"
    snap_ts=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('generated_at',''))" "$local_file")
    ready_valid=0
    if scp "${SCP_OPTS[@]}" "$host:$REMOTE_READY_FILE" "$ready_local" 2>/dev/null; then
      if [ -s "$ready_local" ]; then
        ready_ts=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('ts',''))" "$ready_local" 2>/dev/null)
        ready_bots=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('bot_files_count',-1))" "$ready_local" 2>/dev/null)
        if [ -n "$ready_ts" ] && [ "$ready_ts" = "$snap_ts" ]; then
          ready_valid=1
          echo "[$(ts)] $id .ready OK ts=$ready_ts bot_files_count=$ready_bots"
        else
          echo "[$(ts)] $id .ready MISMATCH ready_ts=$ready_ts snap_ts=$snap_ts — builder cycle inconsistent"
        fi
      else
        echo "[$(ts)] $id .ready empty"
      fi
    else
      echo "[$(ts)] $id .ready not present on remote"
    fi
    if [ "$ready_valid" -ne 1 ] && [ "$READY_FLAG_REQUIRED" -eq 1 ]; then
      FATAL_VPS="$id:ready_missing_or_mismatch"
      break
    fi

    # --- per-bot files fetch (with retry to absorb upstream-builder race) ---
    bots_target="$BOTS_OUT_DIR/$id"
    bots_staging="$BOTS_OUT_DIR/.${id}.staging"
    bots_attempt_ok=0
    for attempt in $(seq 1 "$BOTS_SCP_MAX_ATTEMPTS"); do
      rm -rf "$bots_staging"
      mkdir -p "$bots_staging"
      if scp "${SCP_OPTS[@]}" -r "$host:$REMOTE_BOTS_DIR/." "$bots_staging/" 2>&1; then
        staged=$(find "$bots_staging" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
        if [ "$expected_bots" -eq 0 ] || [ "$staged" -ge "$expected_bots" ]; then
          bots_attempt_ok=1
          echo "[$(ts)] $id bots scp OK on attempt $attempt — staged=$staged expected=$expected_bots"
          break
        else
          echo "[$(ts)] $id bots staged=$staged < expected=$expected_bots on attempt $attempt — retrying"
        fi
      else
        echo "[$(ts)] $id bots SCP error on attempt $attempt — retrying"
      fi
      if [ "$attempt" -lt "$BOTS_SCP_MAX_ATTEMPTS" ]; then
        sleep "$BOTS_SCP_RETRY_DELAY_SEC"
      fi
    done

    if [ "$bots_attempt_ok" -ne 1 ]; then
      echo "[$(ts)] $id bots scp FAILED after $BOTS_SCP_MAX_ATTEMPTS attempts — aborting cycle"
      rm -rf "$bots_staging"
      FATAL_VPS="$id:bots_scp_exhausted"
      break
    fi

    # Atomic swap: ensures dashboard NEVER hits a 404 window during refresh.
    bots_backup="${bots_target}.swap.$$"
    rm -rf "$bots_backup"
    if [ -d "$bots_target" ]; then mv "$bots_target" "$bots_backup"; fi
    mv "$bots_staging" "$bots_target"
    rm -rf "$bots_backup"
    bot_count=$(find "$bots_target" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    echo "[$(ts)] $id bots OK $bot_count files (atomic swap, expected=$expected_bots)"
    FRESH_FILES+=("$id:$local_file")
  done
} >> "$LOG" 2>&1

if [ -n "$FATAL_VPS" ]; then
  echo "[$(ts)] mirror FAIL — fail-closed on $FATAL_VPS (no upload)" >> "$LOG"
  exit 1
fi

if [ ${#FRESH_FILES[@]} -ne ${#VPS_ENTRIES[@]} ]; then
  echo "[$(ts)] mirror FAIL — got ${#FRESH_FILES[@]} VPS, expected ${#VPS_ENTRIES[@]}" >> "$LOG"
  exit 1
fi

# Merge via python (vanilla, no deps).
# Fail-closed mode: no VPS is ever marked stale by the mirror; if a VPS was
# stale we'd have already aborted above. STALE_ARG stays empty for API compat.
STALE_ARG=""

HISTORY_FILE="$DATA_DIR/history.jsonl"

python3 - "$OUT" "$TMP" "$HISTORY_FILE" "$STALE_ARG" "${FRESH_FILES[@]}" >> "$LOG" 2>&1 <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_path, tmp_path, history_path, stale_csv = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
stale_vps = set(x for x in stale_csv.split(',') if x)
entries = sys.argv[5:]

accounts, bots, positions, errors = [], [], [], []
generated_times = []
portfolio_totals = {'balance': 0.0, 'equity': 0.0, 'margin': 0.0, 'profit': 0.0}
account_count = 0
currency = None
window_days = None
per_vps = {}

for entry in entries:
    vps_id, path = entry.split(':', 1)
    with open(path) as f:
        data = json.load(f)
    per_vps[vps_id] = {
        'generated_at': data.get('generated_at'),
        'account_count': data.get('portfolio', {}).get('account_count', 0),
        'bot_count': len(data.get('bots', [])),
        'errors': data.get('errors', []),
        'stale': vps_id in stale_vps,
    }
    if data.get('generated_at'):
        generated_times.append(data['generated_at'])
    window_days = data.get('window_days', window_days)
    p = data.get('portfolio', {})
    portfolio_totals['balance'] += p.get('total_balance', 0) or 0
    portfolio_totals['equity'] += p.get('total_equity', 0) or 0
    portfolio_totals['margin'] += p.get('total_open_margin', 0) or 0
    portfolio_totals['profit'] += p.get('total_unrealised_pnl', 0) or 0
    account_count += p.get('account_count', 0) or 0
    if not currency and p.get('currency'):
        currency = p.get('currency')
    for a in data.get('accounts', []):
        accounts.append({**a, 'vps': vps_id})
    for b in data.get('bots', []):
        if b.get('magic') in (0, None):
            continue
        bots.append({**b, 'vps': vps_id})
    for pos in data.get('open_positions', []):
        positions.append({**pos, 'vps': vps_id})
    for e in data.get('errors', []):
        errors.append({**e, 'vps': vps_id})

bots.sort(key=lambda b: b['net_profit'], reverse=True)

real_accounts = [a for a in accounts if a.get('is_real')]
real_logins = {a['login'] for a in real_accounts}
real_positions = [p for p in positions if p.get('login') in real_logins]
real_portfolio = {
    'total_balance': round(sum(a.get('balance', 0) for a in real_accounts), 2),
    'total_equity': round(sum(a.get('equity', 0) for a in real_accounts), 2),
    'total_unrealised_pnl': round(sum(a.get('profit', 0) for a in real_accounts), 2),
    'total_open_margin': round(sum(a.get('margin', 0) for a in real_accounts), 2),
    'account_count': len(real_accounts),
    'accounts': real_accounts,
    'open_positions': real_positions,
}

ts = datetime.now(timezone.utc).isoformat()
snapshot = {
    'generated_at': ts,
    'oldest_source_generated_at': min(generated_times) if generated_times else None,
    'newest_source_generated_at': max(generated_times) if generated_times else None,
    'window_days': window_days,
    'vps_sources': per_vps,
    'stale_vps': sorted(list(stale_vps)),
    'portfolio': {
        'total_balance': round(portfolio_totals['balance'], 2),
        'total_equity': round(portfolio_totals['equity'], 2),
        'total_open_margin': round(portfolio_totals['margin'], 2),
        'total_unrealised_pnl': round(portfolio_totals['profit'], 2),
        'account_count': account_count,
        'vps_count': len(per_vps),
        'currency': currency,
    },
    'real_portfolio': real_portfolio,
    'accounts': accounts,
    'bots': bots,
    'open_positions': positions,
    'top_bot': bots[0] if bots else None,
    'errors': errors,
}

with open(tmp_path, 'w') as f:
    json.dump(snapshot, f, ensure_ascii=False, indent=2)
os.replace(tmp_path, out_path)

# Append per-account rows to history.jsonl for time series sparklines
with open(history_path, 'a') as hf:
    for a in accounts:
        hf.write(json.dumps({
            'ts': ts,
            'vps': a.get('vps'),
            'login': a.get('login'),
            'balance': a.get('balance'),
            'equity': a.get('equity'),
            'floating': a.get('profit'),
            'is_real': a.get('is_real', False),
        }, ensure_ascii=False) + '\n')

print(f"merge OK vps={len(per_vps)} accounts={len(accounts)} bots={len(bots)} positions={len(positions)} real={len(real_accounts)} errors={len(errors)} stale={sorted(stale_vps)}")
PY
RC=$?

if [ $RC -eq 0 ]; then
  echo "[$(ts)] mirror merge OK" >> "$LOG"
else
  echo "[$(ts)] mirror merge FAIL rc=$RC" >> "$LOG"
  exit $RC
fi

# Build manifest of available per-bot files (used by the dashboard audit modal)
python3 - "$BOTS_OUT_DIR" >> "$LOG" 2>&1 <<'PY'
import json, os, sys
root = sys.argv[1]
manifest = {"generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z", "bots": {}}
if os.path.isdir(root):
    for vps in sorted(os.listdir(root)):
        vps_path = os.path.join(root, vps)
        if not os.path.isdir(vps_path) or vps.startswith('.'):
            continue
        for f in os.listdir(vps_path):
            if not f.endswith('.json') or f == '_manifest.json':
                continue
            stem = f[:-5]
            if '-' not in stem:
                continue
            login, magic = stem.split('-', 1)
            manifest["bots"][f"{vps}-{login}-{magic}"] = {
                "vps": vps, "login": int(login), "magic": int(magic),
                "path": f"data/bots/{vps}/{f}",
            }
with open(os.path.join(root, '_manifest.json'), 'w') as f:
    json.dump(manifest, f, separators=(',', ':'))
print(f"manifest OK bots={len(manifest['bots'])}")
PY

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Reconcile snapshot.bots[] with per-bot files (truth source). Fixes drift
# when a VPS builder wrote snapshot.json while still updating per-bot files.
# Fail-closed: if reconcile breaks, snapshot.bots[] would lag per-bot files
# and the dashboard would serve mismatched aggregates — abort the cycle.
if ! python3 "$SCRIPT_DIR/reconcile_snapshot.py" >> "$LOG" 2>&1; then
  echo "[$(ts)] reconcile FAIL — aborting cycle (snapshot.bots[] may lag per-bot files)" >> "$LOG"
  exit 3
fi

# Post-merge enrichment: Promotion Score + correlation matrix + portfolio.
# Fail-closed: if this breaks, scores/correlations/portfolio.json go stale and
# the dashboard would mix fresh raw data with old derived data — abort.
if ! python3 "$SCRIPT_DIR/post_merge.py" "$DATA_DIR" >> "$LOG" 2>&1; then
  echo "[$(ts)] post_merge FAIL — aborting cycle (promotion scores and correlations stale)" >> "$LOG"
  exit 3
fi

# Data Integrity DNA — verify EVERY bot has its per-bot file and stats match
# BEFORE uploading. If integrity fails, abort so we never ship bad data to
# the dashboard. Generates data/integrity_report.json (uploaded next).
VERIFY_RC=0
python3 "$SCRIPT_DIR/verify_integrity.py" --strict >> "$LOG" 2>&1 || VERIFY_RC=$?
if [ $VERIFY_RC -ne 0 ]; then
  echo "[$(ts)] verify_integrity FAIL rc=$VERIFY_RC — see data/integrity_report.json (NOT uploading)" >> "$LOG"
  exit $VERIFY_RC
fi

# Push fresh data/ (including the just-generated integrity_report.json) to
# Supabase Storage. Pending-retry on transient failures.
UPLOAD_RC=0
python3 "$SCRIPT_DIR/upload_to_supabase.py" >> "$LOG" 2>&1 || UPLOAD_RC=$?
if [ $UPLOAD_RC -ne 0 ]; then
  echo "[$(ts)] supabase upload FAIL rc=$UPLOAD_RC — public dashboard data may be stale" >> "$LOG"
  exit $UPLOAD_RC
fi
echo "[$(ts)] mirror cycle OK — verified + uploaded" >> "$LOG"
