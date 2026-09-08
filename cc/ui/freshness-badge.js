// cc/ui/freshness-badge.js — el contrato SOURCE / AS OF / AGE / STATUS.
//
// Toda cifra del Command Center tiene que poder responder de donde salio y de
// cuando es. Este badge es esa respuesta, y va pegado al bloque que lo usa.

import { esc, dateTime } from './fmt.js';
import { SOURCE_LABELS } from '../data/fetch.js';
import { humanAge } from '../data/freshness.js';

const STATUS_LABEL = {
  fresh: 'FRESCO',
  ok: 'OK',
  aging: 'ENVEJECIENDO',
  stale: 'RANCIO',
  offline: 'SIN DATO',
  error: 'ERROR',
  aborted: 'CANCELADO',
  live: 'EN VIVO',
  fallback: 'EN VIVO · RESPALDO',
  lag: 'CON RETRASO',
};

const STATUS_CLASS = {
  fresh: 'fresh', ok: 'fresh', live: 'fresh', fallback: 'fresh',
  aging: 'aging', lag: 'aging',
  stale: 'stale',
  offline: 'offline', error: 'error', aborted: 'error',
};

/**
 * @param {{source?:string, as_of?:string, age_sec?:number, status?:string, error?:string}} meta
 * @param {{label?:string}} [opts]
 */
export function freshnessBadge(meta, opts = {}) {
  const m = meta || {};
  const status = m.status || 'offline';
  const cls = STATUS_CLASS[status] || 'offline';
  const src = SOURCE_LABELS[m.source] || String(m.source || 'DESCONOCIDA').toUpperCase();
  const age = humanAge(m.age_sec);
  const title = [
    `FUENTE: ${src}`,
    `AL: ${m.as_of ? dateTime(m.as_of) : '—'}`,
    `EDAD: ${age}`,
    `ESTADO: ${STATUS_LABEL[status] || status.toUpperCase()}`,
    m.path ? `RUTA: data/${m.path}` : '',
    m.error ? `ERROR: ${m.error}` : '',
  ].filter(Boolean).join('\n');

  const text = opts.label
    ? opts.label
    : (status === 'error' || status === 'offline')
      ? (STATUS_LABEL[status] || status)
      : age;

  return `<span class="cc-fresh cc-fresh--${cls}" title="${esc(title)}">
    <span class="cc-fresh__dot"></span>
    <span class="cc-fresh__src">${esc(src)}</span>
    <span>${esc(text)}</span>
  </span>`;
}

/** Variante para el stream real (segundos, no minutos). */
export function liveBadge(fresh) {
  const f = fresh || {};
  const cls = STATUS_CLASS[f.state] || 'offline';
  const age = f.age_sec == null ? '—' : `${f.age_sec.toFixed(1)} s`;
  const title = [
    `FUENTE: STREAM ${String(f.transport || 'sin transporte').toUpperCase()}`,
    `EDAD (fila mas vieja): ${age}`,
    `ESTADO: ${(f.label || f.state || '—').toUpperCase()}`,
    `CUENTAS CON PUSH: ${f.count ?? 0}`,
    f.unverified ? `NO VERIFICADO: el stream lleva >= ${f.unverifiedSec ?? 30}s sin confirmar estas cifras` : '',
  ].filter(Boolean).join('\n');
  return `<span class="cc-fresh cc-fresh--${cls}" title="${esc(title)}">
    <span class="cc-fresh__dot"></span>
    <span class="cc-fresh__src">LIVE</span>
    <span>${esc(f.label || '—')}${f.age_sec == null ? '' : ` · ${age}`}</span>
  </span>`;
}

export { STATUS_LABEL };
