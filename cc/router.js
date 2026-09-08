// cc/router.js — router por hash, cero dependencias.
//
// Cada vista tiene URL propia, asi que Atras/Adelante del navegador funcionan
// (el dashboard legacy no usa pushState y por eso Atras salia del panel).
//
// Formato: #/<ruta>?<query>   ej. #/fleet?q=trades%20%3E%2030&view=ready
// Compat: un hash suelto `#q=<expr>` (el deep link del dashboard viejo) se
// reescribe a #/fleet?q=<expr> con replace, para no dejar basura en el
// historial.

const ROUTES = [
  { name: 'home', pattern: '/home', params: [] },
  { name: 'fleet', pattern: '/fleet', params: [] },
  { name: 'bot', pattern: '/bot/:vps/:login/:magic', params: ['vps', 'login', 'magic'] },
  { name: 'account', pattern: '/account/:vps/:login', params: ['vps', 'login'] },
  { name: 'real', pattern: '/real', params: [] },
  { name: 'promotion', pattern: '/promotion', params: [] },
  { name: 'portfolio', pattern: '/portfolio', params: [] },
  { name: 'health', pattern: '/health', params: [] },
];

const DEFAULT_ROUTE = '/home';

// Se compila una vez: /bot/:vps/:login/:magic -> ^/bot/([^/]+)/([^/]+)/([^/]+)$
const COMPILED = ROUTES.map((r) => ({
  ...r,
  re: new RegExp('^' + r.pattern.replace(/:[A-Za-z_]+/g, '([^/]+)') + '/?$'),
}));

let listeners = [];
let started = false;
let current = null;

/** Trocea un hash en {name, params, query, path, raw}. */
export function parse(hash) {
  let h = String(hash == null ? (typeof location !== 'undefined' ? location.hash : '') : hash);
  if (h.startsWith('#')) h = h.slice(1);
  if (!h) h = DEFAULT_ROUTE;

  // Compat legacy: `#q=<expr>` (sin barra inicial) es una consulta de flota.
  if (!h.startsWith('/') && /^q=/.test(h)) {
    return {
      name: 'fleet',
      params: {},
      query: parseQueryString(h),
      path: '/fleet',
      raw: h,
      legacyQuery: true,
    };
  }
  if (!h.startsWith('/')) h = '/' + h;

  const qi = h.indexOf('?');
  const path = qi >= 0 ? h.slice(0, qi) : h;
  const qs = qi >= 0 ? h.slice(qi + 1) : '';
  const query = parseQueryString(qs);

  for (const r of COMPILED) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params = {};
    r.params.forEach((p, i) => { params[p] = safeDecode(m[i + 1]); });
    return { name: r.name, params, query, path, raw: h };
  }
  // Ruta desconocida -> home. Nunca una pantalla en blanco.
  return { name: 'home', params: {}, query, path: DEFAULT_ROUTE, raw: h, unknown: true };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function parseQueryString(qs) {
  const out = {};
  for (const part of String(qs || '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = safeDecode(eq >= 0 ? part.slice(0, eq) : part);
    const v = eq >= 0 ? safeDecode(part.slice(eq + 1).replace(/\+/g, ' ')) : '';
    if (k) out[k] = v;
  }
  return out;
}

export function buildQueryString(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

/** Construye una ruta canonica: build('bot', {vps,login,magic}, {section:'H'}). */
export function build(name, params = {}, query = {}) {
  const r = ROUTES.find((x) => x.name === name);
  if (!r) return '#' + DEFAULT_ROUTE;
  let path = r.pattern;
  for (const p of r.params) path = path.replace(':' + p, encodeURIComponent(params[p] ?? ''));
  const qs = buildQueryString(query);
  return '#' + path + (qs ? '?' + qs : '');
}

/** Navega. `replace` no deja entrada en el historial. */
export function navigate(path, { replace = false } = {}) {
  let target = String(path || DEFAULT_ROUTE);
  if (!target.startsWith('#')) target = '#' + (target.startsWith('/') ? target : '/' + target);
  if (typeof location === 'undefined') return;
  if (location.hash === target) { emit(); return; }
  if (replace) {
    const url = location.pathname + location.search + target;
    history.replaceState(null, '', url);
    emit();
  } else {
    location.hash = target;   // dispara hashchange -> emit()
  }
}

export function onChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}

export function route() { return current; }

function emit() {
  const parsed = parse(location.hash);

  // Normalizaciones que SI reescriben la URL (siempre con replace):
  //  · hash vacio o desconocido -> #/home
  //  · deep link legacy `#q=…`   -> #/fleet?q=…
  if (parsed.legacyQuery) {
    const qs = buildQueryString(parsed.query);
    navigate('/fleet' + (qs ? '?' + qs : ''), { replace: true });
    return;
  }
  if (!location.hash || parsed.unknown) {
    navigate(DEFAULT_ROUTE, { replace: true });
    return;
  }

  current = parsed;
  for (const fn of listeners) {
    try { fn(parsed); } catch (err) { console.error('[cc] router listener lanzo', err); }
  }
}

export function start() {
  if (started) return;
  started = true;
  window.addEventListener('hashchange', emit);
  emit();
}

export function stop() {
  started = false;
  window.removeEventListener('hashchange', emit);
}

export const ROUTE_NAMES = ROUTES.map((r) => r.name);
