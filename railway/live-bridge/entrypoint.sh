#!/usr/bin/env bash
# Kiz Capital LLC · Battle of Bots — live-bridge supervisor.
#
# 1. Bring up Tailscale in userspace networking mode (ephemeral, tag:ci).
# 2. Hold an SSH session to VPS5 running live_publisher.py --loop.
# 3. Reconnect forever if the session or the tailnet drops.
#
# Required env (set ONLY in Railway, never committed):
#   SSH_PRIVATE_KEY    CI ed25519 private key (authorized on VPS5)
#   TS_AUTHKEY         Tailscale ephemeral reusable authkey (tag:ci)
# Optional:
#   VPS5_HOST          default 100.70.228.19
#   LIVE_INTERVAL_SECS default 3
set -u

VPS5_HOST="${VPS5_HOST:-100.70.228.19}"
INTERVAL="${LIVE_INTERVAL_SECS:-3}"
PY='C:\mt5-mcp\venv\Scripts\python.exe'
SCRIPT='C:\mt5-mcp\live_publisher.py'

# --- SSH key + config ----------------------------------------------------
mkdir -p /root/.ssh
printf '%s\n' "$SSH_PRIVATE_KEY" > /root/.ssh/id_ed25519
chmod 600 /root/.ssh/id_ed25519
cat > /root/.ssh/config <<EOF
Host vps5
  HostName ${VPS5_HOST}
  User trader
  IdentityFile /root/.ssh/id_ed25519
  StrictHostKeyChecking accept-new
  ServerAliveInterval 15
  ServerAliveCountMax 3
  ConnectTimeout 20
  ProxyCommand tailscale nc %h %p
EOF
chmod 600 /root/.ssh/config

# --- Tailscale (userspace) ----------------------------------------------
echo "[live-bridge] starting tailscaled (userspace)"
tailscaled --tun=userspace-networking \
  --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock &
sleep 2

echo "[live-bridge] tailscale up"
# TS_AUTHKEY may be a pre-tagged ephemeral authkey OR a tag:ci OAuth client
# secret; --advertise-tags is required for the latter and harmless (must match)
# for the former.
tailscale up --authkey="${TS_AUTHKEY}" --hostname=kiz-live-bridge \
  --advertise-tags=tag:ci --accept-routes
until tailscale status >/dev/null 2>&1; do
  echo "[live-bridge] waiting for tailnet ..."
  sleep 1
done
echo "[live-bridge] tailnet ready"

# --- Supervisor loop -----------------------------------------------------
trap 'echo "[live-bridge] shutting down"; tailscale logout >/dev/null 2>&1 || true; exit 0' TERM INT

while true; do
  echo "[live-bridge] $(date -u +%H:%M:%S) connecting to ${VPS5_HOST} (interval=${INTERVAL}s)"
  ssh vps5 "${PY} ${SCRIPT} --loop --interval ${INTERVAL}" || true
  echo "[live-bridge] session ended; reconnecting in 5s"
  sleep 5
done
