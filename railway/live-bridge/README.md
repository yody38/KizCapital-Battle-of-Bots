# live-bridge — Railway worker (live equity stream, real accounts)

Always-on container that keeps the 2 real accounts (#25425, #32081 on VPS5)
streaming to Supabase `public.live_real_state` every ~3s. The dashboard
subscribes via Supabase Realtime and patches the real-account cards in place.

## Why this exists

`live_publisher.py` (the MetaTrader5 reader) **must run on VPS5** — the MT5
Python lib only talks to the local terminal. Under Windows Task Scheduler
`mt5.initialize()` hangs when the RDP session is disconnected
(`[vps-disconnected-rdp-mt5-hang]`); the only context that works is an SSH
**NetworkCleartext** session. This worker is the always-on holder of that SSH
session: it dials VPS5 over Tailscale (userspace) and runs
`live_publisher.py --loop --interval 3`, reconnecting forever.

## Deploy

1. Create a Railway service from this repo, **Root Directory** =
   `Battle of Bots/railway/live-bridge` (Dockerfile builder, auto-detected).
2. Set service variables (Railway → Variables) — **never commit these**:

   | Var | Value |
   |---|---|
   | `SSH_PRIVATE_KEY` | CI ed25519 private key (the one authorized on the VPS, = GH secret `SSH_PRIVATE_KEY`) |
   | `TS_AUTHKEY` | Tailscale **ephemeral + reusable** authkey, tag `tag:ci` |
   | `VPS5_HOST` | `100.70.228.19` (optional, this is the default) |
   | `LIVE_INTERVAL_SECS` | `3` (optional, default 3) |

3. Deploy. The container brings up Tailscale, then opens the SSH loop.

## Verify

- **Railway logs** should show `published 2 rows (logins=25425,32081 ...)` every ~3s.
- **Supabase**: `select login, balance, equity, profit, extract(epoch from (now()-ts)) age_s from live_real_state;` → `age_s < 8`.
- **Dashboard**: pill `🟢 live · N s` (green, N<8) on the Cuentas Reales header.

## Notes

- The VPS-side `live_publisher.py` reads `C:\mt5-mcp\.live_publisher.env`
  (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`, ACL-locked) and pushes directly to
  Supabase — the service_role key never touches Railway.
- If Railway / the tunnel drops, the dashboard pill goes amber→red and real
  accounts fall back to the 30-min snapshot until the worker reconnects.
