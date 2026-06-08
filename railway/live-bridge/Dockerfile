# Kiz Capital LLC · Battle of Bots — live-bridge worker (Railway)
#
# Always-on container that holds a Tailscale (userspace) connection to VPS5 and
# keeps an SSH NetworkCleartext session open running live_publisher.py in loop
# mode. This is the only context where mt5.initialize() does NOT hang when the
# VPS RDP session is disconnected (see memory [vps-disconnected-rdp-mt5-hang]).
#
# Tailscale binaries are copied from the official image (no curl|sh).

FROM tailscale/tailscale:stable AS ts

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ts /usr/local/bin/tailscale  /usr/local/bin/tailscale
COPY --from=ts /usr/local/bin/tailscaled /usr/local/bin/tailscaled

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
 && mkdir -p /var/run/tailscale /var/lib/tailscale /root/.ssh

ENTRYPOINT ["/entrypoint.sh"]
