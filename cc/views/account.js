// cc/views/account.js — Account 360.
//
// Lo que NO existe se dice, no se deriva a la brava: el P&L realizado a nivel
// de cuenta no lo publica el builder, asi que aqui se muestra como SUMA de sus
// bots (con la ventana declarada) y se etiqueta como tal. El drawdown de cuenta
// tampoco existe: para una cuenta real se aproxima con el equity del stream y
// se marca; para una demo se dice "no disponible" en vez de inventar un numero.

import { esc, usd, int, num, pct, dateTime, signClass, vpsName } from '../ui/fmt.js';
import { kpiRow, metric, metricGrid, emptyState } from '../ui/kpi.js';
import { badge, statusBadge, realBadge } from '../ui/badge.js';
import { freshnessBadge, liveBadge } from '../ui/freshness-badge.js';
import { findAccount, botsOfAccount, realLogins, honestNet } from '../data/model.js';

let elRef = null;
let ctxRef = null;
let unsub = null;
let paramsRef = null;

export function mount(el, params, ctx) {
  elRef = el; ctxRef = ctx; paramsRef = params.params;
  const { vps, login } = paramsRef;
  ctx.layout.setTitle(`Cuenta #${login}`);
  ctx.layout.setExtra(freshnessBadge(ctx.meta()));
  render();
  unsub = ctx.live.subscribe(() => renderLive());
  ctx.live.start();
}

export function unmount() {
  if (unsub) { unsub(); unsub = null; }
  elRef = null; ctxRef = null; paramsRef = null;
}

function render() {
  const snap = ctxRef.snapshot();
  const { vps, login } = paramsRef;
  const acc = snap ? findAccount(snap, vps, login) : null;
  if (!acc) {
    elRef.innerHTML = emptyState('Cuenta no encontrada',
      `No hay ninguna cuenta ${vps}/${login} en el ciclo actual.`, true);
    return;
  }
  const logins = realLogins(snap);
  const isReal = !!acc.is_real || logins.has(acc.login);
  const bots = botsOfAccount(snap, acc.vps || vps, acc.login);
  const positions = ((snap.real_portfolio || {}).open_positions || [])
    .filter((p) => String(p.login) === String(acc.login));

  const sumNet = bots.reduce((s, b) => s + (Number(b.net_profit) || 0), 0);
  const sumHonest = bots.reduce((s, b) => s + (Number(honestNet(b)) || 0), 0);
  const sumTrades = bots.reduce((s, b) => s + (Number(b.trades) || 0), 0);
  const window = snap.window_days ?? (snap.metrics_meta && snap.metrics_meta.window_days) ?? 365;

  elRef.innerHTML = `
    <section class="cc-card${isReal ? ' cc-card--real' : ''}">
      <div class="cc-card__head">
        <h1 style="font-size:var(--cc-fs-xl)">Cuenta <span class="cc-mono">#${esc(acc.login)}</span></h1>
        ${realBadge(isReal)}
        ${badge(vpsName(acc.vps || vps), 'neutral')}
        ${acc.disconnected ? badge('DESCONECTADA', 'warn', 'Cifras del ultimo ciclo con dato; sigue en la cesta') : ''}
        <span class="cc-card__spacer"></span>
        <span id="ac-live"></span>
      </div>
      <div class="cc-small cc-muted">${esc(acc.name || 'sin nombre')} · ${esc(acc.server || 'sin servidor')}
        ${acc.leverage ? `· apalancamiento 1:${esc(acc.leverage)}` : ''}
        ${acc.currency ? `· ${esc(acc.currency)}` : ''}</div>
    </section>

    <section id="ac-money"></section>

    <section class="cc-stack">
      <div class="cc-section-title"><h2>Resultado de sus bots</h2>
        <span class="cc-faint cc-small">suma de ${int(bots.length)} bots · ventana ${esc(window)} d</span></div>
      ${metricGrid([
        metric('Net (suma de bots)', usd(sumNet, true), signClass(sumNet), 'El builder no publica P&L realizado a nivel de cuenta: esto es la SUMA de sus bots'),
        metric('Net sin comision', usd(sumHonest, true), signClass(sumHonest)),
        metric('Operaciones cerradas', int(sumTrades)),
        metric('Bots adjuntos', int(bots.length)),
        metric('Posiciones abiertas', int(positions.length)),
        metric('Drawdown de cuenta', isReal ? 'derivado del stream' : 'no disponible', 'cc-faint',
          isReal ? 'Se aproxima con la serie de equity en vivo; el builder no lo publica'
                 : 'No existe para cuentas demo hasta la Fase 8 del blueprint'),
      ])}
    </section>

    <section class="cc-stack">
      <div class="cc-section-title"><h2>Bots</h2>
        <span class="cc-faint cc-small">clic para abrir el Bot 360</span></div>
      ${bots.length ? botsTable(bots) : emptyState('Sin bots', 'Esta cuenta no tiene ningun EA con operaciones en el ciclo.')}
    </section>

    ${positions.length ? `<section class="cc-stack">
      <div class="cc-section-title"><h2>Posiciones abiertas</h2></div>
      ${positionsTable(positions)}
    </section>` : ''}`;

  renderLive();
  elRef.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-bot]');
    if (row) location.hash = row.dataset.bot;
  });
}

function renderLive() {
  if (!elRef || !ctxRef) return;
  const snap = ctxRef.snapshot();
  const acc = findAccount(snap, paramsRef.vps, paramsRef.login);
  if (!acc) return;
  const logins = realLogins(snap);
  const isReal = !!acc.is_real || logins.has(acc.login);
  const row = isReal ? ctxRef.live.rowFor(acc.login) : null;
  const fresh = ctxRef.live.freshness();
  const src = row || acc;

  const pill = elRef.querySelector('#ac-live');
  if (pill) pill.innerHTML = isReal ? liveBadge(fresh) : badge('cuenta demo · sin stream', 'neutral');

  const money = elRef.querySelector('#ac-money');
  if (!money) return;
  const marginLevel = (Number(src.margin) > 0)
    ? (Number(src.equity) / Number(src.margin)) * 100 : null;
  money.className = 'cc-stack' + (isReal && fresh.unverified ? ' cc-live-unverified' : '');
  money.innerHTML = `
    ${isReal && fresh.unverified ? `<div class="cc-banner cc-banner--crit">
      <div><strong>NO VERIFICADO</strong><span class="cc-small"> · el stream lleva
      ${esc(fresh.age_sec == null ? '—' : fresh.age_sec.toFixed(0))} s sin confirmar estas cifras (umbral ${esc(fresh.unverifiedSec)} s).</span></div></div>` : ''}
    ${acc.disconnected ? `<div class="cc-banner cc-banner--warn">
      <div><strong>Terminal desconectado</strong><span class="cc-small"> · las cifras son de
      ${esc(acc.as_of ? dateTime(acc.as_of) : 'el ultimo ciclo con dato')} y siguen contando en la cesta fija.</span></div></div>` : ''}
    ${kpiRow([
      { label: 'Balance', value: usd(src.balance), real: isReal },
      { label: 'Equity', value: usd(src.equity), real: isReal },
      { label: 'Flotante', value: usd(src.profit, true), real: isReal, tone: signClass(src.profit) },
      { label: 'Margen', value: usd(src.margin), real: isReal, small: true },
      { label: 'Margen libre', value: usd(src.free_margin ?? acc.free_margin), real: isReal, small: true },
      { label: 'Margin level', value: marginLevel == null ? '—' : pct(marginLevel, 0), real: isReal, small: true,
        tone: marginLevel != null && marginLevel < 200 ? 'cc-warn' : '' },
    ])}`;
}

function botsTable(bots) {
  const sorted = bots.slice().sort((a, b) => (b.net_profit || 0) - (a.net_profit || 0));
  return `<div class="cc-scroll-x"><table class="cc-table cc-table--clickable">
    <thead><tr><th>Magic</th><th>Simbolo</th><th>Estado</th><th class="num">Score</th><th class="num">Trades</th>
      <th class="num">Win %</th><th class="num">PF</th><th class="num">DD %</th><th class="num">Net</th><th>Ultimo trade</th></tr></thead>
    <tbody>${sorted.map((b) => `<tr data-bot="#/bot/${esc(b.vps)}/${esc(b.account_login)}/${esc(b.magic)}">
      <td class="cc-mono">${esc(b.magic)}</td>
      <td>${esc((b.symbols || []).join(', ') || '—')}</td>
      <td>${statusBadge(b.promotion_status)}</td>
      <td class="num">${esc(num(b.promotion_score, 1))}</td>
      <td class="num">${esc(int(b.trades))}</td>
      <td class="num">${esc(num(b.win_rate_pct, 1))}%</td>
      <td class="num">${esc(b.profit_factor == null ? '∞' : num(b.profit_factor))}</td>
      <td class="num">${esc(num(b.dd_pct_of_balance, 1))}%</td>
      <td class="num ${signClass(b.net_profit)}">${esc(usd(b.net_profit, true))}</td>
      <td>${esc(dateTime(b.last_trade))}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function positionsTable(positions) {
  return `<div class="cc-scroll-x"><table class="cc-table cc-table--clickable">
    <thead><tr><th>Magic</th><th>Simbolo</th><th>Tipo</th><th class="num">Vol</th>
      <th class="num">Apertura</th><th class="num">Actual</th><th class="num">Flotante</th><th>Abierta</th></tr></thead>
    <tbody>${positions.map((p) => `<tr data-bot="#/bot/${esc(p.vps || '')}/${esc(p.login)}/${esc(p.magic)}">
      <td class="cc-mono">${esc(p.magic)}</td>
      <td>${esc(p.symbol)}</td>
      <td>${esc(p.type)}</td>
      <td class="num">${esc(num(p.volume))}</td>
      <td class="num">${esc(num(p.price_open, 5))}</td>
      <td class="num">${esc(num(p.price_current, 5))}</td>
      <td class="num ${signClass(p.profit)}">${esc(usd(p.profit, true))}</td>
      <td>${esc(dateTime(p.time_open))}</td>
    </tr>`).join('')}</tbody></table></div>`;
}
