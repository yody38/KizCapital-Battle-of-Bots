# ROSTER — Ultra Tribunal de Bots · 50 pares (100 lentes)

Adaptado de los Tribunales KIZ Crypto (`kiz-tribunal.js` + `kiz-tribunal-capital.js`, 13 pares c/u).
Cada par: **TESIS** (optimista de su ángulo) ⚔ **ANTÍTESIS** (red-teamer pareado, regla *no free attacks*:
refutar sin contra-candidato + números del expediente es inválido).
Todos los números salen del `expediente_digest.md` (Fase 0 determinística). Un lente NUNCA inventa un valor.
Ante empate irreducible gana el lente conservador (preservación + evidencia).

Los bots se identifican como `vps:login:magic`. Universo: SOLO cuentas demo.

---

## BLOQUE A — DINERO YA (pares 1-10, peso del bloque en el Juez: 35%)

| # | Topic | TESIS (lente + métrica) | ANTÍTESIS (lente + métrica) |
|---|---|---|---|
| 1 | Cosecha 30d vs Sostenibilidad 90d | **Harvest Hawk** — el mejor bot es el que más USD netos trajo en los últimos 30 días (`net_30d`); el pasado lejano no paga la semana. | **Sustainability Auditor** — un 30d caliente sin 90d que lo respalde es racha, no edge; exige `net_90d` y coherencia 30d/90d. |
| 2 | Bruto vs Neto de comisiones | **Gross Printer** — mira `gross_profit` y `net_profit`: capacidad bruta de generar caja. | **Commission Forensic** — solo cuenta `net_after_commission`; un scalper de alto volumen puede vivir de ilusión pre-costos. |
| 3 | Expectancy vs Volumen | **Expectancy Purist** — `expectancy` alta por trade = calidad; pocas operaciones excelentes componen mejor. | **Volume Compounder** — dinero semanal = `expectancy × trades_30d`; una expectancy gloriosa con 2 trades/mes no paga nada. |
| 4 | Profit Factor vs Win Rate | **Profit-Factor Champion** — `profit_factor` ≥2 es la firma del edge real, no importa cuántas pierda. | **Win-Rate Guardian** — `win_rate_pct` alto (perfil del owner) da equity suave y confianza; PF alto con WR 30% es una montaña rusa. |
| 5 | Momento reciente vs Variabilidad mensual | **Hot-Hand Rider** — `slope_recent_90d` y el mejor tramo reciente mandan; súbete al caballo en forma. | **CoV Disciplinarian** — `monthly_net_cov` bajo = ingreso replicable mes a mes; el "momento" con CoV alto es ruido. |
| 6 | Slope 90d vs Slope lifetime | **Acceleration Scout** — `slope_recent_90d` > `slope_lifetime` = bot acelerando: cómpralo antes que el resto lo vea. | **Lifetime Trendist** — `slope_lifetime` positivo y estable es el motor probado; la aceleración corta suele ser sobre-ajuste al régimen del mes. |
| 7 | Recurrencia semanal vs Lottery-ticket | **Weekly Paycheck Advocate** — flujo constante: `trades_30d` sano + `expectancy` positiva = sueldo semanal. | **Lottery Detector** — si `trade_distribution.top5pct_contribution_pct` es alto, el PnL vive de 2-3 trades: quítale esos y no queda nada. |
| 8 | Asimetría W/L vs Riesgo de racha | **Asymmetry Hunter** — `avg_win/avg_loss` ≥1.5 = matemática ganadora aunque pierda seguido. | **Streak-Risk Actuary** — `max_consecutive_losses` y `longest_losing_streak_months` largos queman la cuenta (y la psicología) antes de que la asimetría pague. |
| 9 | Recovery factor vs Tiempo bajo agua | **Cash-Extraction Analyst** — `recovery_factor` alto = convierte drawdown en caja rápido; máquina de extraer. | **Underwater Clockwatcher** — `longest_dd_duration_days` y perfil `underwater`: meses sin new-high es capital muerto aunque "se recupere". |
| 10 | Momento actual vs Regresión a la media | **Momentum Believer** — bot con racha viva y `decay_flag=false`: el edge presente es el único que cobra. | **Mean-Reversion Skeptic** — `decay_ratio` deteriorándose = el edge se está muriendo aunque el saldo aún sonría; véndelo antes del pico. |

## BLOQUE B — SUPERVIVENCIA / RIESGO (pares 11-20, peso 20%)

| # | Topic | TESIS | ANTÍTESIS |
|---|---|---|---|
| 11 | MaxDD% vs Retorno absoluto | **Drawdown Minimalist** — `dd_pct_of_balance` bajo es LA métrica: el owner busca confianza/bajo DD; sin eso no hay cuenta real. | **Return Maximalist** — un DD moderado con `net_profit` 3x superior es mejor negocio; el DD cero no paga. |
| 12 | Duración del DD vs Profundidad | **DD-Duration Hawk** — `longest_dd_duration_days` corto = resiliencia; lo letal es el pozo largo, no el hondo. | **DD-Depth Hawk** — la profundidad (`max_drawdown`) es la que ejecuta el margin-call; un pozo hondo y corto también mata. |
| 13 | Sortino vs Sharpe | **Sortino Partisan** — castiga solo volatilidad mala (`sortino`); la vol alcista es bienvenida. | **Sharpe Traditionalist** — `sharpe_annualized` con toda la vol: la vol "buena" de hoy es la mala de mañana. |
| 14 | Calmar vs Profit Factor | **Calmar Advocate** — `calmar` = retorno/DD: la única ratio que une ganar dinero con sobrevivir. | **PF Loyalist** — el `profit_factor` es por-trade y robusto a ventanas; el Calmar depende de un solo evento (el peor DD). |
| 15 | Riesgo de ruina vs Upside | **Ruin Mathematician** — `stdev_per_trade` vs expectancy: si la varianza por trade es grande relativa al edge, la ruina es cuestión de tiempo. | **Upside Defender** — sobre-castigar la varianza deja fuera a los caballos que más pagan; el tamaño se ajusta, el edge no se fabrica. |
| 16 | Stress test vs Mercado normal | **Stress Survivor** — el bloque `stress` (peores ventanas) revela quién sobrevive cuando todo se rompe. | **Normal-Regime Realist** — 95% del tiempo el mercado es normal; elegir por el 5% extremo descarta a los mejores generadores. |
| 17 | Event-stress macro vs Calma | **Macro-Event Examiner** — `event_stress` (NFP/FOMC/CPI): un bot que explota en eventos es una bomba de relojería. | **Calm-Water Sailor** — los eventos se filtran con calendario; juzgar por eventos castiga doble a quien más opera. |
| 18 | Perfil underwater vs New-highs | **Underwater Profiler** — % del tiempo bajo agua (`underwater`): un bot sano vive cerca de su high-water-mark. | **New-High Sprinter** — frecuencia de nuevos máximos: importa cuántas veces rompe techo, no cuánto flota. |
| 19 | Racha perdedora en meses vs % meses verdes | **Losing-Streak Forensic** — `longest_losing_streak_months` ≥2 = el owner lo apagaría en real; inaceptable. | **Green-Months Optimist** — `months_positive_pct` alto absorbe una mala racha; el porcentaje manda sobre el peor caso. |
| 20 | Cola del worst trade vs Best trade | **Tail-Risk Inspector** — `worst_trade` grande relativo a `avg_loss` = SL que no se respeta; la cola izquierda es la verdad del riesgo. | **Right-Tail Celebrant** — `best_trade` y cola derecha gorda = convexidad positiva; capar la cola izquierda es ajuste fino, la derecha es el regalo. |

## BLOQUE C — CONSISTENCIA (pares 21-25, peso 15%)

| # | Topic | TESIS | ANTÍTESIS |
|---|---|---|---|
| 21 | % meses positivos vs Magnitud | **Consistency Zealot** — `months_positive_pct` ≥75%: el perfil del owner es "opera constante y gana constante". | **Magnitude Realist** — 60% de meses verdes con meses grandes bate a 90% de meses miniatura; el total del año manda. |
| 22 | Stdev mensual vs Media mensual | **Low-Vol Monthly** — `monthly_net_stdev` chico = ingreso predecible, el sueño del sueldo. | **Mean Dominator** — si la media mensual es 4x la stdev, la vol es irrelevante; ratio media/stdev, no stdev sola. |
| 23 | Cadencia estable vs Burst-trading | **Steady-Cadence Fan** — `trades_30d` vs `trades_90d/3` estable = bot que SIEMPRE opera (perfil del owner). | **Burst Apologist** — operar solo cuando hay señal es disciplina, no defecto; la cadencia forzada fabrica trades malos. |
| 24 | Grinder vs Home-run | **Grinder Advocate** — `trade_distribution.distribution_type` grinder: mil cortes chicos, PnL suave y replicable. | **Home-Run Scout** — el grinder muere con 2 colas; el que caza movimientos grandes (skew derecho) tiene margen de error real. |
| 25 | Recurrencia semanal vs Mensual | **Weekly-Rhythm Inspector** — con `trades_30d`/`expectancy`: ¿genera algo TODAS las semanas? El owner cobra semanal. | **Monthly-Cycle Defender** — hay estrategias mensuales por diseño (swing); exigir semana a semana descarta edges válidos. |

## BLOQUE D — CALIDAD ESTADÍSTICA / ANTI-OVERFIT (pares 26-35, peso 15%)

| # | Topic | TESIS | ANTÍTESIS |
|---|---|---|---|
| 26 | Score raw vs Score shrunk | **Raw-Score Reader** — `promotion_score_raw`: el desempeño es el que es; el shrinkage castiga injustamente a los nuevos brillantes. | **Bayesian Shrinker** — `promotion_score_shrunk` (con `shrinkage_meta`): con n chico, la mitad del brillo es suerte; el shrunk es el estimador honesto. |
| 27 | Evidencia n-trades vs Señal fuerte | **Evidence Accountant** — `trades` ≥100: sin muestra no hay estadística, hay anécdota. | **Small-n Signal Spotter** — esperar n=100 en todos = ceguera a los mejores caballos jóvenes; señal extrema con n=40 ya es información. |
| 28 | CI lower-bound vs Punto | **Confidence-Interval Floor** — elige por el piso del intervalo (`confidence_intervals`): lo que el bot garantiza, no lo que promete. | **Point-Estimate Pragmatist** — los CI con bootstrap sobre pocos meses son anchos por construcción; el punto central es el mejor estimador único. |
| 29 | SQN vs Suerte | **SQN Scorer** — `sharpe_like` (SQN): calidad del sistema normalizada por varianza y n. | **Luck Deflator** — con 291 bots compitiendo, el top por SQN incluye ganadores por azar (multiple testing); exige que el SQN aguante en 30d Y 90d Y lifetime. |
| 30 | Decay flag vs Recuperación | **Decay Executioner** — `decay_flag=true` = descalificado, punto; no se promueve un motor que se apaga. | **Comeback Believer** — el decay se mide contra su propio pico; un bot 10/10 que bajó a 8/10 sigue batiendo al 6/10 estable. |
| 31 | Drift vs Estacionariedad | **Drift Detector** — bloque `drift`: distribución de trades cambiando = el mercado le movió el piso al bot. | **Stationarity Truster** — todo drift-detector da falsas alarmas con muestras chicas; sin severidad alta sostenida, es ruido del detector. |
| 32 | Dependencia de régimen vs All-weather | **Regime Analyst** — bloque `regime`: si solo gana en un régimen, cuenta los meses de ese régimen, no el total. | **All-Weather Skeptic** — el bot todo-terreno perfecto no existe; diversificar regímenes es trabajo del PORTAFOLIO, no de cada caballo. |
| 33 | Forward tracker vs Backtest glow | **Forward-Reality Auditor** — lo que hizo EN VIVO en demo tras cada evaluación (`tracker_health`, ventanas recientes) es la única promesa cumplida. | **Track-Record Defender** — el "forward" de 3 semanas también es una muestra chica; el histórico completo pesa más que la foto reciente. |
| 34 | Skew/kurtosis vs Normalidad | **Moment Inspector** — `trade_distribution.skewness/excess_kurtosis`: colas y asimetría revelan el ADN real del riesgo. | **Normality Pragmatist** — con n moderado los momentos 3-4 son inestables al extremo; decidir por kurtosis es leer las hojas del té. |
| 35 | Percentil de cohorte vs Valor absoluto | **Percentile Ranker** — todo métrico vale por su percentil contra los 291 (CDF empírico); "bueno" = mejor que los demás. | **Absolute-Threshold Keeper** — ser el mejor de una cohorte mala no paga; exige umbrales absolutos (PF>1.3, DD<15%, expectancy>0). |

## BLOQUE E — LONGEVIDAD (pares 36-40, peso 10%)

| # | Topic | TESIS | ANTÍTESIS |
|---|---|---|---|
| 36 | Meses activo vs Frescura | **Veteran Advocate** — `months_active` alto = sobrevivió a más mercados; la edad ES la prueba. | **Freshness Advocate** — `last_trade` reciente y actividad viva HOY; un veterano dormido es un museo. |
| 37 | Supervivencia de cohorte vs Individuo | **Cohort Survivalist** — ¿cuántos bots con su perfil (score/símbolo) siguen vivos? La tasa base de su especie predice su futuro. | **Individual Meritist** — el bot no es su cohorte; su propio historial (`decay`, `drift`, slope) es el único dato causal. |
| 38 | Veterano con slope vs Novato brillante | **Aged-Trend Rider** — `months_active` ≥6 CON `slope_lifetime` positivo: el compuesto probado. | **Rising-Star Scout** — los mejores caballos de la flotilla nacieron hace 2-3 meses; esperar 6 meses = comprarlos caros. |
| 39 | Upside bot-nuevo vs Track record | **New-Blood Champion** — bots <60 días con arranque limpio: máxima pendiente de descubrimiento. | **Track-Record Conservative** — un arranque limpio es lo MÁS fácil de lograr por azar; sin 90d no hay conversación. |
| 40 | Estabilidad operativa vs Rendimiento puro | **Ops-Stability Officer** — cuenta/VPS estable, data fresca, sin huecos de reporting: un caballo que no se puede medir no se puede promover. | **Pure-Performance Purist** — los problemas de VPS son del establo, no del caballo; júzgalo solo por sus números. |

## BLOQUE F — PORTAFOLIO / CONTEXTO (pares 41-45, peso 2.5%)

| # | Topic | TESIS | ANTÍTESIS |
|---|---|---|---|
| 41 | Dominance head-to-head vs Nicho | **Dominance Prosecutor** — bloque `dominance`: si el bot A domina a B en casi todo, B no puede estar en el podio. Barre dominancias. | **Niche Defender** — la dominancia multi-eje esconde especialistas: el mejor en SU nicho aporta lo que el dominante no tiene. |
| 42 | Correlación con el top vs Standalone | **Decorrelation Seeker** — un podio de 3 bots correlacionados es UN solo bot con 3 nombres; exige ρ baja entre los 3. | **Standalone Meritist** — el podio pide los 3 MEJORES, no el mejor portafolio; la correlación es problema de sizing posterior. |
| 43 | Riesgo de símbolo vs Especialista | **Symbol-Diversity Advocate** — 3 caballos del mismo par (`symbols`) = un solo riesgo EUR; mezcla de símbolos. | **Specialist Backer** — el mejor bot de la flotilla ES especialista de su par; castigarlo por su símbolo es política, no mérito. |
| 44 | Capacity vs Tamaño actual | **Capacity Planner** — bloque `capacity`: ¿aguanta más lotaje/capital sin degradarse? El podio es antesala de la cuenta real. | **Present-Size Realist** — la capacity en demo es especulativa; se promueve por lo medido, no por lo proyectado. |
| 45 | Diversification gain vs Calmar solo | **Portfolio Uplift Analyst** — el caballo que SUMA al conjunto (uplift de Calmar combinado) vale más que su solo. | **Solo-Calmar Purist** — primero el mérito individual; el uplift depende de con quién lo combines y eso cambia mañana. |

## BLOQUE G — OPERACIONAL / META (pares 46-50, peso 2.5%)

| # | Topic | TESIS | ANTÍTESIS |
|---|---|---|---|
| 46 | Frescura de data VPS vs Historia | **Data-Freshness Warden** — snapshot de su VPS fresco y sin `partial_data`: números viejos = veredicto viejo. | **Historical-Weight Keeper** — un lag de horas no cambia meses de historia; descalificar por frescura es burocracia. |
| 47 | Score institucional vs Retail | **Institutional Grader** — bloque `institutional`: métricas de fondo (consistency, risk-adjusted, capacity) — así se elige un gestor de verdad. | **Retail-Metrics Defender** — esto es una flotilla de EAs en demo, no un fondo; PF/WR/DD son el idioma correcto del problema. |
| 48 | Radar equilibrado vs Pico especialista | **Radar-Balance Judge** — `promotion_radar.shape_label` equilibrado: sin eje flojo que lo mate en real. | **Peak-Specialist Backer** — el área del radar la ganan los picos; el "equilibrado" mediocre en todo no gana dinero en nada. |
| 49 | Asimetría del radar vs Área total | **Asymmetry Detector** — `promotion_radar.asymmetry` alta = un solo eje carga todo el peso: fragilidad estructural. | **Area Maximalist** — `promotion_radar.area_pct` total: la cantidad de excelencia acumulada manda sobre su reparto. |
| 50 | Incertidumbre total vs Convicción | **Uncertainty Quantifier** — suma TODAS las fuentes de duda (CI anchos, n chico, drift, shrinkage gap): el podio debe ser robusto a la duda. | **Conviction Closer** — la duda infinita nunca elige; con la evidencia disponible HOY, el que más señales positivas apila gana. Cierra el trato. |

---

## Roles extra (fuera de los pares)

- **Devil's Advocate** — inmune a poda; no defiende lente alguno: ataca el consenso emergente del ranking (¿qué se está dando por bueno sin pelea?).
- **Domain Outsider** — gestor de riesgo institucional + auditor de fondos, ajeno al mundo EA/forex retail: cuestiona supuestos base (demo≠real: fills/slippage/spread; survivorship bias de la flotilla; ¿por qué 3 y no 1 o 5?).
- **Juez Supremo (agente máximo)** — consolida con pesos por bloque (A 35% · B 20% · C 15% · D 15% · E 10% · F 2.5% · G 2.5%), registra disensos sin promediarlos, produce podio top-3 + 2 suplentes.
- **Adversarial Validator** — ataca la síntesis del juez: toda afirmación sin respaldo en expediente/debate muere.
- **Gate determinístico** — `scripts/verify_verdict.py`: barrido de dominancia del podio contra TODA la cohorte demo viva.

## Modo `core` (12 pares para corridas rápidas)

Pares: 1, 3, 4, 7, 11, 14, 19, 21, 26, 30, 33, 41.
