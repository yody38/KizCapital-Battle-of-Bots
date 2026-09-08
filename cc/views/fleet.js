// cc/views/fleet.js — Fleet Explorer.
//
// Una sola poblacion (todos los bots del ciclo) y muchas preguntas encima:
// busqueda universal, filtros facetados, el Query DSL para lo que los filtros
// no expresan, columnas configurables y vistas guardadas.
//
// La tabla es virtualizada (cc/ui/vtable.js): 10.000 filas no generan 10.000
// nodos, solo los visibles mas 20 de margen.

import { createVTable } from '../ui/vtable.js';
import { esc, usd, int, num, pct, pf, vpsName } from '../ui/fmt.js';
import { statusBadge, stageBadge, badge } from '../ui/badge.js';
import { freshnessBadge } from '../ui/freshness-badge.js';
import { emptyState } from '../ui/kpi.js';
import { run as runQuery, haystack, FIELD_NAMES } from '../data/query.js';
import { realLogins, honestNet, botKeyOf } from '../data/model.js';

// Presets: los mismos que views.js:9-20 del dashboard legacy, expresados en el
// mismo DSL, mas ALL / REAL / DEMO que aqui son navegacion basica.
const PRESETS = [
  { id: 'all', label: 'Todos', q: '' },
  { id: 'real', label: 'Reales', q: 'stage = "REAL" SORT BY net DESC' },
  { id: 'demo', label: 'Demo', q: 'stage != "REAL" SORT BY net DESC' },
  { id: 'weekly', label: 'Top semanal', q: 'stage != "REAL" SORT BY net_7d DESC LIMIT 20' },
  { id: 'monthly', label: 'Top mensual', q: 'stage != "REAL" SORT BY net_30d DESC LIMIT 20' },
  { id: 'consistency', label: 'Consistencia', q: 'months_active >= 3 AND stage != "REAL" SORT BY consistency DESC LIMIT 20' },
  { id: 'stability', label: 'Estabilidad', q: 'trades >= 30 AND stage != "REAL" SORT BY stability DESC LIMIT 20' },
  { id: 'sharpe', label: 'Sharpe', q: 'trades >= 30 AND stage != "REAL" SORT BY sharpe DESC LIMIT 20' },
  { id: 'recovery', label: 'Recovery', q: 'trades >= 30 AND stage != "REAL" SORT BY recovery DESC LIMIT 20' },
  { id: 'lowdd', label: 'Menor DD', q: 'trades >= 30 AND net > 0 AND stage != "REAL" SORT BY dd_pct ASC LIMIT 20' },
  { id: 'science', label: 'Score cientifico', q: 'evidence_tier != "UNKNOWN" AND stage != "REAL" SORT BY scientific_score DESC LIMIT 20' },
  { id: 'promotion', label: 'Score promocion', q: 'stage = "CANDIDATE" OR stage = "OBSERVATION" SORT BY score_shrunk DESC LIMIT 20' },
  { id: 'improving', label: 'Mejorando', q: 'trades >= 30 AND stage != "REAL" SORT BY improvement DESC LIMIT 20' },
  { id: 'ready', label: 'READY', q: 'status = "READY" SORT BY score DESC' },
  { id: 'near', label: 'NEAR', q: 'status = "NEAR" SORT BY score DESC' },
  { id: 'watch', label: 'WATCH', q: 'status = "WATCH" SORT BY score DESC' },
  { id: 'drawdown', label: 'Drawdown alto', q: 'dd_pct > 10 SORT BY dd_pct DESC' },
  { id: 'dormant', label: 'Dormidos', q: 'dormant = TRUE SORT BY days_since_last_trade DESC' },
  { id: 'new', label: 'Nuevos', q: 'stage = "NEW" SORT BY trades DESC' },
  { id: 'deteriorating', label: 'Deteriorandose', q: 'decay_flag = TRUE SORT BY net DESC' },
  { id: 'anomalies', label: 'Anomalias', q: 'drift_flag = TRUE SORT BY drift_severity DESC' },
];

const ALL_COLUMNS = [
  { key: 'rank', label: '#', width: 52, align: 'num', sortable: false },
  { key: 'score', label: 'Score', width: 74, align: 'num' },
  { key: 'status', label: 'Estado', width: 96 },
  { key: 'stage', label: 'Etapa', width: 116 },
  { key: 'magic', label: 'Magic', width: 96 },
  { key: 'vps', label: 'VPS', width: 76 },
  { key: 'login', label: 'Cuenta', width: 96 },
  { key: 'symbols', label: 'Simbolo', width: 130 },
  { key: 'trades', label: 'Trades', width: 78, align: 'num' },
  { key: 'win_rate', label: 'Win %', width: 76, align: 'num' },
  { key: 'pf', label: 'PF', width: 66, align: 'num' },
  { key: 'expectancy', label: 'Expect.', width: 90, align: 'num' },
  { key: 'calmar', label: 'Calmar', width: 76, align: 'num' },
  { key: 'sortino', label: 'Sortino', width: 78, align: 'num' },
  { key: 'sharpe', label: 'Sharpe', width: 78, align: 'num' },
  { key: 'dd_pct', label: 'DD %', width: 76, align: 'num' },
  { key: 'max_dd', label: 'DD max', width: 96, align: 'num' },
  { key: 'months', label: 'Meses', width: 72, align: 'num' },
  { key: 'dsl', label: 'Dias s/op', width: 88, align: 'num' },
  { key: 'net_7d', label: 'Net 7d', width: 96, align: 'num' },
  { key: 'net_30d', label: 'Net 30d', width: 100, align: 'num' },
  { key: 'net', label: 'Net', width: 116, align: 'num' },
  { key: 'nac', label: 'Net s/comision', width: 126, align: 'num' },
  { key: 'flags', label: 'Alertas', width: 150, sortable: false },
];

const DEFAULT_COLS = ['rank', 'score', 'status', 'magic', 'vps', 'login', 'symbols',
  'trades', 'win_rate', 'pf', 'dd_pct', 'net', 'flags'];

const LS_VIEWS = 'cc.fleet.views';
const LS_COLS = 'cc.fleet.columns';

let table = null;
let ctxRef = null;
let elRef = null;
let state = null;

export function mount(el, params, ctx) {
  elRef = el;
  ctxRef = ctx;
  ctx.layout.setTitle('Flota');
  ctx.layout.setExtra(freshnessBadge(ctx.meta()));

  const snap = ctx.snapshot();
  if (!snap || !Array.isArray(snap.bots) || !snap.bots.length) {
    el.innerHTML = emptyState('Sin bots en el ciclo',
      'data/snapshot.json no trajo la lista de bots. No se muestra ninguna cifra derivada de un archivo que no existe.',
      !snap);
    return;
  }

  const q = params && params.query ? params.query : {};
  state = {
    search: q.search || '',
    dsl: q.q || (q.view ? (PRESETS.find((p) => p.id === q.view) || {}).q || '' : ''),
    preset: q.view || (q.q ? null : 'all'),
    kind: q.kind || 'all',        // all | real | demo
    vps: q.vps || 'all',
    account: q.account || 'all',
    symbol: q.symbol || 'all',
    status: q.status || 'all',
    seat: q.seat || 'all',        // asiento de promocion: ready/near/watch/none
    age: q.age || 'all',          // <3m / 3-12m / >12m
    activity: q.activity || 'all',// activos / dormidos
    dd: q.dd || 'all',            // <5 / 5-10 / >10
    profit: q.profit || 'all',    // positivos / negativos
    cols: loadCols(),
    error: null,
  };

  renderChrome();
  buildTable();
  applyAll();
}

export function unmount() {
  if (table) { table.destroy(); table = null; }
  elRef = null; ctxRef = null; state = null;
}

// ---------------------------------------------------------------- persistencia

function loadCols() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_COLS));
    if (Array.isArray(raw) && raw.length) return raw.filter((k) => ALL_COLUMNS.some((c) => c.key === k));
  } catch { /* modo privado o JSON corrupto: se usan las por defecto */ }
  return DEFAULT_COLS.slice();
}
function saveCols(cols) {
  try { localStorage.setItem(LS_COLS, JSON.stringify(cols)); } catch { /* cuota */ }
}
function loadViews() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_VIEWS));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function saveViews(v) {
  try { localStorage.setItem(LS_VIEWS, JSON.stringify(v)); } catch { /* cuota */ }
}

// ---------------------------------------------------------------------- chrome

function renderChrome() {
  const snap = ctxRef.snapshot();
  const bots = snap.bots;
  const vpsIds = [...new Set(bots.map((b) => b.vps))].filter(Boolean).sort();
  const logins = [...new Set(bots.map((b) => b.account_login))].filter(Boolean).sort();
  const symbols = [...new Set(bots.flatMap((b) => (b.symbols || []).map((s) => String(s).split('.')[0].toUpperCase())))].sort();
  const statuses = [...new Set(bots.map((b) => b.promotion_status).filter(Boolean))].sort();

  elRef.innerHTML = `
    <section class="cc-stack">
      <div class="cc-row">
        <input id="fl-search" class="cc-input cc-input--wide" type="search" placeholder="Buscar magic, cuenta, VPS, simbolo, etapa, gm_id…" value="${esc(state.search)}">
        <button class="cc-btn" id="fl-save" type="button">Guardar vista</button>
        <select class="cc-select" id="fl-views"><option value="">Vistas guardadas…</option></select>
        <button class="cc-btn cc-btn--ghost cc-btn--danger" id="fl-del" type="button" title="Borrar la vista guardada seleccionada">✕</button>
      </div>

      <div class="cc-row" id="fl-presets">
        <span class="cc-faint cc-xs">Vistas:</span>
        ${PRESETS.map((p) => `<button class="cc-chip${state.preset === p.id ? ' is-active' : ''}" data-preset="${p.id}" type="button" title="${esc(p.q || 'sin filtro')}">${esc(p.label)}</button>`).join('')}
      </div>

      <div class="cc-row">
        ${select('fl-kind', 'Tipo', state.kind, [['all', 'Demo y real'], ['demo', 'Solo demo'], ['real', 'Solo real']])}
        ${select('fl-vps', 'VPS', state.vps, [['all', 'Todas'], ...vpsIds.map((v) => [v, vpsName(v)])])}
        ${select('fl-account', 'Cuenta', state.account, [['all', 'Todas'], ...logins.map((l) => [String(l), '#' + l])])}
        ${select('fl-symbol', 'Simbolo', state.symbol, [['all', 'Todos'], ...symbols.map((s) => [s, s])])}
        ${select('fl-status', 'Estado', state.status, [['all', 'Todos'], ...statuses.map((s) => [s, s])])}
        ${select('fl-seat', 'Asiento', state.seat, [['all', 'Cualquiera'], ['ready', 'READY'], ['near', 'NEAR'], ['watch', 'WATCH'], ['none', 'Sin asiento']])}
        ${select('fl-age', 'Edad', state.age, [['all', 'Cualquiera'], ['new', '< 3 meses'], ['mid', '3-12 meses'], ['old', '> 12 meses']])}
        ${select('fl-activity', 'Actividad', state.activity, [['all', 'Cualquiera'], ['active', 'Activos'], ['dormant', 'Dormidos'], ['recent', 'Operaron esta semana']])}
        ${select('fl-dd', 'Drawdown', state.dd, [['all', 'Cualquiera'], ['low', '< 5% del balance'], ['mid', '5-10%'], ['high', '> 10%']])}
        ${select('fl-profit', 'Rentabilidad', state.profit, [['all', 'Cualquiera'], ['pos', 'Net > 0'], ['neg', 'Net <= 0']])}
        <button class="cc-btn cc-btn--ghost" id="fl-reset" type="button">Limpiar filtros</button>
      </div>

      <details class="cc-card cc-card--flat">
        <summary class="cc-small cc-muted" style="cursor:pointer">Consulta avanzada y columnas</summary>
        <div class="cc-stack" style="margin-top:12px">
          <div class="cc-row">
            <input id="fl-dsl" class="cc-input cc-input--wide cc-mono" type="text"
              placeholder='trades &gt; 30 AND dd_pct &lt; 8 SORT BY score DESC LIMIT 50'
              value="${esc(state.dsl)}">
            <button class="cc-btn" id="fl-dsl-run" type="button">Aplicar</button>
            <button class="cc-btn cc-btn--ghost" id="fl-dsl-clear" type="button">Vaciar</button>
          </div>
          <div id="fl-dsl-err" class="cc-banner cc-banner--crit" hidden></div>
          <div class="cc-xs cc-faint">Campos: ${FIELD_NAMES.map((f) => `<code>${esc(f)}</code>`).join(' · ')}</div>
          <div class="cc-row" id="fl-cols">
            <span class="cc-faint cc-xs">Columnas:</span>
            ${ALL_COLUMNS.map((c) => `<button class="cc-chip${state.cols.includes(c.key) ? ' is-active' : ''}" data-col="${c.key}" type="button">${esc(c.label)}</button>`).join('')}
          </div>
        </div>
      </details>

      <div class="cc-row cc-small cc-muted" id="fl-count"></div>
      <div id="fl-table"></div>
    </section>`;

  wire();
  refreshViewsSelect();
}

function select(id, label, value, options) {
  return `<label class="cc-row cc-xs cc-faint" style="gap:4px">
    <span>${esc(label)}</span>
    <select class="cc-select" id="${id}">
      ${options.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`).join('')}
    </select>
  </label>`;
}

function wire() {
  const $ = (id) => elRef.querySelector('#' + id);

  let searchTimer = 0;
  $('fl-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applyAll, 180);
  });

  for (const [id, key] of [['fl-kind', 'kind'], ['fl-vps', 'vps'], ['fl-account', 'account'],
    ['fl-symbol', 'symbol'], ['fl-status', 'status'], ['fl-seat', 'seat'], ['fl-age', 'age'],
    ['fl-activity', 'activity'], ['fl-dd', 'dd'], ['fl-profit', 'profit']]) {
    $(id).addEventListener('change', (e) => { state[key] = e.target.value; applyAll(); });
  }

  $('fl-reset').addEventListener('click', () => {
    Object.assign(state, { kind: 'all', vps: 'all', account: 'all', symbol: 'all', status: 'all',
      seat: 'all', age: 'all', activity: 'all', dd: 'all', profit: 'all', search: '', dsl: '', preset: 'all' });
    renderChrome();
    buildTable();
    applyAll();
  });

  elRef.querySelector('#fl-presets').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-preset]');
    if (!btn) return;
    const p = PRESETS.find((x) => x.id === btn.dataset.preset);
    if (!p) return;
    state.preset = p.id;
    state.dsl = p.q;
    $('fl-dsl').value = p.q;
    elRef.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('is-active', b === btn));
    applyAll();
  });

  $('fl-dsl-run').addEventListener('click', () => { state.dsl = $('fl-dsl').value; state.preset = null; applyAll(); });
  $('fl-dsl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { state.dsl = e.target.value; state.preset = null; applyAll(); }
  });
  $('fl-dsl-clear').addEventListener('click', () => { $('fl-dsl').value = ''; state.dsl = ''; applyAll(); });

  elRef.querySelector('#fl-cols').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-col]');
    if (!btn) return;
    const key = btn.dataset.col;
    const i = state.cols.indexOf(key);
    if (i >= 0) { if (state.cols.length === 1) return; state.cols.splice(i, 1); }
    else state.cols.push(key);
    // Se conserva el orden canonico de ALL_COLUMNS, no el de clic.
    state.cols = ALL_COLUMNS.map((c) => c.key).filter((k) => state.cols.includes(k));
    saveCols(state.cols);
    btn.classList.toggle('is-active', state.cols.includes(key));
    buildTable();
    applyAll();
  });

  $('fl-save').addEventListener('click', () => {
    const name = prompt('Nombre de la vista:');
    if (!name) return;
    const views = loadViews().filter((v) => v.name !== name);
    views.push({ name, state: { ...state, cols: undefined } });
    saveViews(views);
    refreshViewsSelect(name);
  });

  $('fl-views').addEventListener('change', (e) => {
    const v = loadViews().find((x) => x.name === e.target.value);
    if (!v) return;
    Object.assign(state, v.state, { cols: state.cols });
    renderChrome();
    buildTable();
    applyAll();
    elRef.querySelector('#fl-views').value = v.name;
  });

  $('fl-del').addEventListener('click', () => {
    const sel = $('fl-views').value;
    if (!sel) return;
    saveViews(loadViews().filter((v) => v.name !== sel));
    refreshViewsSelect();
  });
}

function refreshViewsSelect(selected) {
  const sel = elRef.querySelector('#fl-views');
  if (!sel) return;
  const views = loadViews();
  sel.innerHTML = '<option value="">Vistas guardadas…</option>'
    + views.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
  if (selected) sel.value = selected;
}

// ----------------------------------------------------------------- la tabla

function buildTable() {
  const host = elRef.querySelector('#fl-table');
  if (!host) return;
  if (table) table.destroy();
  const cols = state.cols.map((k) => ALL_COLUMNS.find((c) => c.key === k)).filter(Boolean).map(colSpec);
  table = createVTable(host, {
    columns: cols,
    rowHeight: 34,
    height: 'min(62vh, 620px)',
    rowClass: (row) => (row.__real ? 'is-real' : ''),
    emptyHtml: '<strong>Sin resultados</strong>Ningun bot cumple la busqueda, los filtros y la consulta a la vez.',
    onRowClick: (row) => { location.hash = `#/bot/${row.vps}/${row.account_login}/${row.magic}`; },
  });
  // Orden por defecto: el mismo criterio del ranking legacy (Net Profit desc).
  if (state.cols.includes('net')) table.sortBy('net', 'desc');
}

function colSpec(c) {
  const base = { key: c.key, label: c.label, width: c.width, align: c.align, sortable: c.sortable };
  switch (c.key) {
    case 'rank': return { ...base, text: (r, i) => String(i + 1), sortable: false };
    case 'score': return { ...base, sortValue: (r) => r.promotion_score, text: (r) => num(r.promotion_score, 1) };
    case 'status': return { ...base, sortValue: (r) => r.promotion_status, render: (r) => statusBadge(r.promotion_status) };
    case 'stage': return { ...base, sortValue: (r) => (r.lifecycle && r.lifecycle.stage) || '', render: (r) => stageBadge(r.lifecycle && r.lifecycle.stage, r.lifecycle && r.lifecycle.historical_reason) };
    case 'magic': return { ...base, sortValue: (r) => r.magic, text: (r) => String(r.magic) };
    case 'vps': return { ...base, sortValue: (r) => r.vps, text: (r) => vpsName(r.vps) };
    case 'login': return { ...base, sortValue: (r) => r.account_login, text: (r) => '#' + r.account_login };
    case 'symbols': return { ...base, sortValue: (r) => (r.symbols || [])[0] || '', text: (r) => (r.symbols || []).join(', ') || '—' };
    case 'trades': return { ...base, sortValue: (r) => r.trades, text: (r) => int(r.trades) };
    case 'win_rate': return { ...base, sortValue: (r) => r.win_rate_pct, text: (r) => pct(r.win_rate_pct) };
    case 'pf': return { ...base, sortValue: (r) => r.profit_factor, text: (r) => pf(r.profit_factor) };
    case 'expectancy': return { ...base, sortValue: (r) => r.expectancy, text: (r) => usd(r.expectancy, true) };
    case 'calmar': return { ...base, sortValue: (r) => r.calmar, text: (r) => num(r.calmar) };
    case 'sortino': return { ...base, sortValue: (r) => r.sortino, text: (r) => num(r.sortino) };
    case 'sharpe': return { ...base, sortValue: (r) => r.sharpe_annualized, text: (r) => num(r.sharpe_annualized) };
    case 'dd_pct': return { ...base, sortValue: (r) => r.dd_pct_of_balance, text: (r) => pct(r.dd_pct_of_balance) };
    case 'max_dd': return { ...base, sortValue: (r) => r.max_drawdown, text: (r) => usd(r.max_drawdown) };
    case 'months': return { ...base, sortValue: (r) => r.months_active, text: (r) => num(r.months_active, 1) };
    case 'dsl': return { ...base, sortValue: (r) => r.days_since_last_trade, text: (r) => (r.days_since_last_trade == null ? '—' : String(r.days_since_last_trade)) };
    case 'net_7d': return { ...base, sortValue: (r) => r.net_7d, render: (r) => signed(r.net_7d) };
    case 'net_30d': return { ...base, sortValue: (r) => r.net_30d, render: (r) => signed(r.net_30d) };
    case 'net': return { ...base, sortValue: (r) => r.net_profit, render: (r) => signed(r.net_profit) };
    case 'nac': return { ...base, sortValue: (r) => r.net_after_commission, render: (r) => signed(r.net_after_commission) };
    case 'flags': return { ...base, sortable: false, render: (r) => flags(r) };
    default: return { ...base, text: (r) => String(r[c.key] ?? '—') };
  }
}

function signed(v) {
  if (v == null || !Number.isFinite(Number(v))) return '<span class="cc-faint">—</span>';
  const cls = Number(v) >= 0 ? 'cc-pos' : 'cc-neg';
  return `<span class="${cls}">${esc(usd(v, true))}</span>`;
}

function flags(b) {
  const out = [];
  if (b.decay_flag) out.push(badge('decay', 'neg', `decay_ratio ${b.decay_ratio ?? '—'}`));
  if (b.drift && b.drift.flag) out.push(badge('drift', 'warn', `severidad ${b.drift.severity ?? '—'}×`));
  if (b.dormant) out.push(badge('dormido', 'warn', `${b.days_since_last_trade ?? '—'} d sin operar`));
  if (b.provisional_low_confidence) out.push(badge('provisional', 'warn'));
  if (b.tribunal && b.tribunal.rank != null && !b.tribunal.is_suplente) out.push(badge('podio', 'accent'));
  return out.join(' ') || '<span class="cc-faint">—</span>';
}

// ------------------------------------------------------------------ filtrado

function applyAll() {
  if (!ctxRef || !table) return;
  const snap = ctxRef.snapshot();
  const logins = realLogins(snap);
  const accById = new Map((snap.accounts || []).map((a) => [`${a.vps}-${a.login}`, a]));

  // Copia superficial con los derivados de vista. NO se toca el objeto del
  // snapshot: la busqueda no puede depender de por donde hayas navegado.
  let rows = snap.bots.map((b) => ({ ...b, __real: logins.has(b.account_login), __key: botKeyOf(b) }));

  rows = rows.filter((b) => passesFacets(b));

  const term = state.search.trim().toLowerCase();
  if (term) {
    const tokens = term.split(/\s+/).filter(Boolean);
    rows = rows.filter((b) => {
      const hs = b.__hay || (b.__hay = haystack(b, accById.get(`${b.vps}-${b.account_login}`)));
      return tokens.every((t) => hs.includes(t));
    });
  }

  const res = runQuery(state.dsl, rows);
  const errBox = elRef.querySelector('#fl-dsl-err');
  if (errBox) {
    errBox.hidden = !res.error;
    errBox.textContent = res.error ? '⚠ ' + res.error : '';
  }
  const final = res.error ? [] : res.rows;

  // Si la consulta trae su propio SORT BY, manda ella: la tabla deja de
  // reordenar para no pisar el orden que pidio el usuario.
  if (res.q && res.q.sortField) table.sortBy(null);
  table.setRows(final);

  const counter = elRef.querySelector('#fl-count');
  if (counter) {
    counter.innerHTML = `<strong>${int(final.length)}</strong> de ${int(snap.bots.length)} bots`
      + (state.dsl ? ` · consulta activa` : '')
      + ` · <span class="cc-faint">clic en una fila para abrir el Bot 360</span>`;
  }
}

function passesFacets(b) {
  const s = state;
  if (s.kind === 'real' && !b.__real) return false;
  if (s.kind === 'demo' && b.__real) return false;
  if (s.vps !== 'all' && b.vps !== s.vps) return false;
  if (s.account !== 'all' && String(b.account_login) !== s.account) return false;
  if (s.symbol !== 'all') {
    const syms = (b.symbols || []).map((x) => String(x).split('.')[0].toUpperCase());
    if (!syms.includes(s.symbol)) return false;
  }
  if (s.status !== 'all' && b.promotion_status !== s.status) return false;

  if (s.seat !== 'all') {
    const st = b.promotion_status;
    if (s.seat === 'none') { if (['READY', 'NEAR', 'WATCH'].includes(st)) return false; }
    else if (st !== s.seat.toUpperCase()) return false;
  }

  if (s.age !== 'all') {
    const m = Number(b.months_active);
    if (!Number.isFinite(m)) return false;
    if (s.age === 'new' && !(m < 3)) return false;
    if (s.age === 'mid' && !(m >= 3 && m <= 12)) return false;
    if (s.age === 'old' && !(m > 12)) return false;
  }

  if (s.activity !== 'all') {
    if (s.activity === 'dormant' && !b.dormant) return false;
    if (s.activity === 'active' && b.dormant) return false;
    if (s.activity === 'recent') {
      const d = Number(b.days_since_last_trade);
      if (!Number.isFinite(d) || d > 7) return false;
    }
  }

  if (s.dd !== 'all') {
    const dd = Number(b.dd_pct_of_balance);
    if (!Number.isFinite(dd)) return false;   // sin dato no entra en un bucket
    if (s.dd === 'low' && !(dd < 5)) return false;
    if (s.dd === 'mid' && !(dd >= 5 && dd <= 10)) return false;
    if (s.dd === 'high' && !(dd > 10)) return false;
  }

  if (s.profit !== 'all') {
    const n = honestNet(b);
    if (n == null) return false;
    if (s.profit === 'pos' && !(n > 0)) return false;
    if (s.profit === 'neg' && !(n <= 0)) return false;
  }
  return true;
}

export { PRESETS, ALL_COLUMNS };
