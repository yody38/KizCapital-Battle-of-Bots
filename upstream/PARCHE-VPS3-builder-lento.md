# Parche VPS3 (#3 Package) · el builder tarda ~21 min y su snapshot nace con 32 min de edad

> **OJO CON EL NÚMERO.** El log que sirve de evidencia es anterior al recorte de
> numeración del 2026-07-27 (`config/vps_registry.json`, `legacy_permutation`),
> donde esta máquina se llamaba **vps5**. Hoy es **vps3**, tu *#3 Package*.
> El identificador que no cambia y el que uso abajo es la IP de Tailscale:
> **100.70.228.19**. Confirmado contra el registro: `vps3 · legacy_id vps5 ·
> 100.70.228.19` — la misma IP que aparece en la línea `vps5 ... STALE` del log.

> **Yody ejecuta, yo no toco la VPS.** Regla global de solo-lectura.
> Todo lo de abajo son pasos exactos para que los corras tú.

## Evidencia (medida, no estimada)

Del artifact `mirror-logs-30286128489` (run real de producción, 2026-07-27).
**Literal, sin editar** — los nombres son los de la numeración VIEJA:

```
[16:48:11Z] vps2 OK  83736 bytes age=1075s     (18 min)
[16:48:06Z] vps3 OK  83176 bytes age=1079s     (18 min)
[16:48:47Z] vps4 OK 128987 bytes age=1113s     (19 min)
[16:49:36Z] vps6 OK 213374 bytes age=668s      (11 min)
[16:50:22Z] vps5 snapshot.json STALE age=1907s threshold=1800s — aborting cycle
            ^^^^ vps5 VIEJA = 100.70.228.19 = vps3 de HOY (#3 Package)
                                        ^^^^^ 32 min · tumbó el ciclo entero
```

El dato de la máquina 100.70.228.19 **ya nace viejo**. Ninguna mejora en el dashboard o en el CI puede
arreglar eso: cuando el mirror llega, el archivo lleva media hora escrito.

## Causa raíz

Dos defectos que se multiplican, ambos en `C:\mt5-mcp\snapshot_builder.py`:

**1 · `mt5.initialize()` sin `timeout` → 60 s por terminal colgado.**

```python
# línea ~104
def fetch_terminal(path, days):
    if not mt5.initialize(path=path):        # <-- sin timeout
        return None, f"init_failed: {mt5.last_error()}"
```

El default documentado de `MetaTrader5.initialize()` es **60 000 ms**.

El recuento de terminales colgados no es medición mía: viene del comentario que ya
está en [scripts/mirror.sh](../scripts/mirror.sh) — *"VPS3 además tarda ~21min por
build (16 terminales en serie, 7 colgados a ~60s de IPC timeout cada uno)"*. Si ese
7 hoy es otro número, la aritmética cambia pero el defecto no: **cada terminal que
no responde cuesta un minuto entero del ciclo**. Lo que sí verifiqué directamente es
que la llamada no pasa `timeout` y que el bucle es serial (código citado arriba).

**2 · El bucle es estrictamente serial.**

```python
# línea ~542
for path in paths:
    data, err = fetch_terminal(path, WINDOW_DAYS)
```

16 terminales, uno detrás de otro. Nada se solapa.

---

## Cambio 1 — timeout (una línea, riesgo cero, hazlo primero)

Un terminal sano inicializa en **<2 s**; 15 s es holgadísimo.

```python
def fetch_terminal(path, days):
    # PARCHE: sin `timeout` explícito MetaTrader5 usa 60000 ms, así que cada
    # terminal colgado costaba un minuto entero del ciclo.
    if not mt5.initialize(path=path, timeout=15000):
        return None, f"init_failed: {mt5.last_error()}"
```

**Recupera ~5 min** de inmediato (7 terminales × 45 s ahorrados). Sin este cambio
el Cambio 2 también funciona, pero cada worker seguiría bloqueado 60 s.

---

## Cambio 2 — paralelizar con PROCESOS, nunca con hilos

> ⚠️ **Esto es lo importante de todo el parche.** El módulo `MetaTrader5` mantiene
> **una única conexión IPC global por proceso**. Un `ThreadPoolExecutor` haría que
> varios terminales compartan esa conexión y **mezclaría datos entre cuentas**:
> el histórico de una cuenta atribuido a otra, sin ningún error visible.
> En una VPS con **cuentas reales** eso es exactamente el fallo que no se puede
> permitir. Cada terminal necesita **su propio proceso**.

Añade el import arriba del archivo:

```python
from concurrent.futures import ProcessPoolExecutor, as_completed
```

Y sustituye el bucle serial de `main()` (línea ~542):

```python
    # --- ANTES (serial) -------------------------------------------------
    # for path in paths:
    #     data, err = fetch_terminal(path, WINDOW_DAYS)
    #     if err:
    #         errors.append({"path": path, "error": err})
    #         continue
    #     ...

    # --- AHORA (un proceso por terminal, 4 a la vez) --------------------
    # ProcessPoolExecutor y NO ThreadPoolExecutor: el módulo MetaTrader5 tiene
    # una sola conexión IPC por proceso. Con hilos, dos terminales se pisarían
    # la conexión y los datos de una cuenta acabarían atribuidos a otra.
    MAX_WORKERS = 4
    results = []
    with ProcessPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(fetch_terminal, p, WINDOW_DAYS): p for p in paths}
        for fut in as_completed(futures):
            path = futures[fut]
            try:
                data, err = fut.result()
            except Exception as e:                      # el worker murió
                errors.append({"path": path, "error": f"worker_crashed: {e}"})
                continue
            if err:
                errors.append({"path": path, "error": err})
                continue
            results.append((path, data))

    # Orden determinista: as_completed devuelve por tiempo de finalización, y el
    # snapshot debe ser byte-idéntico entre corridas (el gate de determinismo del
    # CI, scripts/test_determinism.py, lo comprueba). Reordenar por `paths`.
    order = {p: i for i, p in enumerate(paths)}
    results.sort(key=lambda r: order[r[0]])

    for path, data in results:
        acc = data["account"]
        if not acc:
            errors.append({"path": path, "error": "no_account_info"})
            continue
        accounts.append(acc)
        all_bots.extend(aggregate_bots(data["deals"], acc["login"]))
        all_positions.extend(data.get("positions", []))
        try:
            written = export_per_bot_files(
                acc["login"], data.get("full_trades", []), BOTS_DIR, acc.get("balance", 0)
            )
            bot_files_written.extend(written)
        except Exception as e:
            errors.append({"path": path, "error": f"per_bot_export_failed: {e}"})
```

### Por qué el reordenado no es opcional

`as_completed()` entrega en orden de finalización, que varía en cada corrida.
El CI corre `scripts/test_determinism.py`, que exige salida byte-idéntica entre
procesos. Sin el `results.sort(...)`, el orden de `accounts[]` y `all_bots[]`
cambiaría en cada build y el gate de determinismo se pondría rojo.

### Por qué 4 workers y no 16

Cada proceso levanta su propio cliente MT5 contra un `terminal64.exe`. VPS3 corre
16 terminales con **cuentas reales operando**. 4 concurrentes acorta el build ~4×
sin competir con los bots por CPU/RAM. Si tras medir sobra holgura, sube a 6 —
pero mide primero.

---

## Pasos exactos

**1 · Mándame el archivo real de VPS3 antes de tocar nada** (lectura, permitida —
el que tengo en `upstream/` es la copia de VPS2 y puede diferir):

```bash
scp trader@100.70.228.19:C:/mt5-mcp/snapshot_builder.py \
    "/Users/yodyiznaga/Documents/Claude/MT5 MCP/Battle of Bots/upstream/snapshot_builder.vps3.py"
```

Con ese archivo te devuelvo el parche ya aplicado, listo para copiar.

**2 · Copia de seguridad en la VPS, antes de sustituir:**

```powershell
Copy-Item C:\mt5-mcp\snapshot_builder.py C:\mt5-mcp\snapshot_builder.py.bak-20260727
```

**3 · Prueba en seco, sin tocar la tarea programada** (escribe a otra carpeta):

```powershell
cd C:\mt5-mcp
Measure-Command { python snapshot_builder.py }
```

Debe imprimir un `TotalMinutes` claramente por debajo de los ~21 actuales, y el
`account_count` del snapshot resultante tiene que seguir siendo **el mismo de
siempre**. Si baja aunque sea en 1, revierte: un terminal se perdió.

**4 · Verificación después, por lectura (la hago yo):**

- `mirror.log` de 3 ciclos seguidos: `vps3 ... age=` debe quedar **<600 s**
  (hoy 1907 s).
- `data/heartbeat_log.jsonl`: `bots_checked` **no puede bajar de 390**. Si el
  paralelismo perdiera un terminal, se ve ahí de inmediato.
- El paso "Determinism gate" del workflow `refresh-dashboard` debe seguir verde.

---

## Ganancia esperada

| | Ahora | Con el parche |
|---|---|---|
| Build de VPS3 | ~21 min | ~5 min |
| Edad del snapshot de VPS3 al llegar el mirror | 1907 s | <600 s |
| Ciclos tumbados por `vps5 snapshot_stale` | frecuente | ninguno |

Sumado al cron `*/15` y al paralelismo del mirror (ya aplicados en el repo), la
edad típica del dato que lees baja de **35-45 min a ~10-15 min**.
