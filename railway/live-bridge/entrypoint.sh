#!/usr/bin/env bash
# Kiz Capital LLC · Battle of Bots — live-bridge supervisor.
#
# 1. Bring up Tailscale in userspace networking mode (ephemeral, tag:ci).
# 2. Hold an SSH session to the target VPS running live_publisher.py --loop.
# 3. Reconnect forever if the session or the tailnet drops.
#
# One service per VPS with real accounts (kiz-live-bridge → VPS3,
# kiz-live-bridge-vps6 → VPS6); same image, different VPS_HOST/VPS_LABEL.
#
# Required env (set ONLY in Railway, never committed):
#   SSH_PRIVATE_KEY_B64  CI ed25519 private key, base64-encoded (preferred —
#                        survives single-line env storage); OR
#   SSH_PRIVATE_KEY      the raw multiline key (fallback)
#   TS_AUTHKEY           Tailscale ephemeral reusable authkey (tag:ci)
# Optional:
#   VPS_HOST           Tailscale IP of the target VPS (default 100.70.228.19 =
#                      VPS3; legacy VPS5_HOST sigue honrado — es el nombre real
#                      de la variable en Railway, que no se renombro)
#   VPS_LABEL          hostname tag for the tailnet node (default kiz-live-bridge)
#   LIVE_INTERVAL_SECS default 3
set -u

# VPS3_HOST es el nombre nuevo (numeracion del owner desde 2026-07-27). VPS5_HOST
# es el nombre LEGACY y sigue siendo el que existe en Railway: la variable no se
# renombro alli, asi que hay que seguir honrandola o el bridge pierde su destino.
# Misma maquina en los tres casos: 100.70.228.19 (vps3 en config/vps_registry.json).
VPS_HOST="${VPS_HOST:-${VPS3_HOST:-${VPS5_HOST:-100.70.228.19}}}"
VPS_LABEL="${VPS_LABEL:-kiz-live-bridge}"
INTERVAL="${LIVE_INTERVAL_SECS:-3}"
PY='C:\mt5-mcp\venv\Scripts\python.exe'
SCRIPT='C:\mt5-mcp\live_publisher.py'

# --- SSH key + config ----------------------------------------------------
mkdir -p /root/.ssh
if [ -n "${SSH_PRIVATE_KEY_B64:-}" ]; then
  printf '%s' "$SSH_PRIVATE_KEY_B64" | base64 -d > /root/.ssh/id_ed25519
else
  printf '%s\n' "${SSH_PRIVATE_KEY:-}" > /root/.ssh/id_ed25519
fi
chmod 600 /root/.ssh/id_ed25519
# Pinned host key (baked at build via ssh-keyscan) — no TOFU/accept-new window.
cp /etc/kiz_known_hosts /root/.ssh/known_hosts 2>/dev/null || true
chmod 644 /root/.ssh/known_hosts 2>/dev/null || true
cat > /root/.ssh/config <<EOF
Host target
  HostName ${VPS_HOST}
  User trader
  IdentityFile /root/.ssh/id_ed25519
  UserKnownHostsFile /root/.ssh/known_hosts
  StrictHostKeyChecking yes
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
tailscale up --authkey="${TS_AUTHKEY}" --hostname="${VPS_LABEL}" \
  --advertise-tags=tag:ci --accept-routes
until tailscale status >/dev/null 2>&1; do
  echo "[live-bridge] waiting for tailnet ..."
  sleep 1
done
echo "[live-bridge] tailnet ready"

# --- Supervisor loop -----------------------------------------------------
trap 'echo "[live-bridge] shutting down"; tailscale logout >/dev/null 2>&1 || true; exit 0' TERM INT

while true; do
  echo "[live-bridge] $(date -u +%H:%M:%S) connecting to ${VPS_HOST} (interval=${INTERVAL}s)"
  ssh target "${PY} ${SCRIPT} --loop --interval ${INTERVAL}" || true
  echo "[live-bridge] session ended; reconnecting in 5s"
  sleep 5
done
