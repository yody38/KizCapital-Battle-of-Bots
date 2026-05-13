# ⚔️ Battle of Bots

Dashboard HTML interactivo para rankear los EAs (bots por `magic number`) de las 10 cuentas MT5 del VPS. **Actualización 100% autónoma cada hora en punto.**

## Ubicación real
- **Runtime**: `~/battle-of-bots/` (esta carpeta).
- **Acceso desde el proyecto MT5 MCP**: `/Users/yodyiznaga/Documents/Claude/MT5 MCP/Battle of Bots/` es un **symlink** a esta carpeta. VS Code la ve dentro del workspace.
- **Por qué no Documents/**: macOS TCC bloquea LaunchAgents de leer `~/Documents/`. Se movió aquí para autonomía total.

## Arquitectura autónoma

```
VPS Windows (siempre encendido)
  └── Task Scheduler "BattleOfBots_Snapshot" — cada XX:00 UTC, 24/7
        └── C:\mt5-mcp\run_snapshot.bat → snapshot_builder.py
              └── C:\mt5-mcp\snapshot.json (fuente de verdad)

Mac (LaunchAgents)
  ├── com.yoder.battleofbots — mirror cada XX:05 (scp VPS → local)
  └── com.yoder.battleofbots.server — http.server 8765 perpetuo

Navegador → http://127.0.0.1:8765
```

## Uso
**Ver dashboard**: `open http://127.0.0.1:8765` (el server siempre está corriendo).

## Estructura
```
~/battle-of-bots/
├── index.html
├── app.js
├── styles.css
├── scripts/
│   ├── mirror.sh                              # fetcher horario (launchd)
│   ├── snapshot.sh                            # fallback manual (end-to-end)
│   ├── com.yoder.battleofbots.plist           # agent mirror
│   └── com.yoder.battleofbots.server.plist    # agent HTTP
├── data/
│   ├── snapshot.json                          # espejo del VPS
│   ├── mirror.log
│   ├── server.stdout.log / server.stderr.log
│   └── launchd.stdout.log / launchd.stderr.log
└── README.md
```

## Operación

### Verificar estado
```bash
launchctl list | grep battleofbots
lsof -i :8765 -sTCP:LISTEN
tail -3 ~/battle-of-bots/data/mirror.log
ssh -i ~/.ssh/id_ed25519 trader@100.81.54.93 'schtasks /Query /TN BattleOfBots_Snapshot /V /FO LIST' | grep -E "Last Run|Last Result|Next Run"
```

### Forzar disparo inmediato
```bash
# Mirror (Mac)
launchctl kickstart -k gui/$(id -u)/com.yoder.battleofbots

# Snapshot (VPS)
ssh -i ~/.ssh/id_ed25519 trader@100.81.54.93 'schtasks /Run /TN BattleOfBots_Snapshot'
```

### Pausar / reanudar
```bash
# Pausar mirror Mac (VPS sigue generando)
launchctl unload ~/Library/LaunchAgents/com.yoder.battleofbots.plist
# Reanudar
launchctl load ~/Library/LaunchAgents/com.yoder.battleofbots.plist

# Pausar / reanudar generación en VPS
ssh -i ~/.ssh/id_ed25519 trader@100.81.54.93 'schtasks /Change /TN BattleOfBots_Snapshot /DISABLE'
ssh -i ~/.ssh/id_ed25519 trader@100.81.54.93 'schtasks /Change /TN BattleOfBots_Snapshot /ENABLE'
```

## Integridad de datos
- Fuente: API oficial `MetaTrader5` de Python, attach directo al `terminal64.exe` del broker.
- `history_deals_get()` filtrado a `entry in (1, 3)` (cierres reales) con `profit + commission + swap` netos.
- `errors[]` en JSON reporta cualquier cuenta que falle — nunca se silencia.
- Bitácora triple: VPS (`C:\mt5-mcp\snapshot.log`), Mac (`data/mirror.log`), launchd (`data/launchd.*.log`).

## Criterio de ranking
Net Profit USD en 365 días. Ordenado descendente. `top_bot = bots[0]`.
