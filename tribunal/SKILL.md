---
name: kiz-bot-tribunal
description: ULTRA TRIBUNAL de 50 pares de agentes adversariales (100 lentes) que debate y entrega los 3 MEJORES bots corriendo SOLO en cuentas demo de la flotilla Kiz Capital. Copia versionada para la routine semanal (trigger remoto). La fuente editable vive en ~/.claude/skills/kiz-bot-tribunal/ en el Mac del owner — este archivo es el que lee el entorno remoto del domingo.
---

# ⚠️ CLÁUSULA DE SEGURIDAD NO-NEGOCIABLE (leer primero y al final)

Este proceso opera **EXCLUSIVAMENTE** sobre cuentas **DEMO** de la flotilla MT5. Bajo ninguna
circunstancia debes leer con intención de operar, escribir, ejecutar trades, ni modificar
configuración de una cuenta **REAL**. Es un proceso de **solo lectura y análisis** sobre datos
históricos ya recolectados — no toca MT5, no cambia el EA de ningún bot, no toca el dashboard,
no hace push a ningún sistema de trading.

Antes de publicar el veredicto final, verifica EXPLÍCITAMENTE (no asumas) que ninguno de los 3
bots del podio aparece en `real_magics` ni en cuentas con `is_real=true` / `trade_mode==2` del
snapshot (esto ya lo filtra `build_expediente.py`, pero re-verifica con un chequeo independiente
antes de comprometer el veredicto — ver Fase 7). Si algún bot del podio coincide con una cuenta
real, es un bug: **abortar sin publicar veredicto** y reportarlo como fallo crítico en vez de
notificar un podio.

---

# Ultra Tribunal de Bots — "Los 3 Caballos Ganadores" (routine semanal)

50 pares de lentes irreconciliables (ver `ROSTER.md`) debaten sobre datos determinísticos y
reportan al **Juez Supremo** (vos, el agente de esta routine). Salida: los **3 mejores bots
demo** — sí o sí mejores que todos los demás (gate de dominancia lo garantiza).

**Reglas duras:**
- SOLO cuentas demo. Los reales se excluyen en Fase 0 (doble filtro `is_real` + `real_magics`).
- 0% alucinación: todo número citado sale de `data/expediente_digest.md`. Un lente que invente un valor queda descalificado por el Validator.
- *No free attacks*: refutar sin contra-candidato + números es inválido (peso reducido).
- Disenso irreducible se REGISTRA, nunca se promedia a consenso tibio.
- Ante empate gana el lente conservador (preservación + evidencia).
- Nunca mostrar/commitear secretos (`SUPABASE_SERVICE_ROLE_KEY`, etc.) en logs, commits, o notificaciones.

## Modo de esta routine: `full` (50 pares, ~53 subagentes, oleadas de 10)

## Fase 0 — Expediente determinístico

```bash
python3 tribunal/scripts/build_expediente.py
```

Requiere `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` como variables de entorno de este runtime
(el script las lee de `os.environ` si no encuentra `.env.local`, que en este entorno remoto no
existe). Si faltan, el script lanza `RuntimeError` explícito — reportarlo como fallo de
configuración, NO intentar adivinar o hardcodear credenciales.

Baja snapshot fresco de Supabase, filtra demo, cohorte viva (last_trade ≤14d, trades ≥20),
percentiles por eje. Si sale `"stale": true` (>2h): disparar
`gh workflow run refresh-dashboard --repo yody38/KizCapital-Battle-of-Bots`, esperar ~10 min,
regenerar. Si la CI no responde, avisar y correr con lo que hay (marcándolo en el veredicto).

Verificar en el JSON de salida: `demo_total` ≈ cohorte esperada, `reals_excluded: true`, `candidates` ≥ 30.

## Fases 1-3 — Los 50 pares (Tesis → Antítesis → Posición)

Por cada par del `ROSTER.md` lanzar **1 subagente** (tool de subagentes disponible en este
entorno, modelo sonnet), en **oleadas de 10**; esperar a que termine una oleada antes de la
siguiente. Prompt plantilla (rellenar `{N}`, `{TOPIC}`, `{THESIS_NAME}`, `{THESIS_LENS}`,
`{ANTI_NAME}`, `{ANTI_LENS}` desde ROSTER.md):

```
Eres el PAR #{N} del Ultra Tribunal de Bots de Kiz Capital (flotilla de EAs MT5 en cuentas DEMO).
Lee el expediente: tribunal/data/expediente_digest.md
Es tu ÚNICA fuente de números; no inventes ningún valor. Los bots se identifican como vps:login:magic.
Objetivo del owner: dinero recurrente semanal/mensual maximizado, mezclado con longevidad de largo plazo.

Roleplay interno en 3 actos sobre el eje "{TOPIC}":
1) TESIS — Eres "{THESIS_NAME}". Tu lente: {THESIS_LENS}. Deliberadamente optimista hacia tu sesgo.
   Nomina TU top-3 de caballos ganadores citando los números exactos del expediente que te convencen.
2) ANTÍTESIS — Eres "{ANTI_NAME}". Tu lente: {ANTI_LENS}. REFUTA la tesis: dónde es optimista de más,
   qué números la desmienten. REGLA NO FREE ATTACKS: tu refutación es inválida si no contra-nominas
   candidatos concretos con números. Atacar es gratis; mejorar es el trabajo.
3) POSICIÓN — Modera: si hay síntesis, top-3 del eje con evidencia; si el trade-off es irreducible,
   converged=false y registra el disenso explícito (NO promedies). Ante empate gana el lado conservador.

Devuelve SOLO este JSON al final (sin texto extra):
{"pair_id":{N},"topic":"{TOPIC}",
 "thesis":{"lens":"{THESIS_NAME}","champions":["id1","id2","id3"],"stance":"...","evidence":"números citados","confidence":0.0},
 "antithesis":{"lens":"{ANTI_NAME}","why_fails":"...","counter_champions":["id","id"],"evidence":"números citados","severity":"P0|P1|P2|P3"},
 "position":{"converged":true,"top3":["id1","id2","id3"],"winning_lens":"thesis|antithesis|synthesis|unresolved","dissent":"","residual_risk":"..."}}
```

## Fase 4 — Devil's Advocate + Domain Outsider (2 subagentes en paralelo)

Compilar digest de las 50 posiciones (`[topic] converged → top3 | DISENSO: ...`) y lanzar:
- **Devil's Advocate**: inmune a poda, ataca el consenso emergente. Devuelve `{challenge, blind_spots[], recommendation}`.
- **Domain Outsider**: gestor de riesgo institucional + auditor de fondos ajeno al retail EA/forex. Cuestiona supuestos base: demo≠real (fills/slippage), survivorship bias, multiple-testing. Mismo schema.

## Fase 5 — Juez Supremo (vos, el agente principal de esta routine, NO subagente)

Consolidar con votos ponderados por bloque del ROSTER: **A Dinero 35% · B Supervivencia 20% ·
C Consistencia 15% · D Calidad estadística 15% · E Longevidad 10% · F Portafolio 2.5% · G Operacional 2.5%**.
Producir **podio provisional top-3 + 2 suplentes** con justificación por caballo.

## Fase 6 — Gate doble

1. **Determinístico:**
```bash
python3 tribunal/scripts/verify_verdict.py "id1" "id2" "id3"
```
`REJECT` si un bot fuera del podio con evidencia comparable gana en ≥9/12 ejes núcleo → swap con el
retador o con un suplente y re-verificar (máx 2 iteraciones; si persiste, el retador ENTRA al podio).

2. **Adversarial Validator** (subagente): recibe podio + digest de posiciones + expediente_digest.md.
Ataca la síntesis. Devuelve `{verdict_holds, unsupported_items[], hallucinations[], survives_por_caballo}`.

## Fase 7 — Verificación final de seguridad + persistencia + notificación (SOLO de esta routine)

1. **Re-chequeo de seguridad:** confirmar que ninguno de los 3 ids del podio final está en
   `real_magics` del snapshot ni corresponde a cuenta con `is_real=true`/`trade_mode==2`. Si hay
   coincidencia, ABORTAR (no commitear, no notificar podio — reportar el bug).
2. **Persistir:** escribir `tribunal/data/verdict_<YYYYMMDD>.json` (podio, suplentes, votos por
   bloque, gate, validator, snapshot usado — NUNCA incluir secretos). `git add tribunal/data/verdict_*.json
   && git commit -m "tribunal: veredicto semanal <fecha>" && git push origin HEAD:main`.
3. **Notificar:** enviar una notificación push de 1 línea con el podio, ej.
   `🏆 Tribunal semanal <fecha>: 1) <id1> 2) <id2> 3) <id3>`.
4. Repetir el recordatorio: este proceso fue 100% solo-lectura sobre cuentas demo; no se tocó ninguna cuenta real.
