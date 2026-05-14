# ⚔️ Kiz Capital LLC — Battle of Bots

Dashboard interactivo que rankea los EAs (bots por `magic number`) de **57 cuentas MT5 distribuidas en 5 VPS Windows**. **Actualización 100% always-on cada 30 min, independiente de la Mac del usuario.**

---

## Ubicación

- **Repo runtime**: `~/battle-of-bots/` (esta carpeta) y symlink en `/Users/yodyiznaga/Documents/Claude/MT5 MCP/Battle of Bots/`.
- **Repo GitHub**: `yody38/KizCapital-Battle-of-Bots` (privado).
- **Dashboard público**: desplegado en **Vercel** desde la rama `main`. Login con Supabase Auth (magic link 6-digit OTP).
- **Dashboard local opcional**: `http://127.0.0.1:8765` cuando la Mac está prendida (LaunchAgent del HTTP server sigue activo).

---

## Arquitectura (desde 2026-05-14)

```
VPS Windows × 5 (siempre encendidos · Tailscale 100.x.x.x)
  └── Task Scheduler "BattleOfBots_Snapshot" — cada XX:00 UTC, 24/7
        └── C:\mt5-mcp\venv\Scripts\python.exe snapshot_builder.py
              └── C:\mt5-mcp\snapshot.json + C:\mt5-mcp\bots\ (fuente de verdad)

GitHub Actions (runner Ubuntu · cron XX:10 y XX:40 UTC)
  └── .github/workflows/refresh.yml
        ├── Tailscale up (OAuth, tag:ci, ephemeral)
        ├── scripts/mirror.sh
        │     ├── scp snapshot.json + bots/ de cada VPS
        │     ├── merge inline → data/snapshot.json
        │     ├── scripts/post_merge.py (12 etapas)
        │     └── scripts/upload_to_supabase.py
        └── actions/cache: persiste data/.upload-manifest.json entre runs

Supabase Storage (bucket dashboard-data)
  └── snapshot.json + correlations.json + portfolio.json + bots/<vps>/*.json + ...

Vercel (deploy desde repo)
  └── index.html + app.js + data-source.js (rewrites data/* → signed URLs Supabase)
        └── Usuarios → login Supabase → dashboard
```

**Mac NO es punto de falla.** El LaunchAgent del mirror (`com.yoder.battleofbots.plist`) está desactivado vía `launchctl unload`. El plist sigue en disco como respaldo. El LaunchAgent del HTTP server local (`com.yoder.battleofbots.server.plist`) sigue activo solo para vista local opcional.

---

## Componentes clave del repo

```
~/battle-of-bots/
├── .github/workflows/refresh.yml          # GH Actions cron 30 min ⭐
├── index.html · app.js · styles.css       # dashboard estático (servido por Vercel)
├── login.html · login.js · login.css      # Supabase magic-link UI
├── auth-guard.js · supabase-client.js     # session + signed URL helper
├── data-source.js                          # rewrites data/* → Supabase signed URLs
├── vercel.json · .vercelignore             # config deploy Vercel
├── scripts/
│   ├── mirror.sh                           # multi-VPS scp + merge (invocado por GH Actions)
│   ├── post_merge.py                       # 12 etapas de enrichment
│   ├── upload_to_supabase.py               # sha256 manifest + audit re-upload
│   ├── snapshot.sh                         # fallback manual end-to-end
│   ├── com.yoder.battleofbots.plist        # LaunchAgent mirror Mac (DESACTIVADO)
│   └── com.yoder.battleofbots.server.plist # LaunchAgent HTTP local Mac (activo)
├── data/                                   # gitignored — vive en Supabase Storage
│   ├── snapshot.json · correlations.json · portfolio.json
│   ├── bots/<vps>/<login>-<magic>.json
│   ├── candidates_history.jsonl · history.jsonl
│   └── .upload-manifest.json               # cache GH Actions
└── .env.local                              # SUPABASE_URL + SERVICE_ROLE_KEY (gitignored)
```

---

## Operación

### Ver últimos runs de GitHub Actions
```bash
gh run list --workflow=refresh-dashboard --repo yody38/KizCapital-Battle-of-Bots --limit 5
```

### Disparar refresh manual
```bash
gh workflow run refresh-dashboard --repo yody38/KizCapital-Battle-of-Bots
```

### Ver logs de un run fallido + descargar mirror.log
```bash
gh run view <RUN_ID> --repo yody38/KizCapital-Battle-of-Bots --log-failed
gh run download <RUN_ID> --repo yody38/KizCapital-Battle-of-Bots
cat mirror-logs-<RUN_ID>/mirror.log
```

### Verificar frescura en Supabase Storage (último update)
```bash
cd ~/battle-of-bots && source .env.local
curl -s -X POST "$SUPABASE_URL/storage/v1/object/list/dashboard-data" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix":"","limit":3,"sortBy":{"column":"updated_at","order":"desc"}}' | jq
```

### Forzar snapshot upstream en una VPS (rare)
```bash
ssh -i ~/.ssh/id_ed25519 trader@100.81.54.93 'schtasks /Run /TN BattleOfBots_Snapshot'
```

### Re-activar el LaunchAgent de la Mac (respaldo)
```bash
launchctl load ~/Library/LaunchAgents/com.yoder.battleofbots.plist
# ⚠️ esto crea doble pipeline — no recomendado salvo emergencia
```

---

## Secrets (GitHub Actions)

Configurados en `Settings → Secrets and variables → Actions` del repo:

| Secret | Origen |
|---|---|
| `SSH_PRIVATE_KEY` | `~/.ssh/id_ed25519_ci` (clave dedicada de CI, autorizada en los 5 VPS) |
| `TS_OAUTH_CLIENT_ID` | Tailscale admin → OAuth clients (cliente `kizcapital-ci-github`) |
| `TS_OAUTH_SECRET` | idem (mostrado solo una vez al crear) |
| `SUPABASE_URL` | igual que `.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | igual que `.env.local` |

⚠️ **Bug a evitar**: nunca usar `gh secret set NAME --body -` para leer stdin — almacena literal `-`. Usar `printf '%s' "$VAL" | gh secret set NAME` o `gh secret set NAME < file`.

---

## Tailscale

- ACL con `tagOwners: { "tag:ci": ["autogroup:admin"] }`.
- Regla allow-all default cubre el SSH `tag:ci → *:22`.
- OAuth scopes: **Devices Core → Write** + **Keys Auth Keys → Write**, ambos con tag `tag:ci`.
- Runner se autentica con OAuth y queda como device efímero `tag:ci` por la duración del job (~3 min).

---

## Costo mensual

| Servicio | Plan | Uso típico | Tope free |
|---|---|---|---|
| GitHub Actions | Free | ~432 min/mes | 2,000 min/mes |
| Supabase Storage | Free | ~3 MB + ~750 MB egress | 1 GB / 5 GB egress |
| Vercel Hobby | Free | <1 GB bandwidth | 100 GB |
| Tailscale Personal | Free | 7 devices | 100 devices |

**Total: $0/mes.** Único upgrade eventual: Vercel Pro $20/mes solo si se comercializa el dashboard.

---

## Integridad de datos
- Fuente: API oficial `MetaTrader5` de Python, attach directo al `terminal64.exe` del broker en cada VPS.
- `history_deals_get()` filtrado a `entry in (1, 3)` (cierres reales) con `profit + commission + swap` netos.
- Filtro de año: solo bots con ≥1 trade cerrado en el año calendario en curso.
- `errors[]` en JSON reporta cualquier cuenta que falle — nunca se silencia.
- Bitácora: VPS (`C:\mt5-mcp\snapshot.log`), GH Actions (`mirror-logs-<run_id>.zip` artifact), Supabase Storage (timestamps de update).

---

## Criterio de ranking
Net Profit USD en 365 días. Ordenado descendente. `top_bot = bots[0]`. Promotion Score (0-100) en `post_merge.py` con 7 componentes ponderados + gating duro para identificar bots promovibles a cuenta real.
