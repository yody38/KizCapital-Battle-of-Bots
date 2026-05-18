# Hardening Setup — Battle of Bots Sync Reliability

Tres pasos manuales del usuario para activar la red de seguridad out-of-band.
Una sola vez. Después es 100% automático.

---

## PASO 0 — Liquidar saldo viejo de GH Actions (solo si lo hay)

El repo ya es **público** desde 2026-05-17 → GitHub Actions sobre runners
Linux es **gratis ilimitado** para repos públicos. Pero hay una sutileza:
si la cuenta tuvo facturas previas pendientes (era el caso aquí — billing
falló antes de hacer el repo público), GitHub bloquea TODOS los workflows
hasta que ese saldo se liquide.

1. Abrir: https://github.com/settings/billing
2. Si ves saldo pendiente o "payment failed" → liquidarlo (suele ser pequeño:
   son los minutos consumidos antes del primer bloqueo).
3. Si no ves nada pendiente → tu cuenta ya está limpia.
4. Verificar con:
   ```bash
   gh workflow run refresh-dashboard --repo yody38/KizCapital-Battle-of-Bots
   sleep 10 && gh run list --repo yody38/KizCapital-Battle-of-Bots --limit 1
   ```
   El último run debe quedar `queued`/`in_progress` (NO `failure` en 2s
   con "recent account payments have failed").

A partir de aquí: $0/mes forever. El `live-publisher-tick` (la pieza que
consumía 27× del free tier) fue eliminada — cuentas reales ahora se ven
actualizadas cada 30 min como demos, no en streaming de 5s.

---

## PASO 1 — Crear App Password de Gmail + guardarlo en macOS Keychain

Para que el heartbeat te envíe alertas por email cuando el pipeline se rompa
fuera de banda (sin depender de GH Actions).

1. Crear App Password:
   - https://myaccount.google.com/security
   - 2-Step Verification → App passwords → "Other (Custom name)" → `Mac Heartbeat`
   - Copiar las 16 letras sin espacios (ej: `abcd efgh ijkl mnop` → `abcdefghijklmnop`).

2. Guardarlo en macOS Keychain (reemplazar `<APPPASS>` con el valor real):
   ```bash
   security add-generic-password \
     -a yoderiznaga21@gmail.com \
     -s kizcapital-gmail-apppass \
     -w '<APPPASS>'
   ```
   Verificación:
   ```bash
   python3 'Battle of Bots/scripts/alert_email.py' --self-test
   ```
   Debes recibir un email "[Kiz Capital] alert_email.py self-test" en yoderiznaga21@gmail.com.

---

## PASO 2 — Cargar el LaunchAgent en la Mac (heartbeat cada 10 min)

```bash
launchctl load ~/Library/LaunchAgents/com.kizcapital.heartbeat.plist
launchctl list | grep kizcapital
```

A los 10 min deberías ver actividad en:
```bash
tail -5 'Battle of Bots/data/heartbeat_log.jsonl'
```

Líneas con `"result":"ok"` confirman que el heartbeat está corriendo.

---

## Cómo verificar que todo funciona end-to-end

```bash
# 1. Heartbeat dry-run real (no email):
python3 'Battle of Bots/scripts/heartbeat_check.py' --no-email

# 2. Simular un fail (envía email real si --no-email se omite):
python3 'Battle of Bots/scripts/heartbeat_check.py' --simulate-lag-min 70 --no-email

# 3. Ver el estado operativo en cualquier momento:
cat 'Battle of Bots/SYNC_STATUS.md'

# 4. Ver el historial de recuperaciones aprendidas:
cat 'Battle of Bots/RUNBOOK.md'

# 5. Forzar una recuperación manual:
python3 'Battle of Bots/scripts/dispatch_refresh.py' --reason manual
```

---

## Arquitectura defensiva (resumen)

| Capa | Componente | Frecuencia | Falla si... |
|------|------------|------------|-------------|
| 1 | Producción normal (VPS → GH Actions → Supabase → Vercel) | 30 min | billing, VPS down |
| 2 | integrity-watchdog en GH Actions (Issues automáticos) | 30 min | misma capa 1 |
| 3 | **heartbeat_check.py en Mac (NUEVO)** | 10 min | Mac apagada |
| 4 | **alert_email.py → yoderiznaga21@gmail.com (NUEVO)** | on-demand | Gmail App Pass rota |
| 5 | **dispatch_refresh.py — auto-recovery (NUEVO)** | on-fail | GH API down |
| 6 | **Banner staleness en dashboard (NUEVO)** | en cada carga | — |

Cada capa cubre el fallo de la anterior. Para que TODO se caiga simultáneamente
necesitarían fallar: Mac apagada + Gmail + GH API + Vercel cache. Probabilidad
~0 en operación normal.

---

## Mantenimiento

- **Logs** (no se commitean, viven en `data/`):
  - `data/heartbeat_log.jsonl` — todo tick del heartbeat
  - `data/dispatch_refresh_log.jsonl` — cada intento de auto-recovery
  - `data/learning_events.jsonl` — fuente del RUNBOOK
  - `data/.alert_state.json` — dedupe de emails (no editar a mano)
- **Detener heartbeat temporalmente**:
  `launchctl unload ~/Library/LaunchAgents/com.kizcapital.heartbeat.plist`
- **Si las alertas hacen spam**: bajar `WARN_LAG_MIN`/`FAIL_LAG_MIN` en
  `scripts/heartbeat_check.py`. Los dedupe windows ya evitan más de 1 email cada
  30 min (FAIL) o 60 min (WARN).
