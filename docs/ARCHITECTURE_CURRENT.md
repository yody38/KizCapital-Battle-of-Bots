# Arquitectura actual — Battle of Bots (extracto operativo)

Resumen de una página para quien necesite orientarse rápido. La fuente completa,
con evidencia archivo:línea, es `KIZ_CAPITAL_PLATFORM_MASTER_AUDIT.md` (auditoría
2026-09-07) y `KIZ_COMMAND_CENTER_IMPLEMENTATION_BLUEPRINT.md` §2 (re-verificación
2026-09-08). Este documento no repite esa evidencia; solo la ubica.

## Qué es, en una frase

Un observatorio de ~68 cuentas MT5 en 6 VPS Windows: sitio estático (sin build,
sin framework) + 36 scripts Python orquestados por GitHub Actions cada 15 min +
JSON en Supabase Storage (espejado a Cloudflare R2) como base de datos de bots,
trades y métricas. Postgres solo guarda 5 tablas pequeñas (whitelist, estado en
vivo de las 5 cuentas reales, su historial, heartbeat del publicador, puntero de
versión del ciclo).

## Las dos rutas de datos

- **Lenta (15 min, todo el universo de bots):** VPS → `mirror.sh` → `post_merge.py`
  → `verify_integrity.py` → `upload_to_supabase.py` → Storage/R2 → `/d/<sha>` o
  signed URL → navegador.
- **Rápida (~3 s, solo las 5 cuentas reales):** VPS3 → `live_publisher.py` →
  Postgres (`live_real_state`) → Supabase Realtime → navegador.

## Dónde vive cada cosa

| Capa | Implementación |
|---|---|
| Frontend legacy | `index.html` + `app.js` (8.485 L) + `views.js` + `search.js`, sin router, un solo `<script>` sin build |
| Frontend nuevo (en construcción) | `command.html` + `cc/` — módulos ES nativos, router por hash, convive con el legacy sin tocarlo |
| Motor analítico | `scripts/post_merge.py` (194 KB) — scoring, gates, Monte Carlo, correlación, portfolio |
| Transporte/distribución | `api/d.js` (Vercel Edge, capability URL `/d/<sha>/<path>`) + Worker `bob-failover` (R2) |
| Orquestación | `scripts/mirror.sh` + 9 workflows en `.github/workflows/` |
| Datos de bots/trades/métricas | JSON en Supabase Storage, no en Postgres |
| Identidad/config canónica | `config/vps_registry.json` (topología de VPS; overlay `.local.json` gitignored con IPs/logins) |

## Qué NO hace

No ejecuta operaciones ni abre cuentas (regla dura, implementada en 3 sitios
independientes: solo lee terminales MT5 ya abiertos). No promueve bots a real
automáticamente — `human_veto_required = True`. No tiene multiusuario.

## Estado de la evolución a Command Center

Ver `KIZ_COMMAND_CENTER_IMPLEMENTATION_BLUEPRINT.md` §0 para el estado
verificado fase por fase, y §3 para los defectos críticos que se corrigen antes
de que la UI nueva confíe en los datos (ventana temporal partida en el score,
correlación sesgada por relleno de ceros, dos pantallas rotas en silencio).
