// cc/views/portfolio.js — Cartera y riesgo.
//
// Correlacion v1 y v2 LADO A LADO (v2 en sombra: ningun gate la lee todavia),
// concentracion y exposicion. El shell nunca calcula la matriz: la matriz N²
// vive en el backend, topada a 60 bots; aqui solo se lee.

import { esc, usd, int, num, pct, signClass, vpsName } from '../ui/fmt.js';
import { metric, metricGrid, emptyState, bar } from '../ui/kpi.js';
import { badge } from '../ui/badge.js';
import { freshnessBadge } from '../ui/freshness-badge.js';
import { fetchJson } from '../data/fetch.js';
import { getCorrelations } from '../data/correlations.js';
import { realPortfolio, realLogins, botKeyOf, exposureBySymbol, hhi } from '../data/model.js';

let elRef = null;
let ctxRef = null;
let token = 0;

export function mount(el, params, ctx) {
  elRef = el; ctxRef = ctx;
  const my = ++token;
  ctx.layout.setTitle('Cartera y riesgo');
  ctx.layout.setExtra(freshnessBadge(ctx.meta()));
  el.innerHTML = '<div class="cc-skeleton" style="height:200px"></div>';

  Promise.all([
    getCorrelations().catch(() => null),
    fetchJson('portfolio.json'),
    fetchJson('basket_recommendations.json'),
  ]).then(([corr, port, basket]) => {
    if (my !== token) return;
    render(corr, port, basket);
  });
}

export function unmount() { token++; elRef = null; ctxRef = null; }

function render(corr, port, basket) {
  const snap = ctxRef.snapshot();
  if (!snap) {
    elRef.innerHTML = emptyState('Sin ciclo', 'data/snapshot.json no se pudo leer.', true);
    return;
  }
  const rp = realPortfolio(snap);
  const logins = realLogins(snap);
  const realKeys = new Set((snap.bots || []).filter((b) => logins.has(b.account_login)).map(botKeyOf));

  elRef.innerHTML = `
    ${concentrationBlock(snap, rp)}
    ${exposureBlock(rp)}
    ${correlationBlock(corr, realKeys)}
    ${portfolioBlock(port)}
    ${basketBlock(basket)}`;

  elRef.addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-bot]');
    if (go) location.hash = go.dataset.bot;
  });
}

// ------------------------------------------------------------- concentracion

function concentrationBlock(snap, rp) {
  const logins = realLogins(snap);
  const realBots = (snap.bots || []).filter((b) => logins.has(b.account_login));
  const bySymbol = new Map();
  const byAccount = new Map();
  for (const b of realBots) {
    const eq = Math.abs(Number(b.net_profit) || 0);
    for (const s of (b.symbols || ['—'])) {
      const k = String(s).split('.')[0].toUpperCase();
      bySymbol.set(k, (bySymbol.get(k) || 0) + eq);
    }
    byAccount.set(b.account_login, (byAccount.get(b.account_login) || 0) + eq);
  }
  const hBot = hhi(realBots.map((b) => Math.abs(Number(b.net_profit) || 0)));
  const hSym = hhi([...bySymbol.values()]);
  const hAcc = hhi([...byAccount.values()]);

  const tone = (h) => (h == null ? '' : h > 0.25 ? 'cc-neg' : h > 0.15 ? 'cc-warn' : 'cc-pos');

  return `<section class="cc-card">
    <div class="cc-card__head">
      <span class="cc-card__title">Concentracion de la cartera real</span>
      <span class="cc-card__spacer"></span>
      <span class="cc-xs cc-faint">HHI sobre |net| de los ${int(realBots.length)} bots reales · &gt;0.25 = concentrado</span>
    </div>
    ${metricGrid([
      metric('HHI por bot', num(hBot, 3), tone(hBot)),
      metric('HHI por simbolo', num(hSym, 3), tone(hSym)),
      metric('HHI por cuenta', num(hAcc, 3), tone(hAcc)),
      metric('Cuentas en la cesta', `${rp.accounts.length}${rp.expectedCount ? ` / ${rp.expectedCount}` : ''}`,
        rp.expectedCount && rp.accounts.length < rp.expectedCount ? 'cc-neg' : ''),
      metric('Equity real', usd(rp.totalEquity), 'cc-real'),
      metric('Margen usado', usd(rp.totalMargin), 'cc-real'),
    ])}
    ${realBots.length ? `<div class="cc-scroll-x"><table class="cc-table cc-table--clickable">
      <thead><tr><th>Bot</th><th>Cuenta</th><th>Simbolo</th><th class="num">Net</th><th class="num">Peso</th><th style="width:140px"></th></tr></thead>
      <tbody>${topWeights(realBots)}</tbody></table></div>` : ''}
  </section>`;
}

function topWeights(bots) {
  const total = bots.reduce((s, b) => s + Math.abs(Number(b.net_profit) || 0), 0) || 1;
  return bots.slice()
    .sort((a, b) => Math.abs(b.net_profit || 0) - Math.abs(a.net_profit || 0))
    .slice(0, 15)
    .map((b) => {
      const w = Math.abs(Number(b.net_profit) || 0) / total;
      return `<tr data-bot="#/bot/${esc(b.vps)}/${esc(b.account_login)}/${esc(b.magic)}">
        <td class="cc-mono">${esc(b.magic)}</td>
        <td class="cc-mono">#${esc(b.account_login)}</td>
        <td>${esc((b.symbols || []).join(', ') || '—')}</td>
        <td class="num ${signClass(b.net_profit)}">${esc(usd(b.net_profit, true))}</td>
        <td class="num">${esc(pct(w * 100))}</td>
        <td>${bar(w, w > 0.25 ? 'crit' : w > 0.15 ? 'warn' : 'pos')}</td>
      </tr>`;
    }).join('');
}

// ---------------------------------------------------------------- exposicion

function exposureBlock(rp) {
  const rows = exposureBySymbol(rp.positions);
  if (!rows.length) {
    return `<section class="cc-stack"><div class="cc-section-title"><h2>Exposicion abierta</h2></div>
      ${emptyState('Sin posiciones abiertas', 'La cesta real no tiene ninguna operacion viva en este ciclo.')}</section>`;
  }
  const totalVol = rows.reduce((s, r) => s + r.volume, 0) || 1;
  return `<section class="cc-stack">
    <div class="cc-section-title"><h2>Exposicion abierta</h2>
      <span class="cc-faint cc-small">${int(rp.positions.length)} posiciones · ${int(rows.length)} simbolos</span></div>
    <div class="cc-scroll-x"><table class="cc-table">
      <thead><tr><th>Simbolo</th><th class="num">Posiciones</th><th class="num">Volumen</th><th class="num">% volumen</th><th class="num">Flotante</th><th style="width:140px"></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.symbol)}</td>
        <td class="num">${esc(int(r.n))}</td>
        <td class="num">${esc(num(r.volume))}</td>
        <td class="num">${esc(pct((r.volume / totalVol) * 100))}</td>
        <td class="num ${signClass(r.profit)}">${esc(usd(r.profit, true))}</td>
        <td>${bar(r.volume / totalVol, r.volume / totalVol > 0.4 ? 'warn' : 'pos')}</td>
      </tr>`).join('')}</tbody></table></div>
  </section>`;
}

// --------------------------------------------------------------- correlacion

function correlationBlock(corr, realKeys) {
  if (!corr || !corr.available) {
    return `<section class="cc-stack"><div class="cc-section-title"><h2>Correlacion</h2></div>
      ${emptyState('Sin data/correlations.json', 'El ciclo no publico la matriz. No se estima ninguna correlacion en el navegador.')}</section>`;
  }
  const pairs = corr.pairs({ version: 'v1', minAbs: 0 }).slice(0, 25);
  const hasV2 = !!(corr.raw && corr.raw.matrix_v2);

  return `<section class="cc-stack">
    <div class="cc-section-title">
      <h2>Correlacion</h2>
      ${badge(`vigente ${corr.liveVersion || 'v1'}`, 'accent')}
      ${hasV2 ? badge('v2 en sombra', 'shadow', 'Publicado junto a v1; ningun gate lo lee todavia') : ''}
      <span class="cc-faint cc-small">${int(corr.botCount)} bots · min ${int(corr.minTrades)} trades</span>
    </div>
    ${corr.estimators ? `<div class="cc-banner cc-banner--info"><div class="cc-small">
      <strong>v1</strong> ${esc(corr.estimators.live)}<br>
      <strong>v2 (sombra)</strong> ${esc(corr.estimators.shadow)}</div></div>` : ''}
    <div class="cc-scroll-x"><table class="cc-table">
      <thead><tr><th>Par</th><th class="num">ρ v1</th><th class="num">ρ v2 (sombra)</th><th class="num">Δ</th><th class="num">Dias solapados</th><th>Contra real</th></tr></thead>
      <tbody>${pairs.map((p) => {
        const v2 = corr.v2(p.a, p.b);
        const d = (v2 == null || p.rho == null) ? null : v2 - p.rho;
        const touchesReal = realKeys.has(p.a) || realKeys.has(p.b);
        return `<tr>
          <td class="cc-xs"><code>${esc(p.a)}</code><br><code>${esc(p.b)}</code></td>
          <td class="num ${Math.abs(p.rho) > 0.7 ? 'cc-neg' : ''}">${esc(num(p.rho))}</td>
          <td class="num cc-info">${esc(num(v2))}</td>
          <td class="num">${d == null ? '—' : esc(num(d))}</td>
          <td class="num">${p.overlap == null ? '—' : esc(int(p.overlap))}</td>
          <td>${touchesReal ? badge('si', 'real') : '<span class="cc-faint">—</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table></div>
    <p class="cc-xs cc-faint">El gate duro <code>clones_real</code> bloquea a partir de |ρ| 0.7 leyendo v1.
      v2 corrige el sesgo de calendario (correlaciona solo los dias en que ambos operaron) pero
      todavia no decide nada: el flip lo autoriza el owner.</p>
  </section>`;
}

// ------------------------------------------------------------------ portfolio

function portfolioBlock(port) {
  if (!port || !port.data) {
    return `<section class="cc-stack"><div class="cc-section-title"><h2>Optimizador de cartera</h2></div>
      ${emptyState('Sin data/portfolio.json',
        port && port.meta && port.meta.error ? `No se pudo leer (${port.meta.error}).` : 'El ciclo no publico el optimizador.')}</section>`;
  }
  const d = port.data;
  const capitals = Object.keys(d.allocations || {});
  const cap = capitals[0];
  const methods = cap ? Object.keys(d.allocations[cap] || {}) : [];
  const method = methods.includes('inverse_volatility') ? 'inverse_volatility' : methods[0];
  const rows = (cap && method) ? (d.allocations[cap][method] || []) : [];

  return `<section class="cc-stack">
    <div class="cc-section-title"><h2>Optimizador de cartera</h2>
      ${freshnessBadge(port.meta)}
      <span class="cc-faint cc-small">${int(d.n_bots)} bots · capital $${esc(cap || '—')} · metodo ${esc(method || '—')}</span></div>
    ${rows.length ? `<div class="cc-scroll-x"><table class="cc-table">
      <thead><tr><th>Magic</th><th class="num">Peso</th><th class="num">Capital</th><th style="width:140px"></th></tr></thead>
      <tbody>${rows.slice(0, 20).map((a) => `<tr>
        <td class="cc-mono">${esc(a.magic)}</td>
        <td class="num">${esc(pct((a.weight || 0) * 100))}</td>
        <td class="num">${esc(usd(a.capital_usd))}</td>
        <td>${bar(a.weight || 0)}</td>
      </tr>`).join('')}</tbody></table></div>`
      : emptyState('Sin asignaciones', 'portfolio.json existe pero no trae allocations para este capital y metodo.')}
  </section>`;
}

function basketBlock(basket) {
  if (!basket || !basket.data) {
    return `<section class="cc-stack"><div class="cc-section-title"><h2>Recomendaciones de cesta</h2></div>
      ${emptyState('Sin data/basket_recommendations.json', 'El workflow composite-fleet no publico recomendaciones en este ciclo.')}</section>`;
  }
  const d = basket.data;
  return `<section class="cc-stack">
    <div class="cc-section-title"><h2>Recomendaciones de cesta</h2>
      ${freshnessBadge(basket.meta)}
      ${d.status ? badge(String(d.status), d.status === 'ok' ? 'pos' : 'warn') : ''}</div>
    <div class="cc-raw">${esc(JSON.stringify(d, null, 2))}</div>
  </section>`;
}
