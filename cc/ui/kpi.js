// cc/ui/kpi.js — cifras grandes y rejillas de metricas.

import { esc } from './fmt.js';

/**
 * @param {{label:string, value:string, hint?:string, tone?:string, real?:boolean, small?:boolean}} o
 */
export function kpi(o) {
  const tone = o.tone ? ` ${o.tone}` : '';
  const cls = `cc-kpi${o.real ? ' cc-kpi--real' : ''}`;
  const vcls = `cc-kpi__value${o.small ? ' cc-kpi__value--sm' : ''}${tone}`;
  return `<div class="${cls}" title="${esc(o.label)}: ${esc(o.value)}">
    <span class="cc-kpi__label">${esc(o.label)}</span>
    <span class="${vcls}">${o.html ? o.value : esc(o.value)}</span>
    ${o.hint ? `<span class="cc-kpi__hint">${esc(o.hint)}</span>` : ''}
  </div>`;
}

export function kpiRow(items) {
  return `<div class="cc-kpi-row">${items.filter(Boolean).map(kpi).join('')}</div>`;
}

/** Metrica pequena para las rejillas densas del Bot 360. */
export function metric(label, value, tone = '', title = '') {
  const ttl = title ? ` title="${esc(title)}"` : '';
  return `<div class="cc-metric"${ttl}>
    <span class="cc-metric__label">${esc(label)}</span>
    <span class="cc-metric__value ${tone}">${esc(value)}</span>
  </div>`;
}

export function metricGrid(pairs) {
  return `<div class="cc-metrics">${pairs.filter(Boolean).join('')}</div>`;
}

/** Barra 0..1 con severidad. `pct` fuera de rango se recorta, no se inventa. */
export function bar(fraction, tone = '') {
  const f = Number.isFinite(Number(fraction)) ? Math.max(0, Math.min(1, Number(fraction))) : 0;
  const t = tone ? ` cc-bar__fill--${tone}` : '';
  return `<div class="cc-bar"><div class="cc-bar__fill${t}" style="width:${(f * 100).toFixed(1)}%"></div></div>`;
}

export function emptyState(title, detail = '', isError = false) {
  return `<div class="cc-empty${isError ? ' cc-empty--error' : ''}">
    <strong>${esc(title)}</strong>
    ${detail ? esc(detail) : ''}
  </div>`;
}
