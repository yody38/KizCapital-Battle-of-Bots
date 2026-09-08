// cc/views/home.js — Command Center Home.
//
// Orden deliberado: primero QUE PASA (barra de estado), luego QUE SE SABE
// (brief de contadores derivados), luego QUE HAY QUE HACER (atencion), luego
// EL DINERO, y al final la flota. Ningun bloque emite una conclusion que no
// salga de un campo del snapshot: cada item de atencion lleva su evidencia
// numerica y la ruta donde comprobarla.

import { esc, usd, usdCompact, int, dateTime, signClass } from '../ui/fmt.js';
import { kpi, kpiRow, metric, metricGrid, emptyState } from '../ui/kpi.js';
import { badge } from '../ui/badge.js';
import { freshnessBadge, liveBadge } from '../ui/freshness-badge.js';
import { brief, globalState, attention, realPortfolio, isFundedRealAccount } from '../data/model.js';
import { humanAge } from '../data/freshness.js';

let unsubLive = null;
let ctxRef = null;
let elRef = null;

export function mount(el, params, ctx) {
  elRef = el;
  ctxRef = ctx;
  ctx.layout.setTitle('Home');
  ctx.layout.setExtra(freshnessBadge(ctx.meta()));
  render();
  unsubLive = ctx.live.subscribe(() => renderRealStrip());
  ctx.live.start();
}

export function unmount() {
  if (unsubLive) { unsubLive(); unsubLive = null; }
  elRef = null;
  ctxRef = null;
}

function render() {
  const ctx = ctxRef;
  const snap = ctx.snapshot();
  if (!snap) {
    elRef.innerHTML = emptyState(
      'No se pudo cargar el ciclo',
      `data/snapshot.json no respondio (${(ctx.meta() && ctx.meta().error) || 'sin detalle'}). Sin ese archivo el Command Center no tiene nada que mostrar; no se inventa ninguna cifra.`,
      true);
    return;
  }

  const fresh = ctx.live.freshness();
  const gs = globalState(snap, ctx.meta(), fresh);
  const b = brief(snap);
  const items = attention(snap, fresh, 8);

  elRef.innerHTML = `
    ${statusLine(gs, snap, ctx.meta(), fresh)}
    ${briefBlock(b, snap)}
    <section class="cc-stack">
      <div class="cc-section-title">
        <h2>Lo que necesita tu atencion</h2>
        <span class="cc-faint cc-small">${items.length ? `${items.length} de un maximo de 8, por prioridad` : 'nada pendiente'}</span>
      </div>
      ${items.length ? `<div class="cc-attention">${items.map(attnRow).join('')}</div>`
        : `<div class="cc-banner cc-banner--ok">Sin avisos: ninguna cuenta real desconectada, ninguna VPS atrasada y ningun bot real en deterioro en este ciclo.</div>`}
    </section>
    <section id="cc-home-real"></section>
    ${fleetBlock(b, snap)}
  `;
  renderRealStrip();

  elRef.querySelectorAll('[data-go]').forEach((node) => {
    node.addEventListener('click', () => { location.hash = node.dataset.go; });
  });
}

function statusLine(gs, snap, meta, fresh) {
  const cls = gs.state.toLowerCase();
  return `<section class="cc-statusline cc-statusline--${cls}">
    <span class="cc-statusline__state">${gs.state}</span>
    <span class="cc-muted cc-small">${gs.reasons.length ? esc(gs.reasons.slice(0, 3).join(' · ')) : 'todos los controles en verde'}</span>
    <span class="cc-topbar__spacer"></span>
    ${freshnessBadge(meta, { label: `ciclo ${humanAge(meta && meta.age_sec)}` })}
    ${liveBadge(fresh)}
    <span class="cc-faint cc-xs">ultimo ciclo ${esc(dateTime(snap.generated_at))}</span>
  </section>`;
}

function briefBlock(b, snap) {
  const sv = snap.promotion_meta && snap.promotion_meta.score_versions;
  return `<section class="cc-card">
    <div class="cc-card__head">
      <span class="cc-card__title">KIZ Intelligence Brief</span>
      <span class="cc-card__spacer"></span>
      <span class="cc-faint cc-xs">contadores derivados del ciclo — ninguna inferencia</span>
    </div>
    ${metricGrid([
      metric('Monitorizados', int(b.monitorizados), '', 'Bots con magic distinto de 0 en el snapshot'),
      metric('Sanos', int(b.sanos), 'cc-pos', 'net tras comision > 0, sin decay, sin drift y no dormidos'),
      metric('En watch', int(b.watch), 'cc-warn', 'promotion_status = WATCH'),
      metric('Deteriorandose', int(b.deteriorando), b.deteriorando ? 'cc-neg' : '', 'decay_flag = true'),
      metric('Anomalias', int(b.anomalias), b.anomalias ? 'cc-warn' : '', 'drift, distribucion tipo loteria o tracker BELOW'),
      metric('Dormidos', int(b.dormidos), b.dormidos ? 'cc-warn' : '', 'sin operar por encima del umbral'),
      metric('Nuevos', int(b.nuevosCandidatos), '', 'lifecycle.stage = NEW'),
      metric('Avisos de infra', int(b.vpsProblema), b.vpsProblema ? 'cc-warn' : '', 'VPS ausentes, atrasadas, ilegibles o heredadas'),
    ])}
    ${sv ? `<div class="cc-row cc-xs cc-faint">
      <span>Score vigente <strong>${esc(sv.live || 'v1')}</strong></span>
      ${sv.v2 && sv.v2.diff ? badge(`sombra v2 · Δ medio ${sv.v2.diff.mean_abs_delta} · jaccard READY ${sv.v2.diff.jaccard_ready}`, 'shadow', (sv.v2.changelog && JSON.stringify(sv.v2.changelog).slice(0, 400)) || '') : ''}
    </div>` : ''}
  </section>`;
}

function attnRow(it) {
  const tone = it.kind === 'CRITICAL' ? 'crit'
    : it.kind === 'WARNING' ? 'warn'
    : it.kind === 'INFRA' ? 'info'
    : it.kind === 'OPPORTUNITY' ? 'pos' : 'accent';
  return `<a class="cc-attn cc-attn--${it.kind}" href="${esc(it.route)}">
    ${badge(it.kind, tone)}
    <span class="cc-attn__body">
      <span class="cc-attn__title">${esc(it.title)}</span><br>
      <span class="cc-attn__ev">${esc(it.evidence)}</span>
    </span>
    <span class="cc-attn__go" aria-hidden="true">›</span>
  </a>`;
}

/** Franja de dinero real: se repinta con cada tick del stream. */
function renderRealStrip() {
  if (!elRef || !ctxRef) return;
  const host = elRef.querySelector('#cc-home-real');
  if (!host) return;
  const snap = ctxRef.snapshot();
  const rp = realPortfolio(snap);
  if (!rp.visible.length) {
    host.innerHTML = emptyState('Sin cuentas reales en el ciclo',
      'real_portfolio.accounts llego vacio o todas las cuentas tienen balance y equity en 0.');
    return;
  }
  const fresh = ctxRef.live.freshness();

  // CESTA FIJA: se parte de las cifras del snapshot (que ya incluyen las
  // heredadas) y solo se PISAN con el live cuando hay fila para esa cuenta.
  // Una cuenta sin push nunca sale de la suma; se marca.
  let balance = 0, equity = 0, floating = 0, margin = 0;
  let withLive = 0;
  for (const a of rp.visible) {
    const row = ctxRef.live.rowFor(a.login);
    const src = row || a;
    if (row) withLive++;
    balance += Number(src.balance) || 0;
    equity += Number(src.equity) || 0;
    floating += Number(src.profit) || 0;
    margin += Number(src.margin) || 0;
  }
  const positions = rp.positions.length;

  host.innerHTML = `<div class="cc-real-strip${fresh.unverified ? ' cc-live-unverified' : ''}">
    <div class="cc-real-strip__head">
      <span class="cc-real-strip__title">Dinero real</span>
      ${badge(`${rp.visible.length} cuenta${rp.visible.length === 1 ? '' : 's'}`, 'real')}
      ${rp.expectedCount && rp.accounts.length < rp.expectedCount
        ? badge(`cesta incompleta ${rp.accounts.length}/${rp.expectedCount}`, 'crit') : ''}
      ${rp.disconnected.length ? badge(`${rp.disconnected.length} desconectada(s) · heredadas en la suma`, 'warn') : ''}
      ${fresh.unverified ? badge('NO VERIFICADO', 'crit', `El stream lleva >= ${fresh.unverifiedSec} s sin confirmar estas cifras`) : ''}
      <span class="cc-card__spacer"></span>
      ${liveBadge(fresh)}
      <button class="cc-btn cc-btn--ghost" data-go="#/real" type="button">Ver Dinero real ›</button>
    </div>
    ${kpiRow([
      { label: 'Balance', value: usd(balance), real: true },
      { label: 'Equity', value: usd(equity), real: true },
      { label: 'Flotante', value: usd(floating, true), real: true, tone: signClass(floating) },
      { label: 'Margen usado', value: usd(margin), real: true, small: true },
      { label: 'Posiciones abiertas', value: int(positions), real: true, small: true },
      { label: 'Con push en vivo', value: `${withLive}/${rp.visible.length}`, real: true, small: true,
        hint: withLive < rp.visible.length ? 'el resto muestra su ultimo dato conocido' : '' },
    ])}
  </div>`;
  host.querySelectorAll('[data-go]').forEach((n) => {
    n.addEventListener('click', () => { location.hash = n.dataset.go; });
  });
}

function fleetBlock(b, snap) {
  const rp = realPortfolio(snap);
  const p = snap.portfolio || {};
  const vpsTotal = b.vps || Object.keys(snap.vps_freshness || {}).length;
  const vpsOk = vpsTotal - b.vpsProblema;
  const demoEquity = (snap.accounts || [])
    .filter((a) => !a.is_real && isFundedRealAccount(a))
    .reduce((s, a) => s + (Number(a.equity) || 0), 0);
  return `<section class="cc-stack">
    <div class="cc-section-title">
      <h2>Flota</h2>
      <a class="cc-small" href="#/fleet">explorar los ${int(b.monitorizados)} bots ›</a>
    </div>
    ${kpiRow([
      { label: 'Bots', value: int(b.monitorizados), hint: `${int(b.demo)} demo · ${int(b.reales)} real`, small: true },
      { label: 'Cuentas', value: int(b.cuentas), hint: `${int(b.cuentasReales)} reales`, small: true },
      { label: 'VPS sanas', value: `${vpsOk}/${vpsTotal}`, small: true, tone: b.vpsProblema ? 'cc-warn' : 'cc-pos' },
      { label: 'Operaciones cerradas', value: int(b.trades), small: true },
      { label: 'Equity demo', value: usdCompact(demoEquity), small: true },
      { label: 'Posiciones reales', value: int(rp.positions.length), small: true },
      { label: 'READY / NEAR', value: `${b.ready} / ${b.near}`, small: true },
      { label: 'Ventana de ranking', value: `${p.window_days ?? snap.window_days ?? 365} d`, small: true },
    ])}
  </section>`;
}
