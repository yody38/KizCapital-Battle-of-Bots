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
BOTS_OUT_DIR="$DATA_DIR/bots"

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
declare -a STALE_VPS=()

{
  echo "[$(ts)] mirror starting"
  for entry in "${VPS_ENTRIES[@]}"; do
    id="${entry%%=*}"
    host="${entry#*=}"
    local_file="$DATA_DIR/snapshot_${id}.json"
    local_tmp="${local_file}.tmp"
    if scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 \
        "$host:$REMOTE_FILE" "$local_tmp" 2>&1; then
      if [ -s "$local_tmp" ] && head -c 1 "$local_tmp" | grep -q '{'; then
        mv "$local_tmp" "$local_file"
        echo "[$(ts)] $id OK $(wc -c < "$local_file") bytes"
        FRESH_FILES+=("$id:$local_file")
      else
        echo "[$(ts)] $id INVALID JSON — keeping previous cache"
        rm -f "$local_tmp"
        if [ -f "$local_file" ]; then FRESH_FILES+=("$id:$local_file"); STALE_VPS+=("$id"); else STALE_VPS+=("$id"); fi
      fi
    else
      echo "[$(ts)] $id SCP FAIL — keeping previous cache"
      rm -f "$local_tmp"
      if [ -f "$local_file" ]; then FRESH_FILES+=("$id:$local_file"); STALE_VPS+=("$id"); else STALE_VPS+=("$id"); fi
    fi
    # Per-bot full-history files: replace whole vps subfolder atomically
    bots_target="$BOTS_OUT_DIR/$id"
    bots_staging="$BOTS_OUT_DIR/.${id}.staging"
    rm -rf "$bots_staging"
    mkdir -p "$bots_staging"
    if scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=60 \
        -r "$host:$REMOTE_BOTS_DIR/." "$bots_staging/" 2>&1; then
      # Atomic swap: ensures dashboard NEVER hits a 404 window during refresh.
      bots_backup="${bots_target}.swap.$$"
      rm -rf "$bots_backup"
      if [ -d "$bots_target" ]; then mv "$bots_target" "$bots_backup"; fi
      mv "$bots_staging" "$bots_target"
      rm -rf "$bots_backup"
      bot_count=$(find "$bots_target" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
      echo "[$(ts)] $id bots OK $bot_count files (atomic swap)"
    else
      echo "[$(ts)] $id bots SCP FAIL — keeping previous bot cache"
      rm -rf "$bots_staging"
    fi
  done
} >> "$LOG" 2>&1

if [ ${#FRESH_FILES[@]} -eq 0 ]; then
  echo "[$(ts)] mirror FAIL — no usable snapshots" >> "$LOG"
  exit 1
fi

# Merge via python (vanilla, no deps).
STALE_ARG=$(IFS=,; echo "${STALE_VPS[*]:-}")

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
python3 "$SCRIPT_DIR/reconcile_snapshot.py" >> "$LOG" 2>&1 || \
  echo "[$(ts)] reconcile FAIL — snapshot.bots may lag per-bot files" >> "$LOG"

# Post-merge enrichment: Promotion Score + correlation matrix
python3 "$SCRIPT_DIR/post_merge.py" "$DATA_DIR" >> "$LOG" 2>&1 || \
  echo "[$(ts)] post_merge FAIL — promotion scores and correlations may be stale" >> "$LOG"

# Push fresh data/ to Supabase Storage (so the public Vercel dashboard sees it).
# Uses .env.local credentials. Pending-retry on transient failures.
UPLOAD_RC=0
python3 "$SCRIPT_DIR/upload_to_supabase.py" >> "$LOG" 2>&1 || UPLOAD_RC=$?
if [ $UPLOAD_RC -ne 0 ]; then
  echo "[$(ts)] supabase upload FAIL rc=$UPLOAD_RC — public dashboard data may be stale" >> "$LOG"
fi

# Data Integrity DNA — verify EVERY bot has its per-bot file and stats match.
# --strict aborts here (exit 2) if any check fails, so CI surfaces the problem
# instead of silently shipping bad data to the dashboard.
VERIFY_RC=0
python3 "$SCRIPT_DIR/verify_integrity.py" --strict >> "$LOG" 2>&1 || VERIFY_RC=$?
if [ $VERIFY_RC -ne 0 ]; then
  echo "[$(ts)] verify_integrity FAIL rc=$VERIFY_RC — see data/integrity_report.json" >> "$LOG"
  exit $VERIFY_RC
fi
echo "[$(ts)] mirror cycle OK — data integrity verified" >> "$LOG"
