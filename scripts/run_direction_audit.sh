#!/usr/bin/env bash
# run_direction_audit.sh — orchestrate the independent trade-direction audit.
#
# Direction (BUY/SELL) of a CLOSED trade is immutable once closed, so this is a
# periodic / event-triggered assurance check (run after snapshot_builder.py
# changes, or on demand) — NOT a high-frequency gate.
#
# Steps:
#   1. scp audit_direction.py to each VPS, run it (OPENBLAS_NUM_THREADS=1 to keep
#      low-RAM VPS2/VPS3/VPS6 from OOMing), collect audit_<vps>.json.
#   2. Run verify_trade_direction.py to compare each per-bot file's side against
#      the independently re-derived MT5 direction (+ orthogonal price check).
#
# If a low-RAM VPS still OOMs (Python can't even import numpy), its resident MCP
# server is the fallback: pull get_history per account and derive side from
# entry==0 deals (see the manual MCP path / a subagent). The comparator's
# coverage gate (exit 2) will flag any VPS that produced no ground truth.
set -u
cd "$(dirname "$0")/.." || exit 1
KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
AUDIT_DIR=data/_audit
mkdir -p "$AUDIT_DIR"

declare -a NAMES=(vps1 vps2 vps3 vps4 vps5 vps6)
declare -a IPS=(100.81.54.93 100.101.9.46 100.118.159.44 100.125.237.26 100.70.228.19 100.112.112.115)

run_one() {
  local v=$1 ip=$2
  scp -i "$KEY" -o ConnectTimeout=15 scripts/audit_direction.py "trader@$ip:C:/mt5-mcp/audit_direction.py" >/dev/null 2>&1 \
    && ssh -i "$KEY" -o ConnectTimeout=25 "trader@$ip" \
       'cmd /c "set OPENBLAS_NUM_THREADS=1&& set OMP_NUM_THREADS=1&& C:\mt5-mcp\venv\Scripts\python.exe C:\mt5-mcp\audit_direction.py"' \
       > "$AUDIT_DIR/audit_$v.json" 2>"$AUDIT_DIR/err_$v.txt"
  local sz; sz=$(wc -c < "$AUDIT_DIR/audit_$v.json")
  echo "$v: ${sz} bytes$([ "$sz" -lt 100 ] && echo '  <-- OOM/failed; use MCP fallback')"
}

for i in "${!NAMES[@]}"; do run_one "${NAMES[$i]}" "${IPS[$i]}" & done
wait

python3 scripts/verify_trade_direction.py \
  --audit-dir "$AUDIT_DIR" --bots-dir data/bots --out data/trade_direction_audit.json
echo "report: data/trade_direction_audit.json (exit $?)"
