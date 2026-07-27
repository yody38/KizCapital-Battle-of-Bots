# Operación de las CUENTAS REALES

> Estado consolidado el **2026-07-27**. Este documento sí se edita a mano
> (el `RUNBOOK.md` es autogenerado, no tocar).

## Regla de oro

**Las 5 cuentas reales las abre el owner, a mano. Nada automático puede abrirlas.**

| Cuentas | VPS | Instalación |
|---|---|---|
| `43306` · `32081` · `25425` · `43411` · `43414` | **vps3** — `185.187.238.23:42014` | `C:\Users\Administrator\Desktop\CUENTAS-REALES\<login>\` (portable, acceso directo con `/portable`) |

Bróker `ADNBrokerCFD-Server`. Ninguna otra VPS tiene rastro de cuentas reales
(auditadas una a una el 2026-07-27).

**Si detectas que una real no está abierta: avísale al owner y para ahí.** Él va a vps3 y la
abre; tiene usuario y contraseña y sabe dónde están. Nunca ofrecer abrirla, ni arrancarla
"para ayudar", ni pedirle credenciales.

---

## Por qué esto necesita vigilancia activa

```python
mt5.initialize(path=r"C:\...\terminal64.exe")   # ← ARRANCA el terminal si está cerrado
```

No es un bug: es su comportamiento normal. Por eso **todo proceso que "solo lee" cuentas acaba
abriéndolas**. El owner cerraba terminales y reaparecían cada 30 min.

### Caminos cerrados (2026-07-27)

| Camino | Corre desde | Estado |
|---|---|---|
| `snapshot_builder.py` | Task Scheduler vps3, 30 min | filtro "solo lo que ya corre" (pywin32) |
| `live_publisher.py` | **GitHub Actions por SSH**, ~30 s | filtro en `_snapshot_terminal` |
| `MT5_Watchdog` (vps3) | Task Scheduler, 10 min | **Disabled** + `terminales.json` vacío |
| `MCP-MT5-Server` (vps3) | Task Scheduler | **Disabled** — hacía autologin a 25425 |
| `MCP-MT5-Tunnel` (vps3) | Task Scheduler | **Disabled** — túnel Cloudflare público |

⚠️ El live publisher **no corre desde la VPS**: desactivar su tarea local no lo detiene.
⚠️ Renombrar una carpeta a `.OLD` **no la saca** del glob `MetaTrader 5 *` — hay que moverla
fuera de `Program Files`.

### Hallazgo de seguridad pendiente

`C:\MCP-MT5\start-mcp.bat` ejecutaba
`metatrader-http-server --login 25425 --password <de .env en texto plano> --host 0.0.0.0 --port 8080`
más un `cloudflared tunnel` que lo publicaba en internet sin autenticación. Ambas tareas
quedaron deshabilitadas y el proceso muerto.

**El owner decidió no rotar la contraseña de la 25425 por ahora.** Si aparece actividad
extraña en esa cuenta, esta es la primera hipótesis.

---

## Cadencia del dashboard

- **Demos:** ciclo de snapshot cada 30 min (operaciones cerradas).
- **Reales:** en vivo cada pocos segundos vía `live_real_state`.

## War Room — cesta fija

Ventana **domingo 17:00 America/New_York → viernes 17:00 NY** (= 14:00 Las Vegas), DST-safe;
congela el fin de semana y reinicia sola el domingo.

**Regla:** el total solo se emite cuando **todas** las cuentas del roster tienen dato en ese
instante. Comparar apertura y cierre con distinto número de cuentas inventa dinero — pasó el
2026-07-27: apertura con 4 cuentas ($27,325) vs cierre con 5 ($34,703) → "+$7,378" que nadie
ganó.

Implementado en dos sitios, los dos necesarios:
- `app.js` → `warWeeklyHistoryPrefix` exige `state.realLogins.size`
- `supabase/live_real_history.sql` → `having count(*) = (select count(*) from logins)`

⚠️ **El `having` está en el repo pero puede no estar aplicado en Supabase.** Verificarlo en el
editor SQL.

---

## Reglas para tocar scripts de la VPS

**Nunca parchear en sitio con PowerShell.** La interpolación se come `$_` y corrompe comandos
(costó un incidente: `{ \.Path }` en vez de `{ $_.Path }` vació el dashboard 40 min), y la
cirugía de strings rompe archivos (`return rutasdef ...`).

**Método probado:** `scp` bajar → editar en Python validando con `ast.parse` → `scp` subir →
`python -m py_compile` en la VPS → probar **en el contexto real** (si corre por Task Scheduler,
lanzarlo desde ahí, no solo por SSH). Respaldo previo siempre: `*.bak-<fecha>`.

**Observabilidad obligatoria:** todo filtro que pueda dejar cuentas fuera debe loguear cuántas
vio (`reales_vistas=N/5`, `terminales_corriendo=N`). Lo peor del incidente no fue el fallo:
fue que fue **silencioso**.

---

## Skills relacionadas

- `mt5-nadie-abre-cuentas-reales` — auditoría y cierre de los caminos que abren cuentas
- `mt5-cuentas-reales-portables` — montar una instalación portable por cuenta
- `battle-of-bots-integrity-check` — dashboard congelado / drift de datos
