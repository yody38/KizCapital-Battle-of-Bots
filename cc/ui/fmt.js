// cc/ui/fmt.js — formateo. Regla unica: un dato que no existe se pinta '—',
// NUNCA 0. Un cero inventado en una columna de dinero es una mentira barata.

const EM = '—';

export function usd(n, signed = false) {
  if (n == null || !Number.isFinite(Number(n))) return EM;
  const v = Number(n);
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = v < 0 ? '-' : (signed ? '+' : '');
  return `${sign}$${s}`;
}

export function usdCompact(n) {
  if (n == null || !Number.isFinite(Number(n))) return EM;
  const v = Number(n);
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}$${Math.round(a / 1e3)}K`;
  return usd(v);
}

export function int(n) {
  if (n == null || !Number.isFinite(Number(n))) return EM;
  return Number(n).toLocaleString('en-US');
}

export function num(n, digits = 2) {
  if (n == null || !Number.isFinite(Number(n))) return EM;
  return Number(n).toFixed(digits);
}

export function pct(n, digits = 1) {
  if (n == null || !Number.isFinite(Number(n))) return EM;
  return `${Number(n).toFixed(digits)}%`;
}

/** Profit factor: null significa "sin perdidas", no "cero". */
export function pf(n) {
  if (n == null) return '∞';
  if (!Number.isFinite(Number(n))) return EM;
  return Number(n).toFixed(2);
}

export function rho(n) {
  if (n == null || !Number.isFinite(Number(n))) return EM;
  return Number(n).toFixed(2);
}

export function signClass(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '';
  return v > 0 ? 'cc-pos' : 'cc-neg';
}

export function dateTime(iso) {
  if (!iso) return EM;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return EM;
  return new Date(t).toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function dateOnly(iso) {
  if (!iso) return EM;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return EM;
  return new Date(t).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function shortTime(iso) {
  if (!iso) return EM;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return EM;
  return new Date(t).toLocaleString('es-ES', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** Segundos unix -> fecha corta (los trades del per-bot vienen en epoch). */
export function unixShort(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return EM;
  return shortTime(new Date(Number(sec) * 1000).toISOString());
}

export function days(n) {
  if (n == null || !Number.isFinite(Number(n))) return EM;
  return `${Math.round(Number(n))} d`;
}

/** Escapa texto que va a innerHTML. Todo dato del snapshot pasa por aqui. */
export function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function vpsName(id) { return String(id || '').toUpperCase(); }

export { EM as DASH };
