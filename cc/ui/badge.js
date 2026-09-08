// cc/ui/badge.js — chips y etiquetas. Devuelven HTML ya escapado.

import { esc, vpsName } from './fmt.js';

const TONES = new Set(['pos', 'neg', 'warn', 'crit', 'info', 'accent', 'real', 'neutral', 'shadow']);

export function badge(text, tone = 'neutral', title = '') {
  const t = TONES.has(tone) ? tone : 'neutral';
  const ttl = title ? ` title="${esc(title)}"` : '';
  return `<span class="cc-badge cc-badge--${t}"${ttl}>${esc(text)}</span>`;
}

/** READY / NEAR / WATCH / NO — mismos nombres que promotion_status. */
export function statusBadge(status) {
  const s = String(status || '').toUpperCase();
  const tone = s === 'READY' ? 'pos'
    : s === 'NEAR' ? 'accent'
    : s === 'WATCH' ? 'warn'
    : s === 'NO' ? 'neutral'
    : 'neutral';
  return badge(s || '—', tone);
}

/** Etapa del ciclo de vida (lifecycle.stage). */
export function stageBadge(stage, historicalReason) {
  const s = String(stage || '').toUpperCase();
  if (!s) return badge('—', 'neutral');
  const tone = s === 'REAL' ? 'real'
    : s === 'CANDIDATE' ? 'accent'
    : s === 'OBSERVATION' ? 'info'
    : s === 'NEW' ? 'neutral'
    : s === 'HISTORICAL' ? 'warn'
    : 'neutral';
  const title = s === 'HISTORICAL' && historicalReason
    ? (historicalReason === 'DEAD' ? 'Retirado' : 'Historia posterior a real')
    : '';
  return badge(s, tone, title);
}

export function vpsBadge(id) {
  return badge(vpsName(id) || '—', 'neutral');
}

export function realBadge(isReal) {
  return isReal ? badge('REAL', 'real', 'Cuenta con dinero real') : badge('DEMO', 'neutral');
}

/** Severidad de sistema: ok / warn / fail / unknown (tabla del watchdog). */
export function severityBadge(sev) {
  const s = String(sev || 'unknown').toLowerCase();
  if (s === 'ok' || s === 'healthy') return badge('HEALTHY', 'pos');
  if (s === 'warn' || s === 'degraded') return badge('DEGRADED', 'warn');
  if (s === 'fail' || s === 'critical') return badge('CRITICAL', 'crit');
  return badge('UNKNOWN', 'neutral');
}

/** Confianza del shrinkage bayesiano: HIGH / MEDIUM / LOW. */
export function confidenceBadge(sm) {
  if (!sm || !sm.confidence) return '';
  const c = String(sm.confidence).toUpperCase();
  const glyph = c === 'HIGH' ? '◉' : c === 'MEDIUM' ? '◐' : '◯';
  const tone = c === 'HIGH' ? 'pos' : c === 'MEDIUM' ? 'accent' : 'warn';
  const delta = Number.isFinite(sm.delta) ? `${sm.delta > 0 ? '+' : ''}${sm.delta.toFixed(1)}` : '—';
  const prior = sm.cohort_prior_used ? 'prior de cohorte' : 'prior global';
  return badge(`${glyph} ${c}`, tone, `Ajuste por confianza ${delta} · ${prior} · n=${sm.cohort_n ?? '—'}`);
}

export function symbolBadges(symbols) {
  const list = Array.isArray(symbols) ? symbols : [];
  if (!list.length) return '<span class="cc-faint">—</span>';
  return list.slice(0, 4).map((s) => badge(s, 'neutral')).join(' ')
    + (list.length > 4 ? ` <span class="cc-faint cc-xs">+${list.length - 4}</span>` : '');
}
