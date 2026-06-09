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

# Shared scp options: ServerAlive keeps the transfer from hanging when the link
# stalls. ControlMaster muxes the 3 transfers per VPS (snapshot + .ready + bots)
# over ONE TCP+auth session → ~3x fewer sshd forks (the exact resource that a
# RAM-starved VPS runs out of) and lower latency. -C compresses the per-bot JSON.
SCP_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
          -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
          -C -o ControlMaster=auto -o "ControlPath=/tmp/cm-%r@%h:%p" -o ControlPersist=60)

# VPS roster (format "id=host"). Add entries here to scale.
VPS_ENTRIES=(
  "vps1=trader@100.81.54.93"
  "vps2=trader@100.101.9.46"
  "vps3=trader@100.118.159.44"
  "vps4=trader@100.125.237.26"
  "vps5=trader@100.70.228.19"
  "vps6=trader@100.112.112.115"
)

mkdir -p "$DATA_DIR" "$BOTS_OUT_DIR"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
now_ms() { date -u +%s%3N; }   # epoch milliseconds (GNU date; CI runs on ubuntu)

# Per-stage wall-clock telemetry (Feature: pipeline latency). Captured here in the
# orchestrator; emitted to pipeline_timing.json at the very end so a single source
# owns the numbers. The file ships next cycle — a 30-min lag on a perf chart is fine.
PIPE_START_MS=$(now_ms)
T_MIRROR_MS=0; T_RECONCILE_MS=0; T_FETCH_LEDGER_MS=0
T_POSTMERGE_MS=0; T_VERIFY_MS=0; T_UPLOAD_MS=0

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

# Per-VPS fetch — runs in a background subshell, one per VPS. All output goes to
# the VPS's own log (concatenated in roster order after the barrier, so logs never
# interleave and no secret could be spliced mid-line). The RESULT is communicated
# via an atomic status file ($DATA_DIR/.vps_status_<id>):
#   OK:<snapshot_path>   -> this VPS mirrored cleanly
#   FAIL:<reason>        -> fail-closed; the whole cycle aborts
# A subshell that crashes WITHOUT writing a status file is treated as FAIL (the
# parent only trusts an explicit OK) — fail-closed by construction.
fetch_vps() {
  local id="$1" host="$2"
  local status_file="$DATA_DIR/.vps_status_${id}"
  rm -f "$status_file"
  local local_file="$DATA_DIR/snapshot_${id}.json"
  local local_tmp="${local_file}.tmp"
  local attempt snap_scp_ok age expected_bots
  local ready_local snap_ts ready_valid ready_ts ready_bots
  local bots_target bots_staging bots_attempt_ok staged bots_backup bot_count
  local sampler_dir sampler_f

  fail() { echo "FAIL:$1" > "${status_file}.tmp" && mv "${status_file}.tmp" "$status_file"; return 1; }

  # --- snapshot.json fetch (mandatory, fail-closed with retry) ---
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
    [ "$attempt" -lt "$BOTS_SCP_MAX_ATTEMPTS" ] && sleep "$BOTS_SCP_RETRY_DELAY_SEC"
  done
  if [ "$snap_scp_ok" -ne 1 ]; then
    echo "[$(ts)] $id snapshot scp FAILED after $BOTS_SCP_MAX_ATTEMPTS attempts — aborting cycle (fail-closed)"
    rm -f "$local_tmp"; fail "${id}:snapshot_scp_exhausted"; return 1
  fi
  mv "$local_tmp" "$local_file"

  age=$(snapshot_age_sec "$local_file")
  if [ "$age" -lt 0 ] || [ "$age" -gt "$SNAPSHOT_MAX_AGE_SEC" ]; then
    echo "[$(ts)] $id snapshot.json STALE age=${age}s threshold=${SNAPSHOT_MAX_AGE_SEC}s — aborting cycle"
    fail "${id}:snapshot_stale_${age}s"; return 1
  fi
  echo "[$(ts)] $id OK $(wc -c < "$local_file") bytes age=${age}s"

  expected_bots=$(expected_bots_in_snapshot "$local_file")
  if [ "$expected_bots" -lt 0 ]; then
    echo "[$(ts)] $id could not parse expected bot count — aborting"
    fail "${id}:bots_count_parse"; return 1
  fi

  # --- .ready flag (builder v3+) ---
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
    fail "${id}:ready_missing_or_mismatch"; return 1
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
    [ "$attempt" -lt "$BOTS_SCP_MAX_ATTEMPTS" ] && sleep "$BOTS_SCP_RETRY_DELAY_SEC"
  done
  if [ "$bots_attempt_ok" -ne 1 ]; then
    echo "[$(ts)] $id bots scp FAILED after $BOTS_SCP_MAX_ATTEMPTS attempts — aborting cycle"
    rm -rf "$bots_staging"; fail "${id}:bots_scp_exhausted"; return 1
  fi

  # Atomic swap: ensures dashboard NEVER hits a 404 window during refresh.
  # Backup name keyed by $id (unique per VPS) so concurrent swaps never collide.
  bots_backup="${bots_target}.swap.${id}"
  rm -rf "$bots_backup"
  if [ -d "$bots_target" ]; then mv "$bots_target" "$bots_backup"; fi
  mv "$bots_staging" "$bots_target"
  rm -rf "$bots_backup"
  bot_count=$(find "$bots_target" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  echo "[$(ts)] $id bots OK $bot_count files (atomic swap, expected=$expected_bots)"

  # --- equity sampler artifacts (Fase A, tribunal 2026-06-09) ---
  # Fail-soft by design: the sampler rolls out VPS-by-VPS (canary first), so a
  # missing summary is normal, never aborts the cycle, and the raw series stays
  # on the VPS — only the KB-sized daily aggregates travel.
  sampler_dir="$DATA_DIR/sampler/$id"
  mkdir -p "$sampler_dir"
  for sampler_f in floating_dd_summary.json sampler_status.json; do
    if scp "${SCP_OPTS[@]}" "$host:C:/mt5-mcp/$sampler_f" "$sampler_dir/.${sampler_f}.tmp" 2>/dev/null \
       && [ -s "$sampler_dir/.${sampler_f}.tmp" ] && head -c 1 "$sampler_dir/.${sampler_f}.tmp" | grep -q '{'; then
      mv "$sampler_dir/.${sampler_f}.tmp" "$sampler_dir/$sampler_f"
      echo "[$(ts)] $id sampler $sampler_f OK ($(wc -c < "$sampler_dir/$sampler_f") bytes)"
    else
      rm -f "$sampler_dir/.${sampler_f}.tmp"
      echo "[$(ts)] $id sampler $sampler_f not present (fail-soft)"
    fi
  done
  echo "OK:$local_file" > "${status_file}.tmp" && mv "${status_file}.tmp" "$status_file"
  return 0
}

# Concurrency cap: VPS scp run in parallel but bounded. Keeps RAM/IO pressure
# (VPS2 1.5GB, VPS4 slow) sane while collapsing the serial 6× transport that
# telemetry proved is ~91% of the cycle. Throttle with `wait -n` (bash 4.3+).
MAX_PARALLEL=${MIRROR_MAX_PARALLEL:-3}
MIRROR_START_MS=$(now_ms)
echo "[$(ts)] mirror starting (parallel, cap=$MAX_PARALLEL)" >> "$LOG"

declare -a VPS_IDS=()
running=0
for entry in "${VPS_ENTRIES[@]}"; do
  id="${entry%%=*}"
  host="${entry#*=}"
  VPS_IDS+=("$id")
  set +x  # never trace inside the fetch subshell (defence against secret splicing)
  fetch_vps "$id" "$host" > "$DATA_DIR/.vps_log_${id}" 2>&1 &
  running=$((running + 1))
  if [ "$running" -ge "$MAX_PARALLEL" ]; then
    wait -n 2>/dev/null || true
    running=$((running - 1))
  fi
done
wait  # barrier: all VPS fetches complete before we read results

# Concatenate per-VPS logs in roster order (deterministic, no interleaving).
for id in "${VPS_IDS[@]}"; do
  [ -f "$DATA_DIR/.vps_log_${id}" ] && cat "$DATA_DIR/.vps_log_${id}" >> "$LOG"
  rm -f "$DATA_DIR/.vps_log_${id}"
done

# Read per-VPS status files (the only trusted result channel). Graceful
# degradation: a VPS that FAILs (or whose subshell crashed) is COLLECTED as
# stale rather than aborting the whole cycle — one flaky low-RAM VPS must not
# freeze the 5 healthy ones. Quorum below enforces the safety limits.
declare -a STALE_IDS=()
for id in "${VPS_IDS[@]}"; do
  status_file="$DATA_DIR/.vps_status_${id}"
  if [ ! -f "$status_file" ]; then
    echo "[$(ts)] $id no status (subshell crashed) — treating as stale" >> "$LOG"
    STALE_IDS+=("$id")
    continue
  fi
  st="$(cat "$status_file")"
  rm -f "$status_file"
  case "$st" in
    OK:*) FRESH_FILES+=("$id:${st#OK:}") ;;
    *)    echo "[$(ts)] $id FAIL (${st#FAIL:}) — treating as stale" >> "$LOG"; STALE_IDS+=("${id}") ;;
  esac
done

# --- Quorum (fail-closed safety limits) ---
MAX_STALE_VPS=${MAX_STALE_VPS:-1}     # at most this many VPS may be carried stale
REQUIRED_VPS="${REQUIRED_VPS:-vps5}"  # the REAL-money VPS must always be fresh
if [ ${#STALE_IDS[@]} -gt "$MAX_STALE_VPS" ]; then
  echo "[$(ts)] mirror FAIL — ${#STALE_IDS[@]} VPS down (> MAX_STALE_VPS=$MAX_STALE_VPS): ${STALE_IDS[*]} (no upload)" >> "$LOG"
  exit 1
fi
for sid in "${STALE_IDS[@]}"; do
  if [ "$sid" = "$REQUIRED_VPS" ]; then
    echo "[$(ts)] mirror FAIL — required VPS $REQUIRED_VPS (real accounts) is down — not degrading (no upload)" >> "$LOG"
    exit 1
  fi
done

# --- Carry forward each stale VPS from last-good Supabase data ---
# Keeps its accounts/bots visible (flagged stale) so no bot vanishes and
# verify_integrity still passes. If carry-forward fails, we fail closed.
for sid in "${STALE_IDS[@]}"; do
  if python3 "$DIR/scripts/carry_forward_stale.py" "$sid" "$DATA_DIR" >> "$LOG" 2>&1; then
    FRESH_FILES+=("$sid:$DATA_DIR/snapshot_${sid}.json")
  else
    echo "[$(ts)] mirror FAIL — carry-forward of $sid failed (cannot safely degrade, no upload)" >> "$LOG"
    exit 1
  fi
done

if [ ${#FRESH_FILES[@]} -ne ${#VPS_ENTRIES[@]} ]; then
  echo "[$(ts)] mirror FAIL — got ${#FRESH_FILES[@]} VPS (fresh+carried), expected ${#VPS_ENTRIES[@]}" >> "$LOG"
  exit 1
fi

# Stale set flows to the merge → snapshot.stale_vps → dashboard ⚠ per-VPS.
STALE_ARG="$(IFS=,; echo "${STALE_IDS[*]}")"
if [ -n "$STALE_ARG" ]; then
  echo "[$(ts)] mirror DEGRADED — publishing with stale VPS: $STALE_ARG" >> "$LOG"
fi

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
T_MIRROR_MS=$(( $(now_ms) - MIRROR_START_MS ))   # scp(6 VPS) + merge

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
_t0=$(now_ms)
if ! python3 "$SCRIPT_DIR/reconcile_snapshot.py" >> "$LOG" 2>&1; then
  echo "[$(ts)] reconcile FAIL — aborting cycle (snapshot.bots[] may lag per-bot files)" >> "$LOG"
  exit 3
fi
T_RECONCILE_MS=$(( $(now_ms) - _t0 ))

# Pull the append-only forward-tracker ledger from Supabase BEFORE post_merge so it
# appends to the real history. The CI runner starts without it (data/ is gitignored,
# not mirrored), so otherwise post_merge rebuilt it empty and the upload clobbered
# the deployed history every cycle. Fail-closed: abort if the fetch errors.
_t0=$(now_ms)
if ! python3 "$SCRIPT_DIR/fetch_ledger.py" >> "$LOG" 2>&1; then
  echo "[$(ts)] fetch_ledger FAIL — aborting cycle (would clobber tracker history)" >> "$LOG"
  exit 3
fi
T_FETCH_LEDGER_MS=$(( $(now_ms) - _t0 ))

# Post-merge enrichment: Promotion Score + correlation matrix + portfolio.
# Fail-closed: if this breaks, scores/correlations/portfolio.json go stale and
# the dashboard would mix fresh raw data with old derived data — abort.
_t0=$(now_ms)
if ! python3 "$SCRIPT_DIR/post_merge.py" "$DATA_DIR" >> "$LOG" 2>&1; then
  echo "[$(ts)] post_merge FAIL — aborting cycle (promotion scores and correlations stale)" >> "$LOG"
  exit 3
fi
T_POSTMERGE_MS=$(( $(now_ms) - _t0 ))

# Data Integrity DNA — verify EVERY bot has its per-bot file and stats match
# BEFORE uploading. If integrity fails, abort so we never ship bad data to
# the dashboard. Generates data/integrity_report.json (uploaded next).
_t0=$(now_ms)
VERIFY_RC=0
python3 "$SCRIPT_DIR/verify_integrity.py" --strict >> "$LOG" 2>&1 || VERIFY_RC=$?
if [ $VERIFY_RC -ne 0 ]; then
  echo "[$(ts)] verify_integrity FAIL rc=$VERIFY_RC — see data/integrity_report.json (NOT uploading)" >> "$LOG"
  exit $VERIFY_RC
fi
T_VERIFY_MS=$(( $(now_ms) - _t0 ))

# Emit per-stage latency telemetry BEFORE upload so pipeline_timing.json +
# pipeline_timing_history.jsonl are part of the upload set (the CI runner is
# ephemeral — anything written after upload is lost). upload_ms is unknown here
# (~3s, trivial); upload_to_supabase.py patches the live file's upload_ms and
# end_to_end_ms after it measures itself, then re-uploads it. Best-effort:
# a telemetry failure must NEVER fail a healthy cycle.
T_E2E_MS=$(( $(now_ms) - PIPE_START_MS ))   # pre-upload; upload patches the final value
T_MIRROR_MS="$T_MIRROR_MS" T_RECONCILE_MS="$T_RECONCILE_MS" \
T_FETCH_LEDGER_MS="$T_FETCH_LEDGER_MS" T_POSTMERGE_MS="$T_POSTMERGE_MS" \
T_VERIFY_MS="$T_VERIFY_MS" T_UPLOAD_MS="0" T_E2E_MS="$T_E2E_MS" \
  python3 "$SCRIPT_DIR/emit_timing.py" >> "$LOG" 2>&1 || \
  echo "[$(ts)] emit_timing non-fatal error (timing skipped this cycle)" >> "$LOG"

# Push fresh data/ (including integrity_report.json + pipeline_timing.json) to
# Supabase Storage. Pending-retry on transient failures.
UPLOAD_RC=0
python3 "$SCRIPT_DIR/upload_to_supabase.py" >> "$LOG" 2>&1 || UPLOAD_RC=$?
if [ $UPLOAD_RC -ne 0 ]; then
  echo "[$(ts)] supabase upload FAIL rc=$UPLOAD_RC — public dashboard data may be stale" >> "$LOG"
  exit $UPLOAD_RC
fi
echo "[$(ts)] mirror cycle OK — verified + uploaded" >> "$LOG"
