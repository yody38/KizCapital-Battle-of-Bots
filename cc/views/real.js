// cc/views/real.js — Dinero real.
//
// LA regla de esta vista (2026-08-20, orden del owner): la cesta es FIJA. Una
// cuenta que no publica se muestra MARCADA y sus cifras del ultimo ciclo con
// dato SIGUEN sumando. Si saliera de la suma, el dashboard publicaria como
// perdida el equity de una cuenta que nadie perdio — paso de verdad cuando
// VPS3 se reinicio y quedo 1 real de 5.
//
// Y el fail-closed: cuando la fila mas vieja del stream pasa de 30 s, estas
// cifras ya no se pueden verificar en tiempo real. Se atenuan y se marcan
// NO VERIFICADO en vez de seguir pintandolas como si fueran de ahora.

import { esc, usd, int, num, dateTime, signClass, vpsName } from '../ui/fmt.js';
import { kpiRow, metric, metricGrid, emptyState } from '../ui/kpi.js';
import { badge } from '../ui/badge.js';
import { freshnessBadge, liveBadge } from '../ui/freshness-badge.js';
import { realPortfolio, realLogins, exposureBySymbol } from '../data/model.js';

let elRef = null;
let ctxRef = null;
let unsub = null;

export function mount(el, params, ctx) {
  elRef = el; ctxRef = ctx;
  ctx.layout.setTitle('Dinero real');
  ctx.layout.setExtra(freshnessBadge(ctx.meta()));
  render();
  unsub = ctx.live.subscribe(() => renderLiveParts());
  ctx.live.start();
}

export function unmount() {
  if (unsub) { unsub(); unsub = null; }
  elRef = null; ctxRef = null;
}

function render() {
  const snap = ctxRef.snapshot();
  if (!snap) {
    elRef.innerHTML = emptyState('Sin ciclo', 'data/snapshot.json no se pudo leer.', true);
    return;
  }
  const rp = realPortfolio(snap);
  if (!rp.visible.length) {
    elRef.innerHTML = emptyState('Sin cuentas reales visibles',
      'real_portfolio.accounts llego vacio o todas las cuentas tienen balance y equity en 0. No se muestran totales de una cesta que no existe.');
    return;
  }

  elRef.innerHTML = `
    <section class="cc-real-strip" id="rl-totals"></section>
    <section class="cc-stack">
      <div class="cc-section-title"><h2>Cuentas de la cesta</h2>
        <span class="cc-faint cc-small">clic para abrir la cuenta</span></div>
      <div class="cc-grid" id="rl-cards" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))"></div>
    </section>
    <section class="cc-stack">
      <div class="cc-section-title"><h2>Posiciones abiertas</h2>
        <span class="cc-faint cc-small">${int(rp.positions.length)} en la cesta</span></div>
      ${rp.positions.length ? positionsTable(rp.positions) : emptyState('Sin posiciones abiertas', 'La cesta no tiene ninguna operacion viva en este ciclo.')}
    </section>
    <section class="cc-stack">
      <div class="cc-section-title"><h2>Exposicion por simbolo</h2></div>
      ${exposureTable(rp.positions)}
    </section>
    <section class="cc-stack">
      <div class="cc-section-title"><h2>Bots en cuentas reales</h2></div>
      ${realBotsTable(snap)}
    </section>`;

  renderLiveParts();

  elRef.addEventListener('click', (ev) => {
    const card = ev.target.closest('[data-acct]');
    if (card) { location.hash = card.dataset.acct; return; }
    const row = ev.target.closest('[data-bot]');
    if (row) location.hash = row.dataset.bot;
  });
}

/** Totales + tarjetas: se repintan con cada tick del stream. */
function renderLiveParts() {
  if (!elRef || !ctxRef) return;
  const snap = ctxRef.snapshot();
  const rp = realPortfolio(snap);
  const fresh = ctxRef.live.freshness();

  let balance = 0, equity = 0, floating = 0, margin = 0, freeMargin = 0;
  let withLive = 0;
  const cards = [];

  for (const a of rp.visible) {
    const row = ctxRef.live.rowFor(a.login);
    // CESTA FIJA: el snapshot es el suelo. El live solo PISA los campos de la
    // cuenta que efectivamente publico; ninguna cuenta se cae de la suma.
    const src = row || a;
    if (row) withLive++;
    balance += Number(src.balance) || 0;
    equity += Number(src.equity) || 0;
    floating += Number(src.profit) || 0;
    margin += Number(src.margin) || 0;
    freeMargin += Number(src.free_margin ?? a.free_margin) || 0;
    cards.push(acctCard(a, row, fresh));
  }

  const totals = elRef.querySelector('#rl-totals');
  if (totals) {
    totals.className = 'cc-real-strip' + (fresh.unverified ? ' cc-live-unverified' : '');
    totals.innerHTML = `
      <div class="cc-real-strip__head">
        <span class="cc-real-strip__title">Cesta fija · ${rp.visible.length} cuenta${rp.visible.length === 1 ? '' : 's'}</span>
        ${rp.expectedCount ? badge(`esperadas ${rp.expectedCount}`, rp.accounts.length < rp.expectedCount ? 'crit' : 'real') : ''}
        ${rp.disconnected.length ? badge(`${rp.disconnected.length} desconectada(s)`, 'warn', 'Sus cifras son del ultimo ciclo con dato y SIGUEN en la suma') : ''}
        ${fresh.unverified ? badge('NO VERIFICADO', 'crit', `El stream lleva >= ${fresh.unverifiedSec} s sin confirmar estas cifras`) : ''}
        <span class="cc-card__spacer"></span>
        ${liveBadge(fresh)}
        <button class="cc-btn cc-btn--ghost" id="rl-refresh" type="button">Forzar lectura</button>
      </div>
      ${kpiRow([
        { label: 'Balance', value: usd(balance), real: true },
        { label: 'Equity', value: usd(equity), real: true },
        { label: 'Flotante', value: usd(floating, true), real: true, tone: signClass(floating) },
        { label: 'Margen usado', value: usd(margin), real: true, small: true },
        { label: 'Margen libre', value: usd(freeMargin), real: true, small: true },
        { label: 'Con push', value: `${withLive}/${rp.visible.length}`, real: true, small: true,
          hint: withLive < rp.visible.length ? 'las demas muestran su ultimo dato conocido' : '' },
      ])}
      ${fresh.unverified ? `<div class="cc-banner cc-banner--crit">
        <div><strong>NO VERIFICADO</strong><span class="cc-small"> · la fila mas vieja del stream tiene
        ${esc(fresh.age_sec == null ? '—' : fresh.age_sec.toFixed(0))} s (umbral ${esc(fresh.unverifiedSec)} s).
        Estas cifras podrian no ser las de ahora: se atenuan a proposito en vez de mostrarse como vivas.</span></div>
      </div>` : ''}
      ${rp.disconnected.length ? `<div class="cc-banner cc-banner--warn">
        <div><strong>${esc(rp.disconnected.length)} cuenta(s) desconectada(s)</strong><span class="cc-small"> ·
        ${esc(rp.disconnected.map((a) => `#${a.login} (dato de ${a.as_of ? dateTime(a.as_of) : 'el ciclo anterior'})`).join(', '))}.
        Siguen dentro de la suma por diseno: sacarlas publicaria una perdida que nadie tuvo.</span></div>
      </div>` : ''}`;
    const btn = totals.querySelector('#rl-refresh');
    if (btn) btn.addEventListener('click', () => ctxRef.live.refresh());
  }

  const host = elRef.querySelector('#rl-cards');
  if (host) host.innerHTML = cards.join('');
}

function acctCard(a, row, fresh) {
  const off = !!a.disconnected;
  const src = row || a;
  const stale = !row && !off;
  return `<div class="cc-acct-card${off ? ' is-off' : ''}${fresh.unverified ? ' cc-live-unverified' : ''}"
      data-acct="#/account/${esc(a.vps)}/${esc(a.login)}">
    <div class="cc-row">
      <strong class="cc-mono">#${esc(a.login)}</strong>
      ${badge(vpsName(a.vps), 'neutral')}
      ${off ? badge('DESCONECTADA', 'warn') : row ? badge('en vivo', 'pos') : badge('solo ciclo', 'neutral', 'Sin fila en el stream: se muestra el dato del snapshot')}
    </div>
    ${metricGrid([
      metric('Balance', usd(src.balance)),
      metric('Equity', usd(src.equity)),
      metric('Flotante', usd(src.profit, true), signClass(src.profit)),
      metric('Margen', usd(src.margin)),
    ])}
    <div class="cc-xs cc-faint">${off
      ? `Sin conexion · dato de ${esc(a.as_of ? dateTime(a.as_of) : 'el ultimo ciclo')} · sigue en la suma`
      : stale ? 'Cifras del ciclo, sin push en vivo todavia'
      : `${esc(a.server || '—')}${a.leverage ? ` · apalancamiento 1:${esc(a.leverage)}` : ''}`}</div>
  </div>`;
}

function positionsTable(positions) {
  return `<div class="cc-scroll-x"><table class="cc-table cc-table--clickable">
    <thead><tr><th>Cuenta</th><th>Magic</th><th>Simbolo</th><th>Tipo</th><th class="num">Vol</th>
      <th class="num">Apertura</th><th class="num">Actual</th><th class="num">SL</th><th class="num">TP</th>
      <th class="num">Flotante</th><th>Abierta</th></tr></thead>
    <tbody>${positions.map((p) => `<tr data-bot="#/bot/${esc(p.vps || '')}/${esc(p.login)}/${esc(p.magic)}">
      <td class="cc-mono">#${esc(p.login)}</td>
      <td class="cc-mono">${esc(p.magic)}</td>
      <td>${esc(p.symbol)}</td>
      <td>${esc(p.type)}</td>
      <td class="num">${esc(num(p.volume))}</td>
      <td class="num">${esc(num(p.price_open, 5))}</td>
      <td class="num">${esc(num(p.price_current, 5))}</td>
      <td class="num">${p.sl ? esc(num(p.sl, 5)) : '—'}</td>
      <td class="num">${p.tp ? esc(num(p.tp, 5)) : '—'}</td>
      <td class="num ${signClass(p.profit)}">${esc(usd(p.profit, true))}</td>
      <td>${esc(dateTime(p.time_open))}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function exposureTable(positions) {
  const rows = exposureBySymbol(positions);
  if (!rows.length) return emptyState('Sin exposicion abierta', 'No hay posiciones vivas en la cesta real.');
  const totalVol = rows.reduce((s, r) => s + r.volume, 0) || 1;
  return `<div class="cc-scroll-x"><table class="cc-table">
    <thead><tr><th>Simbolo</th><th class="num">Posiciones</th><th class="num">Volumen</th><th class="num">% del volumen</th><th class="num">Flotante</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.symbol)}</td>
      <td class="num">${esc(int(r.n))}</td>
      <td class="num">${esc(num(r.volume))}</td>
      <td class="num">${esc(num((r.volume / totalVol) * 100, 1))}%</td>
      <td class="num ${signClass(r.profit)}">${esc(usd(r.profit, true))}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function realBotsTable(snap) {
  const logins = realLogins(snap);
  const bots = (snap.bots || []).filter((b) => logins.has(b.account_login))
    .sort((a, b) => (b.net_profit || 0) - (a.net_profit || 0));
  if (!bots.length) return emptyState('Sin bots en cuentas reales', 'Ningun bot del ciclo pertenece a una cuenta de la cesta.');
  return `<div class="cc-scroll-x"><table class="cc-table cc-table--clickable">
    <thead><tr><th>Cuenta</th><th>Magic</th><th>Simbolo</th><th class="num">Trades</th><th class="num">Win %</th>
      <th class="num">PF</th><th class="num">Expectancy</th><th class="num">DD max</th><th class="num">Net</th><th>Ultimo trade</th></tr></thead>
    <tbody>${bots.map((b) => `<tr data-bot="#/bot/${esc(b.vps)}/${esc(b.account_login)}/${esc(b.magic)}">
      <td class="cc-mono">#${esc(b.account_login)}</td>
      <td class="cc-mono">${esc(b.magic)}</td>
      <td>${esc((b.symbols || []).join(', ') || '—')}</td>
      <td class="num">${esc(int(b.trades))}</td>
      <td class="num">${esc(num(b.win_rate_pct, 1))}%</td>
      <td class="num">${esc(b.profit_factor == null ? '∞' : num(b.profit_factor))}</td>
      <td class="num ${signClass(b.expectancy)}">${esc(usd(b.expectancy, true))}</td>
      <td class="num">${esc(usd(b.max_drawdown))}</td>
      <td class="num ${signClass(b.net_profit)}">${esc(usd(b.net_profit, true))}</td>
      <td>${esc(dateTime(b.last_trade))}</td>
    </tr>`).join('')}</tbody></table></div>`;
}
