# Cambios de formula — trazabilidad obligatoria

Generado automaticamente desde `SCORE_CHANGELOG_V2` en `scripts/post_merge.py`.
No editar a mano: si cambia la formula, cambia el codigo y este documento se
regenera con `python3 scripts/gen_formula_changes.py`.

**Version viva del score:** `v1`  
**Versiones en sombra:** `v2`

Mientras la version viva sea `v1`, NADA de lo que sigue afecta a
`promotion_status`, al orden de los asientos ni a ninguna cifra publicada.
v2 se calcula y se publica en paralelo para que el owner pueda comparar
antes de autorizar el cambio.

El diff por bot de cada ciclo queda en `data/shadow/score_v2_diff.json`, y
el resumen en `snapshot.promotion_meta.score_versions.v2.diff`.

---

## F1 · `net_return`

| | |
|---|---|
| **OLD FORMULA** | `clamp01(((net_after_commission_LIFETIME / balance) / months_active_365d * 100) / 0.5)` |
| **NEW FORMULA** | `clamp01(return_monthly_pct_365d / 0.5)  # numerador y denominador en la MISMA ventana` |
| **RATIONALE** | El builder filtra a 365 dias pero reconcile_snapshot sobrescribia el neto con el de por vida, asi que se dividia dinero de 3 anos entre 12 meses. El componente quedaba inflado por un factor aproximado a la edad en anos. |
| **EXPECTED IMPACT** | Los bots con mas de 12 meses bajan en este componente; peso 0.15, asi que hasta 15 puntos de score. Los de menos de 12 meses no cambian. |
| **AFFECTED BOTS** | todo bot con months_active_lifetime > months_active_365d |
| **TEST** | `tests/test_norms_v2.py::test_net_return_misma_ventana` |

## F2 · `oos_robustness`

| | |
|---|---|
| **OLD FORMULA** | `clamp01(pct_folds_test_profitable)  # campo 0-100 dentro de un clamp 0-1` |
| **NEW FORMULA** | `clamp01(pct_folds_test_profitable / 100.0)` |
| **RATIONALE** | El campo se emite en 0-100 (walk_forward) y dos lineas antes ya se divide entre 100 para oos_score. Con el clamp, cualquier bot con >=1% de folds rentables puntuaba igual que uno con el 100%. |
| **EXPECTED IMPACT** | El componente deja de estar saturado; peso 0.06. |
| **AFFECTED BOTS** | todo bot con bloque oos |
| **TEST** | `tests/test_norms_v2.py::test_norm_oos_escala` |

## F3 · `significance`

| | |
|---|---|
| **OLD FORMULA** | `clamp01(0.5 + sharpe_ci.lo)  # suma un Sharpe anualizado a 0.5` |
| **NEW FORMULA** | `clamp01((sharpe_ci.lo + 1.0) / 2.0)  # lo=-1 -> 0, lo=0 -> 0.5, lo=+1 -> 1` |
| **RATIONALE** | Mezcla de escalas sin definir; saturaba para cualquier |lo| >= 0.5. |
| **EXPECTED IMPACT** | Cambia hasta 3 puntos (peso 0.03). |
| **AFFECTED BOTS** | todo bot con confidence_intervals.sharpe.lo |
| **TEST** | `tests/test_norms_v2.py::test_norm_significance_mapeo` |

## F4 · `radar.returns / dominance.money`

| | |
|---|---|
| **OLD FORMULA** | `radar: (net_profit_bruto/bal)*(12/m)*100 · dominance: (nac_lifetime/bal)/m*100` |
| **NEW FORMULA** | `ambos: return_monthly_pct_365d (la metrica canonica del registry)` |
| **RATIONALE** | Habia TRES definiciones distintas de 'retorno' en el mismo archivo, asi que el eje del radar y el analisis de Pareto no eran comparables con el score. |
| **EXPECTED IMPACT** | Cambia el percentil del eje returns y algun veredicto is_thoroughbred. |
| **AFFECTED BOTS** | todo bot con radar o dominance |
| **TEST** | `tests/test_norms_v2.py::test_retorno_unico_del_registry` |

---

## Correlacion

| | |
|---|---|
| **Version viva** | `v1` |
| **OLD (v1, viva)** | pearson sobre la UNION de fechas, rellenando con 0.0 los dias sin operar |
| **NEW (v2, sombra)** | pearson sobre la INTERSECCION de dias activos, minimo 20 dias solapados, `None` si no llega |
| **RATIONALE** | Las series son dispersas. El relleno con ceros sesga la correlacion hacia 0 en pares de baja frecuencia y la infla entre bots que solo comparten calendario. Ese estimador alimenta el bloqueo HARD `clones_real` con umbral 0.7. |
| **EXPECTED IMPACT** | Puede cambiar que bots quedan bloqueados por parecerse a uno ya desplegado en real. |
| **AFFECTED BOTS** | los hasta 60 del universo de correlacion |
| **TEST** | `tests/test_correlation_v2.py` |

Ambas matrices viajan en `data/correlations.json`: `matrix` (v1) y
`matrix_v2`, junto a `overlap_n` con los dias solapados de cada par.

---

## Ventanas temporales

Desde 2026-09-08 todo campo nuevo lleva la ventana en el nombre:
`_lifetime`, `_365d`, `_180d`, `_90d`, `_30d`, `_current`. Los campos sin
sufijo conservan su semantica mezclada actual, estan documentados en
`snapshot.metrics_meta`, y se retiran cuando ningun consumidor los lea.

Convencion de dinero: los campos con sufijo usan
`net = profit + commission + swap`. Los campos legacy sin sufijo que
escribe `reconcile_snapshot` usan `profit + swap`, sin comision, que es
mas optimista. Por eso no se mezclan.
