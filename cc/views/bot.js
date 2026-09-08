// cc/views/bot.js — Bot 360.
//
// Diez secciones (A..J) con divulgacion progresiva: la primera abierta y el
// resto plegado. Cada una responde primero la DECISION y despues la evidencia.
//
// Reglas que aqui no se rompen:
//  · el per-bot NUNCA se copia dentro del objeto del snapshot (el modal legacy
//    si lo hace, app.js:2042-2049, y por eso los resultados de una consulta
//    dependian del historial de navegacion);
//  · SL/TP no existen en los trades cerrados del broker: se pinta '—', jamas 0;
//  · score_v1 y score_v2 se muestran lado a lado y v2 va etiquetado SOMBRA,
//    porque ningun asiento lo consume todavia.

import { esc, usd, int, num, pct, pf, dateTime, unixShort, signClass, vpsName } from '../ui/fmt.js';
import { metric, metricGrid, emptyState, bar } from '../ui/kpi.js';
import { badge, statusBadge, stageBadge, confidenceBadge, symbolBadges, realBadge } from '../ui/badge.js';
import { freshnessBadge } from '../ui/freshness-badge.js';
import { accordion, wireAccordion, openSection } from '../ui/accordion.js';
import { createVTable } from '../ui/vtable.js';
import { loadBot } from '../data/perbot.js';
import { getCorrelations } from '../data/correlations.js';
import { findBot, findAccount, realLogins, honestNet, botKeyOf } from '../data/model.js';

let elRef = null;
let ctxRef = null;
let unwire = null;
let tradesTable = null;
let token = 0;

export function mount(el, params, ctx) {
  elRef = el; ctxRef = ctx;
  const my = ++token;
  const { vps, login, magic } = params.params;
  ctx.layout.setTitle(`Bot ${magic}`);
  ctx.layout.setExtra(freshnessBadge(ctx.meta()));

  const snap = ctx.snapshot();
  const bot = snap ? findBot(snap, vps, login, magic) : null;
  if (!bot) {
    el.innerHTML = emptyState('Bot no encontrado en este ciclo',
      `No hay ningun bot ${vps}/${login}/${magic} en data/snapshot.json. Puede haber dejado de operar o cambiado de cuenta.`, true);
    return;
  }

  el.innerHTML = `<div class="cc-stack"><div class="cc-skeleton" style="height:120px"></div></div>`;

  // [FIX 2026-09-08] loadBot() no llevaba catch: si el archivo per-bot no se
  // podia leer, la promesa quedaba rechazada sin manejar y la vista se quedaba
  // en el esqueleto PARA SIEMPRE, sin decir nada. Es el mismo fallo que dejaba
  // colgada la DNA Card del dashboard legacy. Ahora se pinta igual con lo que
  // hay en el snapshot y el detalle que falta se anuncia.
  Promise.all([
    loadBot(vps, login, magic).catch((err) => {
      console.error('[cc] per-bot ilegible', err);
      return null;
    }),
    getCorrelations().catch(() => null),
  ]).then(([detail, corr]) => {
    if (my !== token) return;   // el usuario ya navego a otra ruta
    render(bot, detail, corr, params.query || {});
  }).catch((err) => {
    if (my !== token) return;
    console.error('[cc] bot 360 fallo al pintarse', err);
    el.innerHTML = emptyState('No se pudo abrir el Bot 360',
      (err && err.message) || String(err), true);
  });
}

export function unmount() {
  token++;
  if (unwire) { unwire(); unwire = null; }
  if (tradesTable) { tradesTable.destroy(); tradesTable = null; }
  elRef = null; ctxRef = null;
}

function render(bot, detail, corr, query) {
  const snap = ctxRef.snapshot();
  const logins = realLogins(snap);
  const isReal = logins.has(bot.account_login);
  const acc = findAccount(snap, bot.vps, bot.account_login);
  const d = detail && detail.data;

  const sections = [
    { key: 'A', title: 'AHORA', html: sectionNow(bot, acc, snap, isReal), open: true },
    { key: 'B', title: 'RENDIMIENTO', html: sectionPerformance(bot, snap) },
    { key: 'C', title: 'RIESGO', html: sectionRisk(bot, acc) },
    { key: 'D', title: 'ROBUSTEZ', html: sectionRobustness(bot) },
    { key: 'E', title: 'OPERACIONES', html: `<div id="cc-trades"></div>` },
    { key: 'F', title: 'EQUITY', html: sectionEquity(d, detail) },
    { key: 'G', title: 'CORRELACION', html: sectionCorrelation(bot, corr, logins, snap) },
    { key: 'H', title: 'PROMOCION', html: sectionPromotion(bot, snap) },
    { key: 'I', title: 'LINEA DE TIEMPO', html: sectionTimeline(bot, d) },
    { key: 'J', title: 'JSON CRUDO', html: sectionRaw(bot, d, detail) },
  ];

  elRef.innerHTML = `
    ${header(bot, acc, isReal, detail)}
    ${accordion(sections)}`;

  unwire = wireAccordion(elRef, (key) => { if (key === 'E') mountTrades(d); });
  if (query.section) openSection(elRef, String(query.section).toUpperCase());
  elRef.querySelectorAll('[data-go]').forEach((n) => {
    n.addEventListener('click', () => { location.hash = n.dataset.go; });
  });
  // Si el deep link abre E, la tabla se monta ya.
  if (String(query.section || '').toUpperCase() === 'E') mountTrades(d);
}

// --------------------------------------------------------------------- header

function header(b, acc, isReal, detail) {
  const lc = b.lifecycle || {};
  return `<section class="cc-card${isReal ? ' cc-card--real' : ''}">
    <div class="cc-card__head">
      <h1 style="font-size:var(--cc-fs-xl)">Bot <span class="cc-mono">${esc(b.magic)}</span></h1>
      ${realBadge(isReal)}
      ${statusBadge(b.promotion_status)}
      ${stageBadge(lc.stage, lc.historical_reason)}
      ${b.dormant ? badge(`dormido ${b.days_since_last_trade ?? '?'} d`, 'warn') : ''}
      ${b.decay_flag ? badge('decay', 'neg') : ''}
      ${b.drift && b.drift.flag ? badge(`drift ${num(b.drift.severity)}×`, 'warn') : ''}
      <span class="cc-card__spacer"></span>
      ${freshnessBadge(detail ? detail.meta : { status: 'offline' }, { label: 'detalle' })}
    </div>
    <div class="cc-row cc-small cc-muted">
      <span>${symbolBadges(b.symbols)}</span>
      <span>·</span>
      <a href="#/account/${esc(b.vps)}/${esc(b.account_login)}">cuenta #${esc(b.account_login)}</a>
      <span>·</span>
      <a href="#/health">${esc(vpsName(b.vps))}</a>
      ${acc && acc.server ? `<span>·</span><span>${esc(acc.server)}</span>` : ''}
      <span>·</span>
      <span>clave <code>${esc(botKeyOf(b))}</code></span>
      <span>·</span>
      <span>ultimo trade ${esc(dateTime(b.last_trade))}</span>
      ${b.gm_id ? `<span>·</span><span>gm <code>${esc(b.gm_id)}</code></span>` : ''}
    </div>
  </section>`;
}

// ------------------------------------------------------------------ A · AHORA

function sectionNow(b, acc, snap, isReal) {
  const positions = ((snap.real_portfolio || {}).open_positions || [])
    .filter((p) => String(p.login) === String(b.account_login) && String(p.magic) === String(b.magic));
  const floating = positions.reduce((s, p) => s + (Number(p.profit) || 0), 0);
  const volume = positions.reduce((s, p) => s + (Number(p.volume) || 0), 0);

  const alerts = [];
  if (b.decay_flag) alerts.push(`decay_ratio ${num(b.decay_ratio)} (pendiente 90d ${num(b.slope_recent_90d, 4)} vs lifetime ${num(b.slope_lifetime, 4)})`);
  if (b.drift && b.drift.flag) alerts.push(`drift severidad ${num(b.drift.severity)}×`);
  if (b.dormant) alerts.push(`sin operar hace ${b.days_since_last_trade ?? '?'} dias`);
  if (b.trade_distribution && b.trade_distribution.profile === 'LOTTERY') alerts.push('distribucion de resultados tipo loteria');
  if (b.tracker && b.tracker.verdict === 'BELOW') alerts.push('el forward tracker lo ve por debajo de lo esperado');

  return `
    ${metricGrid([
      metric('Posiciones abiertas', int(positions.length), '', isReal ? '' : 'Solo se publican posiciones de las cuentas reales'),
      metric('Flotante', positions.length ? usd(floating, true) : '—', signClass(floating)),
      metric('Volumen abierto', positions.length ? num(volume) : '—'),
      metric('Ultimo trade', dateTime(b.last_trade)),
      metric('Dias sin operar', b.days_since_last_trade == null ? '—' : String(b.days_since_last_trade), b.dormant ? 'cc-warn' : ''),
      metric('Trades 30d', int(b.trades_30d)),
      metric('Trades 90d', int(b.trades_90d)),
      metric('Net 7d', usd(b.net_7d, true), signClass(b.net_7d)),
    ])}
    ${alerts.length
      ? `<div class="cc-banner cc-banner--warn"><div><strong>Anomalias detectadas</strong><ul class="cc-small">${alerts.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div></div>`
      : `<div class="cc-banner cc-banner--ok">Sin anomalias marcadas en este ciclo.</div>`}
    ${positions.length ? positionsTable(positions) : ''}`;
}

function positionsTable(positions) {
  return `<div class="cc-scroll-x"><table class="cc-table">
    <thead><tr><th>Ticket</th><th>Simbolo</th><th>Tipo</th><th class="num">Vol</th>
      <th class="num">Apertura</th><th class="num">Actual</th><th class="num">SL</th><th class="num">TP</th>
      <th class="num">Flotante</th><th>Abierta</th></tr></thead>
    <tbody>${positions.map((p) => `<tr>
      <td class="cc-mono">${esc(p.ticket)}</td>
      <td>${esc(p.symbol)}</td>
      <td>${esc(p.type)}</td>
      <td class="num">${num(p.volume)}</td>
      <td class="num">${num(p.price_open, 5)}</td>
      <td class="num">${num(p.price_current, 5)}</td>
      <td class="num">${p.sl ? num(p.sl, 5) : '—'}</td>
      <td class="num">${p.tp ? num(p.tp, 5) : '—'}</td>
      <td class="num ${signClass(p.profit)}">${esc(usd(p.profit, true))}</td>
      <td>${esc(dateTime(p.time_open))}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ------------------------------------------------------------ B · RENDIMIENTO

function sectionPerformance(b, snap) {
  const mm = snap.metrics_meta || null;
  const has365 = b.net_profit_365d != null || b.months_active_365d != null;
  return `
    ${metricGrid([
      metric('Net (365 d)', usd(b.net_profit_365d ?? b.net_profit, true), signClass(b.net_profit_365d ?? b.net_profit)),
      metric('Net lifetime', usd(b.net_profit_lifetime, true), signClass(b.net_profit_lifetime)),
      metric('Net sin comision', usd(b.net_after_commission, true), signClass(b.net_after_commission), 'net_after_commission: el que decide promociones'),
      metric('Profit factor', pf(b.profit_factor)),
      metric('Win rate', pct(b.win_rate_pct)),
      metric('Expectancy', usd(b.expectancy, true), signClass(b.expectancy)),
      metric('Trades', int(b.trades)),
      metric('Ganadas / perdidas', `${int(b.wins)} / ${int((b.trades || 0) - (b.wins || 0))}`),
      metric('Trades por mes', num(b.trades_per_month, 1)),
      metric('Meses activo (365 d)', num(b.months_active_365d ?? b.months_active, 1)),
      metric('Meses activo lifetime', num(b.months_active_lifetime, 1)),
      metric('Meses positivos', pct(b.months_positive_pct)),
      metric('Ganancia media', usd(b.avg_win, true), 'cc-pos'),
      metric('Perdida media', usd(b.avg_loss, true), 'cc-neg'),
      metric('Mejor trade', usd(b.best_trade, true), 'cc-pos'),
      metric('Peor trade', usd(b.worst_trade, true), 'cc-neg'),
      metric('Retorno mensual', pct(b.return_monthly_pct_365d ?? b.return_monthly_pct_lifetime)),
      metric('Primer trade', dateTime(b.first_trade)),
    ])}
    ${mm ? `<p class="cc-xs cc-faint">Contrato de ventanas (metrics_meta v${mm.schema}): los campos con sufijo aplican
      <code>${esc((mm.commission_policy || {}).suffixed_lifetime || '')}</code>; los legacy sin sufijo,
      <code>${esc((mm.commission_policy || {}).unsuffixed_legacy || '')}</code>. Ventana canonica ${esc(mm.window_days)} dias.</p>`
      : `<p class="cc-xs cc-faint">Este ciclo no trae <code>metrics_meta</code>: los campos sin sufijo siguen la convencion legacy.</p>`}
    ${!has365 ? `<p class="cc-xs cc-faint">Sin campos <code>*_365d</code> en este bot — se muestran los valores sin sufijo tal cual llegan.</p>` : ''}`;
}

// ------------------------------------------------------------------ C · RIESGO

function sectionRisk(b, acc) {
  const inst = b.institutional || {};
  const stress = b.stress || {};
  const uw = b.underwater || {};
  const bal = acc && acc.balance;
  return `
    ${metricGrid([
      metric('Drawdown maximo', usd(b.max_drawdown), 'cc-neg'),
      metric('DD % del balance', pct(b.dd_pct_of_balance), (b.dd_pct_of_balance ?? 0) > 10 ? 'cc-neg' : ''),
      metric('Recovery factor', num(b.recovery_factor)),
      metric('Calmar', num(b.calmar)),
      metric('Sharpe anualizado', num(b.sharpe_annualized)),
      metric('Sortino', num(b.sortino)),
      metric('Perdidas seguidas', int(b.max_consecutive_losses)),
      metric('Ganancias seguidas', int(b.max_consecutive_wins)),
      metric('CVaR 95', inst.cvar_95 == null ? '—' : usd(inst.cvar_95, true), 'cc-neg'),
      metric('VaR 95', inst.var_95 == null ? '—' : usd(inst.var_95, true), 'cc-neg'),
      metric('Monte Carlo p95 DD', stress.mc_dd_p95 == null ? '—' : usd(stress.mc_dd_p95), 'cc-neg'),
      metric('Prob. de ruina', stress.prob_ruin == null ? '—' : pct(stress.prob_ruin * 100)),
      metric('Dias bajo el agua', uw.max_days == null ? '—' : String(uw.max_days)),
      metric('Balance de la cuenta', bal == null ? '—' : usd(bal)),
    ])}
    ${b.dd_pct_of_balance != null ? `
      <div>
        <div class="cc-xs cc-faint">DD sobre balance vs el tope del gate (${esc(num(10, 0))}%)</div>
        ${bar(Math.min(1, (b.dd_pct_of_balance || 0) / 10), b.dd_pct_of_balance > 10 ? 'crit' : b.dd_pct_of_balance > 7 ? 'warn' : 'pos')}
      </div>` : ''}
    ${Object.keys(stress).length === 0 && Object.keys(inst).length === 0
      ? `<p class="cc-xs cc-faint">Este bot no trae bloques <code>stress</code> ni <code>institutional</code> en el ciclo: las celdas de arriba quedan en '—' en vez de rellenarse con ceros.</p>` : ''}`;
}

// --------------------------------------------------------------- D · ROBUSTEZ

function sectionRobustness(b) {
  const oos = b.oos || {};
  const ci = b.confidence_intervals || {};
  const drift = b.drift || {};
  const cap = b.capacity || {};
  const reg = b.regime || {};
  return `
    ${metricGrid([
      metric('OOS · net', oos.oos_net == null ? '—' : usd(oos.oos_net, true), signClass(oos.oos_net)),
      metric('OOS · ratio', num(oos.oos_ratio)),
      metric('OOS · veredicto', oos.verdict || '—'),
      metric('IC 95 net (bajo)', ci.net_p5 == null ? '—' : usd(ci.net_p5, true)),
      metric('IC 95 net (alto)', ci.net_p95 == null ? '—' : usd(ci.net_p95, true)),
      metric('Decay ratio', num(b.decay_ratio), b.decay_flag ? 'cc-neg' : ''),
      metric('Pendiente 90d', num(b.slope_recent_90d, 4)),
      metric('Pendiente lifetime', num(b.slope_lifetime, 4)),
      metric('Drift severidad', drift.severity == null ? '—' : `${num(drift.severity)}×`, drift.flag ? 'cc-warn' : ''),
      metric('Estabilidad (R²)', num(b.stability_score, 3)),
      metric('Mejora 30d-90d', num(b.improvement, 3)),
      metric('Capacidad', (b.capacity_usd ?? cap.capacity_usd) == null ? '—' : usd(b.capacity_usd ?? cap.capacity_usd)),
      metric('Regimen dominante', reg.dominant || '—'),
      metric('Evidencia', b.evidence_tier || 'UNKNOWN', b.evidence_tier === 'MEASURED' ? 'cc-pos' : ''),
      metric('Score cientifico', num(b.scientific_score, 1)),
      metric('Racha en READY', b.ready_streak_days == null ? '—' : `${b.ready_streak_days} d`),
    ])}
    ${b.decay_flag ? `<div class="cc-banner cc-banner--warn">
      <div><strong>Deterioro marcado</strong>
      <span class="cc-small">La pendiente reciente de la equity (${esc(num(b.slope_recent_90d, 4))} USD/dia) es negativa o menor que el 30% de la pendiente de por vida (${esc(num(b.slope_lifetime, 4))}). Es la regla de <code>decay_flag</code> del builder, no una interpretacion.</span></div>
    </div>` : ''}`;
}

// ---------------------------------------------------------- E · OPERACIONES

function mountTrades(detail) {
  const host = elRef && elRef.querySelector('#cc-trades');
  if (!host || host.dataset.mounted === '1') return;
  host.dataset.mounted = '1';

  const trades = (detail && Array.isArray(detail.trades)) ? detail.trades : null;
  if (!trades) {
    host.innerHTML = emptyState('Sin fichero de detalle',
      'data/bots/<vps>/<login>-<magic>.json no esta disponible, asi que no hay lista de operaciones que mostrar.');
    return;
  }
  if (!trades.length) {
    host.innerHTML = emptyState('Sin operaciones cerradas', 'El detalle existe pero su lista de trades esta vacia.');
    return;
  }

  host.innerHTML = `
    <div class="cc-row">
      <input id="tr-q" class="cc-input" type="search" placeholder="Ticket, simbolo…">
      <select class="cc-select" id="tr-side">
        <option value="all">Compra y venta</option><option value="BUY">Solo compras</option><option value="SELL">Solo ventas</option>
      </select>
      <select class="cc-select" id="tr-res">
        <option value="all">Cualquier resultado</option><option value="win">Ganadoras</option><option value="loss">Perdedoras</option>
      </select>
      <span class="cc-xs cc-faint">SL y TP no existen en los deals cerrados del broker: se muestra '—', no un 0 inventado.</span>
    </div>
    <div id="tr-table"></div>`;

  const table = createVTable(host.querySelector('#tr-table'), {
    rowHeight: 30,
    height: 'min(52vh, 480px)',
    columns: [
      { key: 'n', label: '#', width: 60, align: 'num', sortable: false, text: (r, i) => String(i + 1) },
      { key: 'ticket', label: 'Ticket', width: 110, text: (r) => String(r.ticket ?? '—') },
      { key: 'symbol', label: 'Simbolo', width: 110, text: (r) => String(r.symbol ?? '—') },
      { key: 'type', label: 'Tipo', width: 80, text: (r) => String(r.type ?? r.side ?? '—') },
      { key: 'volume', label: 'Vol', width: 70, align: 'num', text: (r) => num(r.volume) },
      { key: 'open_time', label: 'Apertura', width: 130, align: 'num', text: (r) => unixShort(r.open_time) },
      { key: 'close_time', label: 'Cierre', width: 130, align: 'num', text: (r) => unixShort(r.close_time) },
      { key: 'price_open', label: 'Precio ent.', width: 100, align: 'num', text: (r) => num(r.price_open, 5) },
      { key: 'price_close', label: 'Precio sal.', width: 100, align: 'num', text: (r) => num(r.price_close, 5) },
      { key: 'sl', label: 'SL', width: 70, align: 'num', sortable: false, text: () => '—' },
      { key: 'tp', label: 'TP', width: 70, align: 'num', sortable: false, text: () => '—' },
      { key: 'commission', label: 'Comision', width: 92, align: 'num', text: (r) => usd(r.commission, true) },
      { key: 'swap', label: 'Swap', width: 84, align: 'num', text: (r) => usd(r.swap, true) },
      { key: 'net', label: 'Neto', width: 108, align: 'num',
        render: (r) => `<span class="${signClass(r.net)}">${esc(usd(r.net, true))}</span>` },
    ],
    emptyHtml: '<strong>Sin operaciones</strong>Ninguna cumple estos filtros.',
  });
  tradesTable = table;

  const apply = () => {
    const q = host.querySelector('#tr-q').value.trim().toLowerCase();
    const side = host.querySelector('#tr-side').value;
    const res = host.querySelector('#tr-res').value;
    let rows = trades;
    if (q) rows = rows.filter((t) => String(t.ticket).includes(q) || String(t.symbol || '').toLowerCase().includes(q));
    if (side !== 'all') rows = rows.filter((t) => String(t.type || t.side || '').toUpperCase() === side);
    if (res !== 'all') rows = rows.filter((t) => (res === 'win' ? (t.net || 0) > 0 : (t.net || 0) <= 0));
    table.setRows(rows);
  };
  host.querySelector('#tr-q').addEventListener('input', apply);
  host.querySelector('#tr-side').addEventListener('change', apply);
  host.querySelector('#tr-res').addEventListener('change', apply);
  table.setRows(trades.slice().reverse());   // lo mas reciente primero
  table.sortBy('close_time', 'desc');
}

// ------------------------------------------------------------------ F · EQUITY

function sectionEquity(d, detail) {
  const series = (d && d.daily_equity_series) || null;
  if (!series || !series.length) {
    return emptyState('Sin serie de equity',
      detail && detail.meta && detail.meta.status === 'error'
        ? `El detalle no se pudo leer (${detail.meta.error || 'error de red'}).`
        : 'El per-bot no trae daily_equity_series en este ciclo.');
  }
  const last = series[series.length - 1];
  const peakDD = series.reduce((m, r) => Math.max(m, Number(r.dd_pct) || 0), 0);
  return `
    ${metricGrid([
      metric('Dias con operativa', int(series.length)),
      metric('Primer dia', series[0].date),
      metric('Ultimo dia', last.date),
      metric('Acumulado', usd(last.cum_net, true), signClass(last.cum_net)),
      metric('Pico acumulado', usd(last.peak, true)),
      metric('DD actual', usd(last.dd_abs), last.dd_abs > 0 ? 'cc-neg' : ''),
      metric('DD % actual', pct(last.dd_pct), last.dd_pct > 10 ? 'cc-neg' : ''),
      metric('DD % maximo', pct(peakDD), 'cc-neg'),
    ])}
    ${sparkline(series)}
    <p class="cc-xs cc-faint">Serie diaria del per-bot: <code>cum_net</code>, <code>dd_abs</code> y <code>dd_pct</code>
      calculados por el builder sobre el balance de la cuenta. Aqui no se recalcula ninguna metrica.</p>`;
}

/** SVG inline: sin librerias y sin bloquear el hilo con un canvas por bot. */
function sparkline(series) {
  const pts = series.map((r) => Number(r.cum_net) || 0);
  const n = pts.length;
  if (n < 2) return '';
  const min = Math.min(...pts, 0);
  const max = Math.max(...pts, 0);
  const span = (max - min) || 1;
  const W = 900, H = 160;
  const path = pts.map((v, i) => {
    const x = (i / (n - 1)) * W;
    const y = H - ((v - min) / span) * H;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const zeroY = H - ((0 - min) / span) * H;
  const color = pts[n - 1] >= 0 ? 'var(--cc-positive)' : 'var(--cc-negative)';
  return `<div class="cc-scroll-x"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
      style="width:100%;height:160px;display:block" role="img" aria-label="Equity acumulada">
    <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" stroke="var(--cc-border-strong)" stroke-width="1"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="1.6"/>
  </svg></div>`;
}

// ------------------------------------------------------------ G · CORRELACION

function sectionCorrelation(b, corr, logins, snap) {
  if (!corr || !corr.available) {
    return emptyState('Sin matriz de correlacion',
      'data/correlations.json no esta disponible en este ciclo.');
  }
  const key = botKeyOf(b);
  if (!corr.has(key)) {
    return `<div class="cc-banner cc-banner--info">Este bot no entra en la matriz: solo se correlacionan los
      ${esc(corr.botCount)} mejores con al menos ${esc(corr.minTrades)} trades y score de promocion
      (scripts/post_merge.py). No es un fallo, es el recorte del backend.</div>`;
  }

  const realKeys = new Set((snap.bots || [])
    .filter((x) => logins.has(x.account_login))
    .map(botKeyOf)
    .filter((k) => corr.has(k)));

  const top1 = corr.neighbors(key, { version: 'v1', limit: 8 });
  const maxReal1 = corr.maxAgainst(key, realKeys, 'v1');
  const maxReal2 = corr.maxAgainst(key, realKeys, 'v2');

  return `
    ${metricGrid([
      metric('ρ max vs reales (v1)', maxReal1 ? num(maxReal1.rho) : '—', maxReal1 && Math.abs(maxReal1.rho) > 0.7 ? 'cc-neg' : ''),
      metric('ρ max vs reales (v2, sombra)', maxReal2 ? num(maxReal2.rho) : '—', 'cc-info'),
      metric('Estimador vigente', corr.liveVersion || 'v1'),
      metric('Bots en la matriz', int(corr.botCount)),
    ])}
    ${maxReal1 && Math.abs(maxReal1.rho) > 0.7
      ? `<div class="cc-banner cc-banner--crit">ρ ${esc(num(maxReal1.rho))} contra <code>${esc(maxReal1.key)}</code>: por encima de 0.7 el gate duro <code>clones_real</code> lo bloquea.</div>` : ''}
    <div class="cc-scroll-x"><table class="cc-table">
      <thead><tr><th>Bot</th><th>Cuenta</th><th class="num">ρ v1</th><th class="num">ρ v2 (sombra)</th><th class="num">Dias solapados</th></tr></thead>
      <tbody>${top1.map((nb) => `<tr>
        <td><a href="#/bot/${esc((nb.bot || {}).vps)}/${esc((nb.bot || {}).login)}/${esc((nb.bot || {}).magic)}"><code>${esc(nb.key)}</code></a></td>
        <td>${realKeys.has(nb.key) ? badge('REAL', 'real') : badge('demo', 'neutral')}</td>
        <td class="num">${esc(num(nb.rho))}</td>
        <td class="num cc-info">${esc(num(corr.v2(key, nb.key)))}</td>
        <td class="num">${nb.overlap == null ? '—' : esc(int(nb.overlap))}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${corr.estimators ? `<p class="cc-xs cc-faint">
      v1: ${esc(corr.estimators.live)}<br>v2 (sombra, ningun gate lo lee todavia): ${esc(corr.estimators.shadow)}</p>` : ''}`;
}

// --------------------------------------------------------------- H · PROMOCION

function sectionPromotion(b, snap) {
  const pm = snap.promotion_meta || {};
  const sv = pm.score_versions || {};
  const gates = (b.promotion_gating || b.gating || null);
  const fails = b.promotion_fails || b.fails || [];
  const sm = b.shrinkage_meta;
  const comp = b.promotion_components || {};
  const comp2 = b.promotion_components_v2 || null;
  const weights = pm.weights || {};

  return `
    <div class="cc-row">
      ${statusBadge(b.promotion_status)}
      ${confidenceBadge(sm)}
      ${b.provisional_low_confidence ? badge('cupo provisional', 'warn', `Fallas de confianza: ${(b.trust_fails || []).join(', ') || '—'}`) : ''}
    </div>
    ${metricGrid([
      metric('Score v1 (vigente)', num(b.promotion_score, 1), 'cc-pos'),
      metric('Score v2 (SOMBRA)', num(b.promotion_score_v2, 1), 'cc-info',
        'No decide asientos: se publica para que el owner compare antes de autorizar el flip'),
      metric('Delta v2-v1', b.promotion_score_v2 == null || b.promotion_score == null ? '—' : num(b.promotion_score_v2 - b.promotion_score, 1), 'cc-info'),
      metric('Score ajustado', num(b.promotion_score_shrunk, 1)),
      metric('Net honesto', usd(honestNet(b), true), signClass(honestNet(b))),
    ])}
    ${whyProse(b, gates, fails, sm, pm)}
    ${comp2 ? componentsTable(comp, comp2, weights) : componentsTable(comp, null, weights)}
    ${gates ? gatesTable(gates, fails) : '<p class="cc-xs cc-faint">Este bot no trae el bloque de gates en el snapshot.</p>'}
    ${sv.v2 && sv.v2.diff ? `<div class="cc-banner cc-banner--info">
      <div><strong>Score v2 en sombra</strong>
      <span class="cc-small">n=${esc(sv.v2.diff.n_scored)} · delta medio ${esc(sv.v2.diff.mean_abs_delta)} ·
      p90 ${esc(sv.v2.diff.p90_abs_delta)} · max ${esc(sv.v2.diff.max_abs_delta)} ·
      coincidencia de asientos READY (jaccard) ${esc(sv.v2.diff.jaccard_ready)}.</span></div></div>` : ''}
    <p class="cc-xs cc-faint">Veto humano obligatorio: <code>human_veto_required = ${esc(String(pm.human_veto_required ?? true))}</code>.
      READY es una PROPUESTA. Ningun bot se promueve solo, y este panel no promueve nada.</p>`;
}

/** El "por que" en prosa, armado SOLO con gates, confianza y shrinkage. */
function whyProse(b, gates, fails, sm, pm) {
  const parts = [];
  const st = b.promotion_status;
  if (st === 'READY') parts.push(`Ocupa asiento READY con score ${num(b.promotion_score, 1)} sobre un pool de ${pm.pool_post_dedup ?? '?'} candidatos deduplicados.`);
  else if (st === 'NEAR') parts.push(`Esta en NEAR: pasa los gates duros pero su score (${num(b.promotion_score, 1)}) queda por debajo del corte de READY.`);
  else if (st === 'WATCH') parts.push(`Esta en WATCH: se le sigue la pista pero su score (${num(b.promotion_score, 1)}) no alcanza NEAR.`);
  else if (st === 'NO') parts.push('No es candidato: falla al menos un gate duro.');
  else parts.push('Sin estado de promocion en este ciclo.');

  if (Array.isArray(fails) && fails.length) parts.push(`Gates que no pasa: ${fails.join('; ')}.`);
  else if (gates) parts.push('Pasa los seis gates duros.');

  if (sm) {
    parts.push(`La confianza es ${String(sm.confidence || 'MEDIA').toUpperCase()}: el shrinkage bayesiano `
      + `${(sm.delta ?? 0) < 0 ? 'recorta' : 'sube'} el score en ${num(Math.abs(sm.delta ?? 0), 1)} puntos `
      + `usando ${sm.cohort_prior_used ? 'el prior de su cohorte' : 'el prior global'} con n=${sm.cohort_n ?? '?'} `
      + `(poca evidencia tira el score hacia la media, mucha lo deja donde esta).`);
  }
  if (Array.isArray(b.trust_fails) && b.trust_fails.length) {
    parts.push(`Fallas de confianza registradas: ${b.trust_fails.join(', ')}.`);
  }
  if (b.dormant) parts.push(`Lleva ${b.days_since_last_trade ?? '?'} dias sin operar, asi que la frescura lo saca de READY/NEAR.`);

  return `<div class="cc-card cc-card--flat">
    <span class="cc-card__title">Por que este bot esta donde esta</span>
    <p class="cc-small cc-muted" style="margin:0">${parts.map(esc).join(' ')}</p>
  </div>`;
}

function componentsTable(c1, c2, weights) {
  const keys = [...new Set([...Object.keys(c1 || {}), ...Object.keys(c2 || {})])];
  if (!keys.length) return '';
  return `<div class="cc-scroll-x"><table class="cc-table">
    <thead><tr><th>Componente</th><th class="num">Peso</th><th class="num">v1</th>${c2 ? '<th class="num">v2 (sombra)</th><th class="num">Δ</th>' : ''}</tr></thead>
    <tbody>${keys.map((k) => {
      const a = c1 ? c1[k] : null;
      const b2 = c2 ? c2[k] : null;
      return `<tr>
        <td><code>${esc(k)}</code></td>
        <td class="num">${weights[k] == null ? '—' : esc(num(weights[k], 3))}</td>
        <td class="num">${esc(num(a, 3))}</td>
        ${c2 ? `<td class="num cc-info">${esc(num(b2, 3))}</td><td class="num">${a == null || b2 == null ? '—' : esc(num(b2 - a, 3))}</td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function gatesTable(gates, fails) {
  const failSet = new Set(fails || []);
  return `<div class="cc-scroll-x"><table class="cc-table">
    <thead><tr><th>Gate duro</th><th>Resultado</th></tr></thead>
    <tbody>${Object.entries(gates).map(([k, v]) => `<tr>
      <td><code>${esc(k)}</code></td>
      <td>${v ? badge('pasa', 'pos') : badge('falla', 'neg')}</td>
    </tr>`).join('')}</tbody></table>
    ${failSet.size ? `<p class="cc-xs cc-neg">${[...failSet].map(esc).join(' · ')}</p>` : ''}</div>`;
}

// ---------------------------------------------------------------- I · TIMELINE

function sectionTimeline(b, d) {
  const events = [];
  if (b.first_trade) events.push({ ts: b.first_trade, text: 'Primer trade registrado' });
  const lc = b.lifecycle || {};
  if (lc.deployed_at) events.push({ ts: lc.deployed_at, text: `Desplegado (stage ${lc.stage || '—'})` });
  if (lc.promoted_at) events.push({ ts: lc.promoted_at, text: 'Promovido a cuenta real' });
  if (lc.retired_at) events.push({ ts: lc.retired_at, text: `Retirado (${lc.historical_reason || 'sin motivo declarado'})` });
  if (b.last_trade) events.push({ ts: b.last_trade, text: 'Ultimo trade registrado' });
  if (b.ready_streak_days) events.push({ ts: null, text: `Lleva ${b.ready_streak_days} dias seguidos en READY` });
  if (d && d.trade_count) events.push({ ts: null, text: `${int(d.trade_count)} operaciones en el fichero de detalle` });

  if (!events.length) {
    return emptyState('Sin eventos', 'El snapshot no trae fechas de ciclo de vida para este bot.');
  }
  events.sort((a, b2) => String(a.ts || '').localeCompare(String(b2.ts || '')));
  return `<ul class="cc-small cc-muted">${events.map((e) => `<li>
    <span class="cc-faint cc-mono">${esc(e.ts ? dateTime(e.ts) : '—')}</span> · ${esc(e.text)}</li>`).join('')}</ul>
    <p class="cc-xs cc-faint">La linea de tiempo completa (tabla <code>bot_events</code>) llega en la Fase 2 del blueprint;
      esto es lo que el snapshot de hoy puede sostener sin inventar nada.</p>`;
}

// --------------------------------------------------------------------- J · RAW

function sectionRaw(b, d, detail) {
  return `
    <div class="cc-row cc-xs cc-faint">
      <span>Snapshot: ${esc(Object.keys(b).length)} campos</span>
      <span>·</span>
      <span>Detalle: ${d ? `${esc(Object.keys(d).length)} campos` : 'no disponible'}</span>
      ${detail ? `<span>·</span>${freshnessBadge(detail.meta, { label: 'per-bot' })}` : ''}
    </div>
    <div class="cc-raw">${esc(JSON.stringify(b, null, 2))}</div>
    ${d ? `<div class="cc-raw">${esc(JSON.stringify(stripTrades(d), null, 2))}</div>` : ''}`;
}

/** Se omiten los trades del volcado: son miles y la seccion E ya los muestra. */
function stripTrades(d) {
  const { trades, daily_equity_series: series, ...rest } = d;
  return { ...rest, trades: `[${(trades || []).length} operaciones — ver seccion E]`,
    daily_equity_series: `[${(series || []).length} dias — ver seccion F]` };
}
