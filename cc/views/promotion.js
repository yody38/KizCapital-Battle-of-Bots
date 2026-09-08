// cc/views/promotion.js — Promotion Center.
//
// Cinco cubos: READY / NEAR / WATCH / BLOCKED / NEW. Los tres primeros salen
// del pool de candidatos con los caps del backend (promotion_meta.rank_caps,
// nunca de una constante local). BLOCKED junta los bloqueos duros y los
// asientos provisionales. NEW son los que aun no tienen historia suficiente.
//
// Aqui no se promueve nada: human_veto_required sigue siendo True y esta vista
// es de solo lectura. READY es una PROPUESTA.

import { esc, usd, int, num, pct, signClass, vpsName } from '../ui/fmt.js';
import { metric, metricGrid, emptyState } from '../ui/kpi.js';
import { badge, statusBadge, confidenceBadge } from '../ui/badge.js';
import { freshnessBadge } from '../ui/freshness-badge.js';
import { candidatePool, rankCaps, realLogins, realMagics, honestNet, botKeyOf } from '../data/model.js';
import { getCorrelations } from '../data/correlations.js';

const BUCKETS = ['READY', 'NEAR', 'WATCH', 'BLOCKED', 'NEW'];

let elRef = null;
let ctxRef = null;
let bucket = 'READY';
let corrRef = null;

export function mount(el, params, ctx) {
  elRef = el; ctxRef = ctx;
  bucket = BUCKETS.includes(String((params.query || {}).bucket || '').toUpperCase())
    ? String(params.query.bucket).toUpperCase() : 'READY';
  ctx.layout.setTitle('Promocion');
  ctx.layout.setExtra(freshnessBadge(ctx.meta()));
  // Un solo listener delegado para toda la vida de la vista: render() se
  // ejecuta en cada cambio de cubo y volver a suscribir ahi duplicaba clics.
  elRef.addEventListener('click', onClick);
  render();
  getCorrelations().then((c) => { corrRef = c; if (elRef) render(); }).catch(() => {});
}

function onClick(ev) {
  const tab = ev.target.closest('[data-bucket]');
  if (tab) {
    bucket = tab.dataset.bucket;
    location.hash = `#/promotion?bucket=${bucket}`;
    render();
    return;
  }
  const go = ev.target.closest('[data-bot]');
  if (go) location.hash = go.dataset.bot;
}

export function unmount() {
  if (elRef) elRef.removeEventListener('click', onClick);
  elRef = null; ctxRef = null; corrRef = null;
}

function buckets(snap) {
  const pool = candidatePool(snap);
  const logins = realLogins(snap);
  const magics = realMagics(snap);
  const caps = rankCaps(snap);
  const all = snap.bots || [];

  const ready = pool.filter((b) => b.promotion_status === 'READY').slice(0, caps.READY);
  const near = pool.filter((b) => b.promotion_status === 'NEAR').slice(0, caps.NEAR);
  const watch = pool.filter((b) => b.promotion_status === 'WATCH').slice(0, caps.WATCH);

  const blocked = all.filter((b) => !logins.has(b.account_login) && !magics.has(b.magic)
    && (b.provisional_low_confidence
      || (Array.isArray(b.trust_fails) && b.trust_fails.length)
      || (b.promotion_status === 'NO' && b.promotion_score != null)))
    .sort((a, b) => (b.promotion_score || 0) - (a.promotion_score || 0));

  const nuevos = all.filter((b) => (b.lifecycle && b.lifecycle.stage) === 'NEW')
    .sort((a, b) => (b.trades || 0) - (a.trades || 0));

  return { READY: ready, NEAR: near, WATCH: watch, BLOCKED: blocked, NEW: nuevos, caps };
}

function render() {
  const snap = ctxRef.snapshot();
  if (!snap) {
    elRef.innerHTML = emptyState('Sin ciclo', 'data/snapshot.json no se pudo leer.', true);
    return;
  }
  const pm = snap.promotion_meta || {};
  const sv = pm.score_versions || {};
  const bk = buckets(snap);
  const rows = bk[bucket] || [];

  elRef.innerHTML = `
    <section class="cc-card">
      <div class="cc-card__head">
        <span class="cc-card__title">Transparencia del pool</span>
        <span class="cc-card__spacer"></span>
        ${badge(`score vigente ${sv.live || 'v1'}`, 'accent')}
        ${sv.v2 ? badge('v2 en sombra', 'shadow') : ''}
      </div>
      ${metricGrid([
        metric('Pool antes de comision', int(pm.pool_pre_commission)),
        metric('Elegibles', int(pm.eligible_count)),
        metric('Tras dedup por magic', int(pm.pool_post_dedup)),
        metric('De plena confianza', int(pm.trusted_count), 'cc-pos'),
        metric('Provisionales', int(pm.provisional_count), 'cc-warn'),
        metric('Bloqueados duro', int(pm.hard_blocked_count), 'cc-neg'),
        metric('Asientos', `${bk.caps.READY} / ${bk.caps.NEAR} / ${bk.caps.WATCH}`, '', 'READY / NEAR / WATCH — caps del backend'),
        metric('Veto humano', String(pm.human_veto_required ?? true), 'cc-real'),
      ])}
      ${pm.ranker ? `<p class="cc-xs cc-faint">Criterio de orden: ${esc(pm.ranker)}</p>` : ''}
    </section>

    ${sv.v2 && sv.v2.diff ? shadowPanel(sv.v2) : ''}

    <section class="cc-stack">
      <div class="cc-row" id="pr-tabs">
        ${BUCKETS.map((b) => `<button class="cc-chip${b === bucket ? ' is-active' : ''}" data-bucket="${b}" type="button">
          ${b} <span class="cc-faint">${(bk[b] || []).length}</span></button>`).join('')}
      </div>
      ${rows.length ? rows.map((b) => card(b, snap)).join('') : emptyState(
        `Sin candidatos en ${bucket}`,
        bucket === 'READY'
          ? 'Un cupo vacio es senal, no un fallo: significa que ningun EA de plena confianza alcanza el corte en este ciclo.'
          : 'Ningun bot del ciclo cae en este cubo.')}
    </section>

    <p class="cc-xs cc-faint">Esta vista es de SOLO LECTURA. Ningun bot se promueve desde aqui:
      READY es una propuesta que requiere el visto bueno humano.</p>`;

}

function shadowPanel(v2) {
  const d = v2.diff;
  return `<section class="cc-card">
    <div class="cc-card__head">
      <span class="cc-card__title">Score v2 · sombra</span>
      ${badge('no decide asientos', 'shadow')}
    </div>
    ${metricGrid([
      metric('Bots puntuados', int(d.n_scored)),
      metric('Delta medio |v2-v1|', num(d.mean_abs_delta, 2)),
      metric('p90', num(d.p90_abs_delta, 2)),
      metric('Maximo', num(d.max_abs_delta, 2)),
      metric('Coincidencia READY (jaccard)', num(d.jaccard_ready, 3),
        d.jaccard_ready < 1 ? 'cc-warn' : 'cc-pos'),
    ])}
    <div class="cc-row cc-xs">
      <span class="cc-faint">READY v1:</span> <code>${esc((d.ready_v1 || []).join(', ') || '—')}</code>
    </div>
    <div class="cc-row cc-xs">
      <span class="cc-faint">READY v2:</span> <code class="cc-info">${esc((d.ready_v2 || []).join(', ') || '—')}</code>
    </div>
    ${v2.changelog ? `<details><summary class="cc-xs cc-muted" style="cursor:pointer">Que cambia v2</summary>
      <div class="cc-raw">${esc(JSON.stringify(v2.changelog, null, 2))}</div></details>` : ''}
  </section>`;
}

function card(b, snap) {
  const sm = b.shrinkage_meta;
  const key = botKeyOf(b);
  const logins = realLogins(snap);
  const realKeys = new Set((snap.bots || []).filter((x) => logins.has(x.account_login)).map(botKeyOf));
  const r1 = corrRef && corrRef.available ? corrRef.maxAgainst(key, realKeys, 'v1') : null;
  const r2 = corrRef && corrRef.available ? corrRef.maxAgainst(key, realKeys, 'v2') : null;

  return `<div class="cc-card" data-bot="#/bot/${esc(b.vps)}/${esc(b.account_login)}/${esc(b.magic)}" style="cursor:pointer">
    <div class="cc-card__head">
      <strong class="cc-mono">${esc(b.magic)}</strong>
      ${statusBadge(b.promotion_status)}
      ${confidenceBadge(sm)}
      ${badge(vpsName(b.vps), 'neutral')}
      <span class="cc-faint cc-small">#${esc(b.account_login)} · ${esc((b.symbols || []).join(', ') || '—')}</span>
      ${b.provisional_low_confidence ? badge('provisional', 'warn') : ''}
      ${b.dormant ? badge(`dormido ${b.days_since_last_trade ?? '?'} d`, 'warn') : ''}
      <span class="cc-card__spacer"></span>
      <span class="cc-small">score <strong>${esc(num(b.promotion_score, 1))}</strong>
        ${b.promotion_score_v2 != null ? `<span class="cc-info">· v2 ${esc(num(b.promotion_score_v2, 1))} (sombra)</span>` : ''}</span>
    </div>
    ${metricGrid([
      metric('Net sin comision', usd(honestNet(b), true), signClass(honestNet(b))),
      metric('Trades', int(b.trades)),
      metric('DD % balance', pct(b.dd_pct_of_balance), (b.dd_pct_of_balance ?? 0) > 10 ? 'cc-neg' : ''),
      metric('Calmar', num(b.calmar)),
      metric('Meses activo', num(b.months_active, 1)),
      metric('OOS', b.oos && b.oos.verdict ? b.oos.verdict : '—'),
      metric('ρ max vs reales (v1)', r1 ? num(r1.rho) : '—', r1 && Math.abs(r1.rho) > 0.7 ? 'cc-neg' : ''),
      metric('ρ max vs reales (v2)', r2 ? num(r2.rho) : '—', 'cc-info'),
    ])}
    <div class="cc-small cc-muted">${esc(why(b, sm))}</div>
  </div>`;
}

function why(b, sm) {
  const parts = [];
  const fails = b.promotion_fails || b.fails || [];
  if (fails.length) parts.push(`No pasa: ${fails.join('; ')}.`);
  else parts.push('Pasa los gates duros.');
  if (sm) {
    parts.push(`Confianza ${String(sm.confidence || 'MEDIA').toUpperCase()}: el shrinkage `
      + `${(sm.delta ?? 0) < 0 ? 'recorta' : 'sube'} ${num(Math.abs(sm.delta ?? 0), 1)} puntos con `
      + `${sm.cohort_prior_used ? 'prior de cohorte' : 'prior global'} (n=${sm.cohort_n ?? '?'}).`);
  }
  if (Array.isArray(b.trust_fails) && b.trust_fails.length) parts.push(`Confianza incompleta: ${b.trust_fails.join(', ')}.`);
  if (b.decay_flag) parts.push(`decay_ratio ${num(b.decay_ratio)} marcado.`);
  if (b.drift && b.drift.flag) parts.push(`drift ${num(b.drift.severity)}×.`);
  if (b.evidence_tier) parts.push(`Evidencia ${b.evidence_tier}.`);
  return parts.join(' ');
}
