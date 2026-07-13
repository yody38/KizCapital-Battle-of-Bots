// Battle of Bots — dashboard UI logic (multi-VPS).
// Loads data/snapshot.json, renders stats/podium/chart/table with animations.

const fmt = {
  usd: (n, signed = false) => {
    const v = Number(n || 0);
    const sign = signed && v > 0 ? '+' : '';
    return sign + v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  },
  int: (n) => Number(n || 0).toLocaleString('en-US'),
  pct: (n) => `${Number(n || 0).toFixed(1)}%`,
  pf: (n) => (n == null ? '∞' : Number(n).toFixed(2)),
  shortTime: (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = new Date();
    const diffHours = (now - d) / 36e5;
    if (diffHours < 24) return `${Math.floor(diffHours)}h atrás`;
    if (diffHours < 24 * 7) return `${Math.floor(diffHours / 24)}d atrás`;
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  },
  dateTime: (iso) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  },
};

const state = {
  snapshot: null,
  bots: [],
  demoBots: [],
  demoAccounts: [],
  realLogins: new Set(),
  filteredBots: [],
  sort: { key: 'net_profit', dir: 'desc' },
  filter: 'all',
  vpsFilter: 'all',
  search: '',
  newBotsFilter: 'all',
  newBotsVps: 'all',
  newBotsSearch: '',
  chart: null,
  history: [],
  sparkCharts: {},
  candidatesStatusFilter: 'READY',
  correlations: null,
  realLogins: new Set(),
  realMagics: new Set(),  // magics (EAs) already deployed to real — excluded from promotion-discovery views
  query: { text: '', visible: false, savedViews: [] },
  compareList: [], // {vps, login, magic, bot, trades, daily}
};

// Live equity stream (real accounts) — populated by initLiveStream().
const liveState = {
  channel: null,
  conn: null,             // managed transport handle (kizLiveReal.connect)
  transport: null,        // 'realtime' | 'polling' (REST fallback)
  initialized: false,
  byLogin: new Map(),     // login -> latest row from public.live_real_state
  pollTimer: null,
};

// --- Math helpers --------------------------------------------------------

function wilsonLB(wins, n, z = 1.96) {
  if (!n) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

// --- Data loading --------------------------------------------------------

// --- stale-while-revalidate cache (instant first paint) ---------------------
// The last good snapshot is cached in localStorage so a returning user sees the
// dashboard immediately, then it revalidates from the network in the background.
// Staleness is ALWAYS surfaced (setFreshness reads generated_at) — we never paint
// a green "fresh" pill over cached data; the cached snapshot carries its own
// generated_at and the freshness logic ages it honestly.
const SNAP_CACHE_KEY = 'kiz.snapshot.v1';
const SNAP_ETAG_KEY = 'kiz.etag.snapshot';
const HIST_ETAG_KEY = 'kiz.etag.history';

// --- Delta sync (conditional GET) ----------------------------------------
// Sends If-None-Match with the last seen ETag so Storage answers 304 (no body)
// when the object hasn't changed since the previous load. Only used when
// `reusable` says we hold a local copy to fall back on; any header/CORS hiccup
// degrades to a plain fetch, so worst case is exactly today's behavior.
async function fetchIfChanged(url, etagKey, reusable) {
  let etag = null;
  if (reusable) { try { etag = localStorage.getItem(etagKey); } catch { /* private mode */ } }
  let res;
  try {
    res = await fetch(url, etag ? { headers: { 'If-None-Match': etag } } : undefined);
  } catch (err) {
    if (!etag) throw err;
    res = await fetch(url);  // conditional request rejected (e.g. preflight) → plain retry
  }
  if (res.ok) {
    const fresh = res.headers.get('ETag');
    try { if (fresh) localStorage.setItem(etagKey, fresh); } catch { /* quota */ }
  }
  return res;
}

// history_recent.jsonl carries only the rows the dashboard actually renders
// (real-account equity: sparklines + War Room weekly curve) — KBs instead of
// the multi-MB full history.jsonl, which stays in Storage as archive. Falls
// back to the full file while history_recent isn't deployed yet; a 304 reuses
// the rows already in memory.
async function loadHistoryRows() {
  const reusable = Array.isArray(state.history) && state.history.length > 0;
  let res = await fetchIfChanged('data/history_recent.jsonl', HIST_ETAG_KEY, reusable).catch(() => null);
  if (!res || res.status === 404) res = await fetch('data/history.jsonl').catch(() => null);
  if (res && res.status === 304) return state.history;
  if (!res || !res.ok) return [];
  const text = await res.text();
  return text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function readSnapCache() {
  try { const r = localStorage.getItem(SNAP_CACHE_KEY); return r ? JSON.parse(r) : null; }
  catch { return null; }
}
function writeSnapCache(data) {
  try { localStorage.setItem(SNAP_CACHE_KEY, JSON.stringify(data)); } catch { /* quota — non-fatal */ }
}

// Una cuenta real "vacía" (balance 0 y equity 0) no se muestra en la sección Cuentas Reales.
function isFundedRealAccount(a) {
  return !(Number(a.balance) === 0 && Number(a.equity) === 0);
}

// Pure processing of a snapshot object into app state + render. Shared by the
// instant cache paint and the live network load so both go through one path.
function applySnapshot(data) {
  state.snapshot = data;
  // Filter out pseudo-bots with magic=0 (manual/orphan trades, not real EAs — they have no per-bot file)
  if (data.bots) data.bots = data.bots.filter(b => b.magic && b.magic !== 0);
  state.bots = (data.bots || []).map((b, i) => ({ ...b, _rank: i + 1 }));
  const realAccts = (data.real_portfolio && data.real_portfolio.accounts) || [];
  state.realLogins = new Set(realAccts.map(a => a.login));
  // Magics (EAs) already deployed to a real account — excluded from the promotion-discovery
  // views (Candidatos/Tracker/Builder/Portfolio). Single source of truth: the backend emits
  // data.real_magics (detect_real_magics). Fall back to local derivation only if an old snapshot
  // (pre-rollout) lacks the field, so FE and BE never disagree once CI has run.
  if (Array.isArray(data.real_magics)) {
    state.realMagics = new Set(data.real_magics);
  } else {
    state.realMagics = new Set();
    (data.bots || []).forEach(b => { if (state.realLogins.has(b.account_login) && b.magic) state.realMagics.add(b.magic); });
    ((data.real_portfolio && data.real_portfolio.open_positions) || []).forEach(p => { if (p.magic) state.realMagics.add(p.magic); });
  }
  state.demoAccounts = (data.accounts || []).filter(a => !a.is_real);
  // Only show demo accounts where balance > $10,000 (initial deposit for all demo accounts)
  const DEMO_INITIAL_DEPOSIT = 10000;
  // Exclude bots already running on a real account — by login AND by magic (an EA
  // deployed to real must not compete in any section, even its demo twin).
  const allDemoBots = (data.bots || []).filter(b => !state.realLogins.has(b.account_login) && !state.realMagics.has(b.magic));
  const profitableLogins = new Set(
    state.demoAccounts
      .filter(a => (a.balance || 0) > DEMO_INITIAL_DEPOSIT)
      .map(a => String(a.login))
  );
  state.demoAccounts = state.demoAccounts.filter(a => profitableLogins.has(String(a.login)));
  state.demoBots = allDemoBots
    .filter(b => profitableLogins.has(String(b.account_login)))
    .filter(b => !isNewBot(b))  // new bots live only in the Bots Nuevos window
    .map((b, i) => ({ ...b, _rank: i + 1, _wilson: wilsonLB(b.wins || 0, b.trades || 0) * 100 }));
  render();
  // Apply URL hash query if present.
  try { loadFromHash(); } catch(e) { console.error(e); }
}

// Paint the cached snapshot synchronously on boot (before any network), so the
// dashboard is interactive instantly. No-op if there's no cache yet.
function paintCachedSnapshot() {
  const cached = readSnapCache();
  if (cached) { try { applySnapshot(cached); } catch (e) { console.error('cache paint failed', e); } }
}

async function loadSnapshot() {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('loading');
  try {
    const prev = state.snapshot;  // for "what moved" diff
    const [snapRes, histRows] = await Promise.all([
      fetchIfChanged('data/snapshot.json', SNAP_ETAG_KEY, !!readSnapCache()),
      loadHistoryRows().catch(() => []),
    ]);
    let data;
    if (snapRes.status === 304) {
      data = readSnapCache();  // unchanged upstream — reuse the local copy
      if (!data) throw new Error('304 sin cache local');
    } else {
      if (!snapRes.ok) throw new Error(`HTTP ${snapRes.status}`);
      data = await snapRes.json();
    }
    state.history = histRows || [];
    applySnapshot(data);
    // "What moved" since the previous render (cache or prior cycle), derived
    // 100% in the browser — no backend file (Rule of Three: build it when a
    // consumer like Telegram exists). Surfaced in the latency modal.
    try { computeWhatMoved(prev, data); } catch (e) { console.error(e); }
    if (snapRes.status !== 304) writeSnapCache(data);
    initSnapshotPush();  // idempotente; aquí la sesión ya está viva (fetch firmado OK)
  } catch (err) {
    console.error(err);
    // Keep whatever the cache painted; only flag freshness if we have nothing.
    if (!state.snapshot) setFreshness(null, err.message);
  } finally {
    btn.classList.remove('loading');
  }
}

// --- Snapshot push (auto-refresh sin reload) ------------------------------
// upload_to_supabase.py upserta snapshot_meta {manifest_sha} al cierre de cada
// ciclo de CI. Aquí: suscripción Realtime para el push instantáneo + poll de
// respaldo de 1 fila/60s (cubre socket caído y eventos perdidos). Cambio de
// sha → loadSnapshot() + toast. El primer valor visto es el baseline (el boot
// ya cargó ese mismo ciclo), así que no dispara recarga.
const snapPush = { initialized: false, lastSha: null, channel: null, pollTimer: null };

function _snapPushApply(row) {
  if (!row || !row.manifest_sha) return;
  if (snapPush.lastSha === row.manifest_sha) return;
  const first = snapPush.lastSha === null;
  snapPush.lastSha = row.manifest_sha;
  if (first) return;
  loadSnapshot();
  try {
    showToast({ type: 'success', icon: '📡', title: 'Datos actualizados', msg: 'Nuevo ciclo publicado — el dashboard se refrescó solo.' });
  } catch { /* toast es cosmético */ }
}

async function _snapPushPoll() {
  try {
    const { data, error } = await window.kizSupabase
      .from('snapshot_meta').select('manifest_sha').eq('id', 1).maybeSingle();
    if (!error && data) _snapPushApply(data);
  } catch { /* red caída — el próximo poll reintenta */ }
}

function initSnapshotPush() {
  if (snapPush.initialized || !window.kizSupabase) return;
  snapPush.initialized = true;
  snapPush.channel = window.kizSupabase
    .channel('kiz-snapshot-meta')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'snapshot_meta' },
      (payload) => _snapPushApply(payload.new))
    .subscribe();
  _snapPushPoll();
  snapPush.pollTimer = setInterval(_snapPushPoll, 60000);
}

// --- Staleness banner (out-of-band sync alert) ---------------------------
// Reads s.generated_at and s.partial_data + s.vps_freshness from the snapshot
// and surfaces sync health prominently. Thresholds match heartbeat_check.py:
//   ≤ 35 min  → hidden
//   35–90 min → warn (yellow)
//   > 90 min  → critical (red, pulse)
function renderStalenessBanner(snap) {
  const el = document.getElementById('staleness-banner');
  if (!el) return;
  const textEl = el.querySelector('.staleness-banner__text');
  const partialEl = el.querySelector('.staleness-banner__partial');
  const iconEl = el.querySelector('.staleness-banner__icon');
  if (!snap || !snap.generated_at) {
    el.classList.add('hidden');
    return;
  }
  const lagMin = (Date.now() - new Date(snap.generated_at).getTime()) / 60000;
  const partial = snap.partial_data === true;
  const stalePerVps = snap.vps_freshness
    ? Object.entries(snap.vps_freshness)
        .filter(([, v]) => v && v.present && v.stale)
        .map(([k]) => k.toUpperCase())
    : [];

  el.classList.remove('warn', 'critical', 'hidden');

  if (lagMin <= 35 && !partial) {
    el.classList.add('hidden');
    return;
  }
  let cls = 'warn';
  let msg = `Sincronización con retraso: ${Math.floor(lagMin)} min sin actualizar. El sistema está reintentando.`;
  let icon = '⚠️';
  if (lagMin > 90) {
    cls = 'critical';
    icon = '🛑';
    const since = new Date(snap.generated_at);
    const hh = String(since.getUTCHours()).padStart(2,'0');
    const mm = String(since.getUTCMinutes()).padStart(2,'0');
    msg = `Datos no actualizados desde ${hh}:${mm} UTC (${Math.floor(lagMin)} min). Pipeline en investigación — recuperación automática en curso.`;
  } else if (partial && lagMin <= 35) {
    msg = 'Datos parciales: el último cycle se completó pero al menos una VPS no respondió.';
  }
  iconEl.textContent = icon;
  textEl.textContent = msg;
  el.classList.add(cls);

  if (stalePerVps.length) {
    partialEl.textContent = `VPS caídas: ${stalePerVps.join(', ')}`;
    partialEl.classList.remove('hidden');
  } else {
    partialEl.classList.add('hidden');
  }
}

// --- Freshness indicator -------------------------------------------------

function setFreshness(iso, errorMsg) {
  const el = document.getElementById('freshness');
  const label = el.querySelector('.label');
  el.classList.remove('fresh', 'warn', 'stale');
  if (errorMsg) { label.textContent = `Error: ${errorMsg}`; el.classList.add('stale'); return; }
  if (!iso) { label.textContent = 'Sin datos'; return; }
  const diffMin = (Date.now() - new Date(iso).getTime()) / 60000;
  let cls = 'fresh';
  if (diffMin > 180) cls = 'stale';
  else if (diffMin > 60) cls = 'warn';
  el.classList.add(cls);
  const mins = Math.floor(diffMin);
  if (mins < 1) label.textContent = 'Actualizado ahora';
  else if (mins < 60) label.textContent = `Hace ${mins} min`;
  else label.textContent = `Hace ${Math.floor(mins / 60)}h ${mins % 60}min`;
}

// --- VPS helpers ---------------------------------------------------------

function vpsPrettyName(id) {
  return (id || '').toUpperCase();
}

function vpsBadge(id) {
  const cls = `vps-badge vps-${(id || 'unk').toLowerCase()}`;
  return `<span class="${cls}">${vpsPrettyName(id)}</span>`;
}

// --- Render orchestration ------------------------------------------------

function render() {
  const s = state.snapshot;
  if (!s) return;
  document.getElementById('window-days').textContent = s.window_days;
  document.getElementById('generated-at').textContent = fmt.dateTime(s.generated_at);
  const p = s.portfolio || {};
  const vpsCountEl = document.getElementById('vps-count');
  if (vpsCountEl) vpsCountEl.textContent = p.vps_count ?? Object.keys(s.vps_sources || {}).length;
  const accCountEl = document.getElementById('account-count');
  if (accCountEl) accCountEl.textContent = state.demoAccounts.length;
  const realCountEl = document.getElementById('real-account-count');
  if (realCountEl) {
    const accts = (s.real_portfolio && s.real_portfolio.accounts) || [];
    realCountEl.textContent = accts.filter(isFundedRealAccount).length;
  }
  const totalBotsEl = document.getElementById('total-bots-count');
  if (totalBotsEl) {
    const totalBots = (s.bots || []).filter(b => (b.magic || 0) !== 0).length;
    totalBotsEl.textContent = totalBots;
  }
  // Total closed trades across 100% of bots (lifetime since 2020, magic ≠ 0).
  // Excludes open positions by design — only closed deals are counted in b.trades.
  const totalTradesEl = document.getElementById('total-trades-count');
  if (totalTradesEl) {
    const total = (s.bots || []).reduce((acc, b) => acc + (Number(b.trades) || 0), 0);
    animateCounter(totalTradesEl, total);
  }

  // Determine freshness against oldest source
  setFreshness(s.oldest_source_generated_at || s.generated_at);
  // Out-of-band staleness banner (sticky, prominent — survives even if no
  // per-bot files load). Reads s.vps_freshness + s.partial_data from post_merge.
  try { renderStalenessBanner(s); } catch(e) { console.error('staleness banner failed', e); }

  const safe = (fn, name) => { try { fn(); } catch (e) { console.error(name + ' failed:', e); } };
  // Below-the-fold renders run at idle so the real-accounts block (lo primero
  // que mira el owner) pinta sin esperar a las tablas grandes. Same-order queue.
  const idle = (fn, name) => {
    const run = () => safe(fn, name);
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 800 });
    else setTimeout(run, 40);
  };
  safe(renderVpsPills, 'renderVpsPills');
  safe(renderSourcesFooter, 'renderSourcesFooter');
  safe(renderRealAccounts, 'renderRealAccounts');
  safe(renderRealDailySuite, 'renderRealDailySuite');
  safe(renderStats, 'renderStats');
  safe(renderCandidates, 'renderCandidates');
  idle(renderDemoWrapper, 'renderDemoWrapper');
  idle(renderBalanced, 'renderBalanced');
  idle(renderNewBotsVpsPills, 'renderNewBotsVpsPills');
  idle(renderNewBots, 'renderNewBots');
  idle(renderPodium, 'renderPodium');
  idle(renderChart, 'renderChart');
  idle(applyFilterAndRender, 'applyFilterAndRender');
  idle(auditBotHistoryCoverage, 'auditBotHistoryCoverage');
  idle(renderSystemHealth, 'renderSystemHealth');
}

/* Data Integrity DNA — surface the integrity_report.json generated by
   verify_integrity.py at every mirror cycle. ok=true => green badge.
   ok=false => red banner with summary (missing files, trade/net mismatches,
   series missing). Single source of truth: the CI workflow blocks deploy
   when verify fails, so reaching the dashboard means the report exists. */
async function auditBotHistoryCoverage() {
  let report = null;
  try {
    const res = await fetch('data/integrity_report.json', { cache: 'no-cache' });
    if (res.ok) report = await res.json();
  } catch {}

  let banner = document.getElementById('bot-history-audit-banner');
  const main = document.querySelector('main.container');
  if (!main) return;

  if (!report) {
    if (banner) banner.remove();
    return;
  }

  const ageMin = (() => {
    try {
      const ts = new Date(report.generated_at).getTime();
      return Math.round((Date.now() - ts) / 60000);
    } catch { return null; }
  })();
  const ageLabel = ageMin == null ? '' : (ageMin < 60 ? `hace ${ageMin}min` : `hace ${Math.round(ageMin/60)}h`);

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'bot-history-audit-banner';
    main.prepend(banner);
  }

  // Fase E-mínima (tribunal): estado de las capas nuevas en el mismo badge —
  // failover R2 (paridad write-then-read) + ledger notarizado del día.
  let extra = '';
  try {
    const uh = await fetch('data/upload_health.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null);
    const r2 = uh && uh.r2;
    if (r2 && r2.enabled) extra += r2.parity_ok ? ' · 🛟 R2 ✓' : ' · 🛟 R2 sin paridad';
  } catch {}

  if (report.ok) {
    banner.className = 'integrity-badge ok';
    banner.innerHTML = `
      <div class="integrity-badge-icon">✅</div>
      <div class="integrity-badge-body">
        <strong>Datos verificados — ${report.bots_checked} bots</strong>
        <span class="integrity-badge-meta">trades · net · series · presencia${extra} · 🔐 root notarizado · ${ageLabel}</span>
      </div>
    `;
    return;
  }

  const sum = report.summary || {};
  const bits = [];
  if (sum.missing_files)        bits.push(`${sum.missing_files} archivos faltantes`);
  if (sum.trade_mismatches)     bits.push(`${sum.trade_mismatches} trade-count mismatch`);
  if (sum.net_profit_mismatches) bits.push(`${sum.net_profit_mismatches} net-profit mismatch`);
  if (sum.series_missing)       bits.push(`${sum.series_missing} sin daily_equity_series`);
  if (sum.remote_failures)      bits.push(`${sum.remote_failures} drift remoto`);

  banner.className = 'integrity-badge fail';
  banner.innerHTML = `
    <div class="integrity-badge-icon">⚠️</div>
    <div class="integrity-badge-body">
      <strong>Integridad: ${report.bots_failed}/${report.bots_checked} bots con problemas</strong>
      <div class="integrity-badge-meta">${bits.join(' · ')} · ${ageLabel}</div>
      <div class="integrity-badge-hint">Detalle completo en <code>data/integrity_report.json</code></div>
    </div>
  `;
}

// --- Real accounts section -----------------------------------------------

function signedClass(v) {
  if (v > 0) return 'positive';
  if (v < 0) return 'negative';
  return '';
}

function distancePct(current, target) {
  if (!target || !current) return null;
  return ((target - current) / current) * 100;
}

function historyForLogin(login) {
  return state.history
    .filter(h => h.login === login)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

function drawSpark(canvas, points, color) {
  if (!canvas || !points.length) return;
  try {
  const id = canvas.id;
  if (state.sparkCharts[id]) state.sparkCharts[id].destroy();
  state.sparkCharts[id] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: points.map(p => p.ts),
      datasets: [{
        data: points.map(p => p.equity),
        borderColor: color,
        backgroundColor: color + '22',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.35,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
  } catch (err) { console.warn('sparkline failed', err); }
}

function ensureLivePill() {
  let pill = document.getElementById('live-pill');
  if (pill) return pill;
  const header = document.querySelector('.real-header');
  if (!header) return null;
  pill = document.createElement('div');
  pill.id = 'live-pill';
  pill.className = 'live-pill live-off';
  pill.title = 'Stream en tiempo real desde la VPS · click para forzar fetch';
  pill.innerHTML = '<span class="live-dot"></span><span class="live-pill-label">offline</span><span class="live-pill-age"></span>';
  pill.addEventListener('click', async () => {
    if (!window.kizLiveReal) return;
    const rows = await window.kizLiveReal.fetchOnce();
    rows.forEach(applyLivePatch);
  });
  header.appendChild(pill);
  return pill;
}

function setLivePillStatus(state, label, ageSecs) {
  const pill = document.getElementById('live-pill');
  if (!pill) return;
  pill.classList.remove('live-on', 'live-warn', 'live-off', 'live-fallback');
  pill.classList.add(`live-${state}`);
  pill.querySelector('.live-pill-label').textContent = label;
  const ageEl = pill.querySelector('.live-pill-age');
  ageEl.textContent = ageSecs == null ? '' : `· ${ageSecs.toFixed(1)}s`;
}

function liveLatestAgeSecs() {
  let oldest = null;
  for (const row of liveState.byLogin.values()) {
    const t = new Date(row.ts).getTime();
    if (Number.isFinite(t)) {
      if (oldest == null || t < oldest) oldest = t;
    }
  }
  if (oldest == null) return null;
  return Math.max(0, (Date.now() - oldest) / 1000);
}

function refreshLivePillFromState() {
  const age = liveLatestAgeSecs();
  if (age == null) {
    setLivePillStatus('off', 'sin push', null);
    setLiveUnverified(false);  // no live ever attached → snapshot path owns the cifras
    return;
  }
  // Publisher pushes every ~3s (Railway-held SSH loop). Thresholds tuned to
  // that cadence: green while fresh, amber on lag, red when the stream stalls.
  // In REST-fallback mode data arrives via 5s polling on top of the 3s publisher
  // cadence, so "fresh" is wider (up to ~8s of honest transport delay).
  const polling = liveState.transport === 'polling';
  const freshLim = polling ? 13 : 8;
  const lagLim = polling ? 25 : 20;
  if (age < freshLim) setLivePillStatus(polling ? 'fallback' : 'on', polling ? 'live·respaldo' : 'live', age);
  else if (age < lagLim) setLivePillStatus('warn', 'lag', age);
  else setLivePillStatus('off', 'stale', age);
  // Fail-closed (DNA): once the live stream has stalled well past cadence, the
  // numbers on screen are NO LONGER verifiable in real time. Degrade the SOURCE
  // visibly instead of silently showing a stale figure as if it were live.
  setLiveUnverified(age >= 30);
}

function setLiveUnverified(on) {
  const section = document.getElementById('real-accounts');
  if (section) section.classList.toggle('live-unverified', !!on);
}

function flashLive(el) {
  if (!el) return;
  el.classList.remove('live-flash');
  void el.offsetWidth;
  el.classList.add('live-flash');
}

function _setTextWithFlash(el, text, flash = true) {
  if (!el) return;
  if (el.textContent !== text) {
    el.textContent = text;
    if (flash) flashLive(el);
  }
}

function _setSignedTextWithFlash(el, value, flash = true) {
  if (!el) return;
  const text = fmt.usd(value, true);
  el.classList.remove('positive', 'negative');
  const sc = signedClass(value);
  if (sc) el.classList.add(sc);
  if (el.textContent !== text) {
    el.textContent = text;
    if (flash) flashLive(el);
  }
}

function buildPositionRowHtml(p) {
  const fmtDist = (price, target) => {
    if (!price || !target) return '—';
    const d = distancePct(price, target);
    if (d == null || !isFinite(d)) return target;
    return `${target} (${d > 0 ? '+' : ''}${d.toFixed(2)}%)`;
  };
  const typeStr = (p.type || '').toString();
  return `
    <tr data-position-login="${p.login}" data-position-ticket="${p.ticket}">
      <td>#${p.login}</td>
      <td><code>${p.magic}</code></td>
      <td><span class="symbol-tag">${p.symbol}</span></td>
      <td class="pos-${typeStr.toLowerCase()}">${typeStr}</td>
      <td class="num">${p.volume}</td>
      <td class="num">${p.price_open}</td>
      <td class="num">${p.price_current}</td>
      <td class="num">${fmtDist(p.price_current, p.sl)}</td>
      <td class="num">${fmtDist(p.price_current, p.tp)}</td>
      <td class="num ${signedClass(p.profit)}">${fmt.usd(p.profit, true)}</td>
      <td>${fmt.shortTime(p.time_open ? new Date(p.time_open * 1000).toISOString() : null)}</td>
    </tr>
  `;
}

function applyLivePatch(row, opts) {
  if (!row || row.login == null) return;
  const flash = !(opts && opts.silent);
  const login = Number(row.login);

  // Out-of-order guard: never let an older write clobber a fresher value already
  // shown (rolling-deploy double-publisher, a manual --once, or a Realtime replay).
  const prev = liveState.byLogin.get(login);
  if (prev && (Date.parse(row.ts) || 0) < (Date.parse(prev.ts) || 0)) return;
  liveState.byLogin.set(login, row);

  // Update card.
  const card = document.querySelector(`.real-card[data-real-login="${login}"]`);
  if (card) {
    const balanceEl = card.querySelector('[data-live-field="balance"]');
    const equityEl = card.querySelector('[data-live-field="equity"]');
    const profitEl = card.querySelector('[data-live-field="profit"]');
    const marginEl = card.querySelector('[data-live-field="margin"]');
    _setTextWithFlash(balanceEl, fmt.usd(row.balance), flash);
    _setTextWithFlash(equityEl, fmt.usd(row.equity), flash);
    _setSignedTextWithFlash(profitEl, row.profit, flash);
    _setTextWithFlash(marginEl, fmt.usd(row.margin), flash);
    updateRealRiskCard(login, row, flash);
  }

  // Update header totals — aggregate across ALL funded real accounts (snapshot roster),
  // using the live row where the stream has it and the snapshot value otherwise. This
  // keeps the total correct for a real account that isn't in the live stream (e.g. one
  // not in the publisher's REAL_LOGINS) instead of silently dropping it from the sum.
  let totBal = 0, totEq = 0, totFloat = 0;
  const snapReals = ((state.snapshot && state.snapshot.real_portfolio && state.snapshot.real_portfolio.accounts) || [])
    .filter(isFundedRealAccount);
  if (snapReals.length) {
    for (const a of snapReals) {
      const r = liveState.byLogin.get(a.login);
      totBal += Number(r ? r.balance : a.balance) || 0;
      totEq += Number(r ? r.equity : a.equity) || 0;
      totFloat += Number(r ? r.profit : a.profit) || 0;
    }
  } else {
    for (const r of liveState.byLogin.values()) {
      totBal += Number(r.balance) || 0;
      totEq += Number(r.equity) || 0;
      totFloat += Number(r.profit) || 0;
    }
  }
  _setTextWithFlash(document.getElementById('real-balance'), fmt.usd(totBal), flash);
  _setTextWithFlash(document.getElementById('real-equity'), fmt.usd(totEq), flash);
  _setSignedTextWithFlash(document.getElementById('real-floating'), totFloat, flash);

  // Update positions table — replace the rows for this login, leave others.
  const tbody = document.getElementById('real-positions-tbody');
  const empty = document.getElementById('real-positions-empty');
  if (tbody) {
    tbody
      .querySelectorAll(`tr[data-position-login="${row.login}"]`)
      .forEach((tr) => tr.remove());
    const positions = Array.isArray(row.positions) ? row.positions : [];
    positions.forEach((p) => {
      const html = buildPositionRowHtml({ ...p, login: row.login });
      tbody.insertAdjacentHTML('beforeend', html);
    });
    const anyPositions = !!tbody.querySelector('tr');
    if (empty) empty.hidden = anyPositions;
  }

  try { kizRealLiveHooks(); } catch (e) { console.error('kizRealLiveHooks failed', e); }
  refreshLivePillFromState();
}

function initLiveStream() {
  if (liveState.initialized || !window.kizLiveReal) return;
  liveState.initialized = true;
  ensureLivePill();
  refreshLivePillFromState();

  if (window.kizLiveReal.connect) {
    // Managed transport: Realtime with automatic REST-polling failover and
    // socket retry w/ backoff. Does its own initial fetch, so no fetchOnce here.
    liveState.conn = window.kizLiveReal.connect(applyLivePatch, (mode) => {
      liveState.transport = mode;
      refreshLivePillFromState();
    });
  } else {
    // Legacy path (old data-source.js without connect()).
    window.kizLiveReal.fetchOnce().then((rows) => {
      rows.forEach(applyLivePatch);
    }).catch((err) => console.warn('[kiz] live initial fetch failed', err));
    if (liveState.channel) window.kizLiveReal.unsubscribe(liveState.channel);
    liveState.channel = window.kizLiveReal.subscribe(applyLivePatch);
  }

  // 1-second pill refresh so age stays current even between pushes.
  if (liveState.pollTimer) clearInterval(liveState.pollTimer);
  liveState.pollTimer = setInterval(refreshLivePillFromState, 1000);

  const teardown = () => {
    if (liveState.conn) { liveState.conn.stop(); liveState.conn = null; }
    if (liveState.channel) { window.kizLiveReal.unsubscribe(liveState.channel); liveState.channel = null; }
    if (liveState.pollTimer) { clearInterval(liveState.pollTimer); liveState.pollTimer = null; }
  };
  // pagehide covers bfcache / mobile where beforeunload doesn't fire.
  window.addEventListener('beforeunload', teardown);
  window.addEventListener('pagehide', teardown);
}

// --- Panel de riesgo EN VIVO por cuenta real --------------------------------
// Umbrales configurables (solo frontend, sin backend).
const RISK_CFG = {
  marginGreen: 500,   // margin level % — verde por encima
  marginAmber: 200,   // ámbar entre marginAmber y marginGreen; rojo por debajo
  ddWarn: 2,          // % de drawdown intradía — ámbar a partir de aquí
  ddDanger: 5,        // % — rojo a partir de aquí
};

// High-water-mark intradía por login, persistido por día UTC para sobrevivir
// recargas. Si el dashboard no estuvo abierto todo el día, el HWM es desde la
// primera observación (sembrado con el balance de apertura aproximado).
const HWM_KEY = 'kiz.realHwm.v1';
function readHwmStore() {
  try { const r = localStorage.getItem(HWM_KEY); return r ? JSON.parse(r) : {}; }
  catch { return {}; }
}
function trackRealHwm(login, equity, seed) {
  const today = new Date().toISOString().slice(0, 10);
  const store = readHwmStore();
  const cur = store[login];
  let hwm = Math.max(Number(equity) || 0, Number(seed) || 0);
  if (cur && cur.date === today) hwm = Math.max(hwm, Number(cur.hwm) || 0);
  store[login] = { date: today, hwm };
  try { localStorage.setItem(HWM_KEY, JSON.stringify(store)); } catch { /* quota — non-fatal */ }
  return hwm;
}

// Net cerrado HOY de la cuenta = suma de real_daily.today_net de sus bots.
function realTodayNetForLogin(login) {
  const bots = (state.snapshot && state.snapshot.bots) || [];
  let sum = 0, seen = false;
  for (const b of bots) {
    if (b.account_login === login && b.real_daily) { sum += Number(b.real_daily.today_net) || 0; seen = true; }
  }
  return seen ? sum : null;
}

// Métricas de riesgo interpretadas para una cuenta real.
// dayPnl = cerrado hoy (snapshot) + flotante (live). ddPct = caída desde el
// HWM intradía. marginLevel = equity/margin — null si no hay exposición.
function computeRealRisk(login, vals) {
  const equity = Number(vals.equity) || 0;
  const balance = Number(vals.balance) || 0;
  const margin = Number(vals.margin) || 0;
  const profit = Number(vals.profit) || 0;
  const todayNet = realTodayNetForLogin(login);
  const dayPnl = todayNet == null ? null : todayNet + profit;
  // Balance de apertura aprox. del día = balance actual − cerrado hoy.
  const seed = todayNet == null ? equity : balance - todayNet;
  const hwm = trackRealHwm(login, equity, seed);
  const ddPct = hwm > 0 ? Math.max(0, ((hwm - equity) / hwm) * 100) : 0;
  const marginLevel = margin > 0 ? (equity / margin) * 100 : null;
  return { dayPnl, ddPct, marginLevel };
}

function ddClass(ddPct) {
  if (ddPct >= RISK_CFG.ddDanger) return 'risk-red';
  if (ddPct >= RISK_CFG.ddWarn) return 'risk-amber';
  return 'risk-green';
}
function marginClass(level) {
  if (level == null || level > RISK_CFG.marginGreen) return 'risk-green';
  if (level >= RISK_CFG.marginAmber) return 'risk-amber';
  return 'risk-red';
}

// Pinta la fila de riesgo de la card de una cuenta real.
function updateRealRiskCard(login, vals, flash = false) {
  const wrap = document.querySelector(`.real-risk[data-risk-login="${login}"]`);
  if (!wrap) return;
  const { dayPnl, ddPct, marginLevel } = computeRealRisk(login, vals);

  const pnlEl = wrap.querySelector('[data-risk-field="daypnl"]');
  if (pnlEl) {
    pnlEl.classList.remove('positive', 'negative');
    const sc = dayPnl == null ? '' : signedClass(dayPnl);
    if (sc) pnlEl.classList.add(sc);
    _setTextWithFlash(pnlEl, dayPnl == null ? '—' : fmt.usd(dayPnl, true), flash);
  }

  const ddEl = wrap.querySelector('[data-risk-field="dd"]');
  if (ddEl) {
    ddEl.classList.remove('risk-green', 'risk-amber', 'risk-red');
    ddEl.classList.add(ddClass(ddPct));
    _setTextWithFlash(ddEl, `-${ddPct.toFixed(2)}%`, flash);
  }

  const numEl = wrap.querySelector('[data-risk-field="mlvl-num"]');
  const barEl = wrap.querySelector('[data-risk-field="mlvl-bar"]');
  const mCls = marginClass(marginLevel);
  if (numEl) numEl.textContent = marginLevel == null ? 'sin exposición' : `${Math.round(marginLevel)}%`;
  if (barEl) {
    barEl.classList.remove('risk-green', 'risk-amber', 'risk-red');
    barEl.classList.add(mCls);
    // 1000% de margin level (muy holgado) llena la barra; el rojo se ve corto.
    const w = marginLevel == null ? 100 : Math.max(4, Math.min(100, marginLevel / 10));
    barEl.style.width = `${w}%`;
  }
}

// --- F1 · Historia intradía persistente (public.live_real_history) ----------
// Serie de equity de las cuentas reales que sobrevive recargas: la escribe el
// live_publisher cada ~30s y se lee bucketizada vía RPC real_equity_history
// (1h/24h/7d/30d, ≤1000 filas por llamada). Si la tabla aún no tiene datos el
// panel queda oculto (deploy shadow-first, sin ruido).
const realHistory = { win: '24h', chart: null, timer: null, wired: false };
const REAL_HISTORY_COLORS = ['#e8c547', '#3ddc97', '#6ea8fe', '#ff6b8b', '#b98bff', '#ffb86b'];

async function fetchRealHistory(win) {
  if (!window.kizSupabase) return [];
  const { data, error } = await window.kizSupabase.rpc('real_equity_history', { win });
  if (error) {
    console.warn('[kiz] real_equity_history failed', error.message || error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

function renderRealHistoryChart(rows) {
  const panel = document.getElementById('real-history-panel');
  const canvas = document.getElementById('real-history-chart');
  if (!panel || !canvas) return;
  if (!rows.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const byLogin = new Map();
  const ptsByBucket = new Map();
  for (const r of rows) {
    const t = new Date(r.bucket).getTime();
    if (!byLogin.has(r.login)) byLogin.set(r.login, []);
    byLogin.get(r.login).push({ x: t, y: Number(r.equity) });
    if (!ptsByBucket.has(t)) ptsByBucket.set(t, []);
    ptsByBucket.get(t).push(r);
  }

  // Total con forward-fill: los buckets no siempre están alineados entre
  // cuentas (publishers en VPS distintas), así que se suma la última equity
  // conocida de cada una — y solo desde que TODAS tienen al menos un punto.
  const buckets = [...ptsByBucket.keys()].sort((a, b) => a - b);
  const lastByLogin = new Map();
  const total = [];
  for (const t of buckets) {
    ptsByBucket.get(t).forEach(r => lastByLogin.set(r.login, Number(r.equity)));
    if (lastByLogin.size === byLogin.size) {
      let sum = 0;
      lastByLogin.forEach(v => { sum += v; });
      total.push({ x: t, y: sum });
    }
  }

  const datasets = [...byLogin.entries()].map(([login, pts], i) => ({
    label: `#${login}`,
    data: pts,
    borderColor: REAL_HISTORY_COLORS[i % REAL_HISTORY_COLORS.length],
    backgroundColor: 'transparent',
    borderWidth: 1.6,
    pointRadius: 0,
    tension: 0.25,
  }));
  if (byLogin.size > 1 && total.length) {
    datasets.push({
      label: 'Total', data: total, borderColor: '#cfd5e6', borderDash: [6, 4],
      backgroundColor: 'transparent', borderWidth: 1.4, pointRadius: 0, tension: 0.25,
    });
  }

  if (realHistory.chart) { realHistory.chart.destroy(); realHistory.chart = null; }
  realHistory.chart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { labels: { color: '#9aa3bb', boxWidth: 14 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt.usd(c.parsed.y)}` } },
      },
      scales: {
        x: { type: 'time', ticks: { color: '#9aa3bb', maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#9aa3bb', callback: (v) => fmt.usd(v) }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });
  const note = document.getElementById('real-history-note');
  if (note) note.textContent = `· ${realHistory.win}`;
}

async function refreshRealHistory() {
  renderRealHistoryChart(await fetchRealHistory(realHistory.win));
}

function initRealHistory() {
  if (realHistory.wired) { refreshRealHistory(); return; }
  realHistory.wired = true;
  const winsEl = document.getElementById('real-history-windows');
  if (winsEl) {
    winsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-win]');
      if (!btn) return;
      realHistory.win = btn.dataset.win;
      winsEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      refreshRealHistory();
    });
  }
  refreshRealHistory();
  if (realHistory.timer) clearInterval(realHistory.timer);
  realHistory.timer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshRealHistory();
  }, 90 * 1000);
}

// --- F5 · Salud del sistema (uptime watchdog + stream live + pipeline) ------
// Fuentes ($0, todas existentes): watchdog_status/history.json que el
// integrity-watchdog sube a Storage cada 30 min, snap.health_metrics
// (post_merge), edad del snapshot y el estado del stream live (F3).
async function renderSystemHealth() {
  const section = document.getElementById('system-health');
  if (!section) return;

  const getJson = (p) => fetch(p, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
  const [status, history] = await Promise.all([
    getJson('data/watchdog_status.json'),
    getJson('data/watchdog_history.json'),
  ]);
  // Sin datos del watchdog todavía (primer deploy) — panel oculto, sin ruido.
  if (!status && !Array.isArray(history)) { section.hidden = true; return; }
  section.hidden = false;

  const hist = Array.isArray(history) ? history : [];
  const now = Date.now();
  const uptime = (days) => {
    const cut = now - days * 86400e3;
    const rows = hist.filter(h => (Date.parse(h.ts) || 0) >= cut);
    if (!rows.length) return null;
    const ok = rows.filter(h => h.result === 'ok').length;
    return { pct: (100 * ok / rows.length), n: rows.length };
  };
  const u7 = uptime(7), u30 = uptime(30);
  const upCls = (u) => u == null ? '' : u.pct >= 99 ? 'risk-green' : u.pct >= 95 ? 'risk-amber' : 'risk-red';
  const fmtUp = (u) => u == null ? '—' : `${u.pct.toFixed(1)}%`;

  // Chips del summary (visibles con el panel colapsado).
  const chips = document.getElementById('health-summary-chips');
  if (chips) {
    const last = status ? status.result : (hist[hist.length - 1] || {}).result;
    chips.innerHTML = `
      <span class="health-chip ${last === 'ok' ? 'risk-green' : 'risk-red'}">watchdog ${last === 'ok' ? 'OK' : 'FAIL'}</span>
      <span class="health-chip ${upCls(u7)}">uptime 7d ${fmtUp(u7)}</span>
      <span class="health-chip ${upCls(u30)}">30d ${fmtUp(u30)}</span>`;
  }

  const grid = document.getElementById('health-grid');
  if (grid) {
    const s = state.snapshot || {};
    const hm = s.health_metrics || {};
    const snapT = Date.parse(s.generated_at || 0);
    const snapAgeMin = snapT ? Math.round((now - snapT) / 60000) : null;
    const liveAge = liveLatestAgeSecs();
    const transport = liveState.transport === 'polling' ? 'respaldo (REST)' :
                      liveState.transport === 'realtime' ? 'Realtime (socket)' : '—';
    const lastTs = status && status.ts ? fmt.shortTime(status.ts) : '—';
    const tile = (label, value, cls = '') =>
      `<div class="health-tile"><span class="metric-label">${label}</span><strong class="${cls}">${value}</strong></div>`;
    grid.innerHTML = [
      tile('Uptime watchdog 7d', `${fmtUp(u7)}${u7 ? ` <small>(${u7.n} checks)</small>` : ''}`, upCls(u7)),
      tile('Uptime watchdog 30d', `${fmtUp(u30)}${u30 ? ` <small>(${u30.n} checks)</small>` : ''}`, upCls(u30)),
      tile('Último check', lastTs, status && status.result === 'ok' ? 'risk-green' : 'risk-red'),
      tile('Stream live', liveAge == null ? 'sin datos' : `${liveAge.toFixed(0)}s · ${transport}`,
           liveAge == null ? 'risk-red' : liveAge < 20 ? 'risk-green' : 'risk-red'),
      tile('Snapshot', snapAgeMin == null ? '—' : `hace ${snapAgeMin} min`,
           snapAgeMin == null ? '' : snapAgeMin <= 45 ? 'risk-green' : snapAgeMin <= 90 ? 'risk-amber' : 'risk-red'),
      hm.recovery_count_7d != null ? tile('Auto-recuperaciones 7d', hm.recovery_count_7d) : '',
      hm.mean_lag_sec_7d != null ? tile('Lag medio pipeline 7d', `${Math.round(hm.mean_lag_sec_7d / 60)} min`) : '',
    ].join('');
  }

  const list = document.getElementById('health-events-list');
  if (list) {
    const incidents = hist.filter(h => h.result === 'fail').slice(-8).reverse();
    list.innerHTML = incidents.length
      ? incidents.map(h => `<li><span class="health-ev-ts">${fmt.shortTime(h.ts)}</span> ${
          (h.fails || []).slice(0, 2).map(f => `<code>${String(f).slice(0, 110)}</code>`).join(' · ')
        }</li>`).join('')
      : '<li class="empty-state">Sin incidentes registrados 🎉</li>';
  }
}

function renderRealAccounts() {
  const s = state.snapshot;
  const section = document.getElementById('real-accounts');
  const rp = s.real_portfolio || { accounts: [], open_positions: [], total_balance: 0, total_equity: 0, total_unrealised_pnl: 0, account_count: 0 };
  const visible = rp.accounts.filter(isFundedRealAccount);
  if (!visible.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  document.getElementById('real-count').textContent = visible.length;
  document.getElementById('real-balance').textContent = fmt.usd(rp.total_balance);
  document.getElementById('real-equity').textContent = fmt.usd(rp.total_equity);
  const floatEl = document.getElementById('real-floating');
  floatEl.textContent = fmt.usd(rp.total_unrealised_pnl, true);
  floatEl.classList.remove('positive', 'negative');
  const sc = signedClass(rp.total_unrealised_pnl);
  if (sc) floatEl.classList.add(sc);

  // Cards per real account with sparkline
  const cards = document.getElementById('real-cards');
  cards.innerHTML = visible.map(a => {
    const pnlCls = signedClass(a.profit);
    return `
      <div class="real-card account-card" data-vps="${a.vps}" data-login="${a.login}" data-real-login="${a.login}" title="Click para ver los bots de esta cuenta">
        <div class="real-card-header">
          <span class="real-card-login">#${a.login}</span>
          <span class="vps-badge vps-${(a.vps || '').toLowerCase()}">${vpsPrettyName(a.vps)}</span>
        </div>
        <div class="real-card-metrics">
          <div><span class="metric-label">Balance</span><strong data-live-field="balance">${fmt.usd(a.balance)}</strong></div>
          <div><span class="metric-label">Equity</span><strong data-live-field="equity">${fmt.usd(a.equity)}</strong></div>
          <div><span class="metric-label">Flotante</span><strong class="${pnlCls}" data-live-field="profit">${fmt.usd(a.profit, true)}</strong></div>
          <div><span class="metric-label">Margin</span><strong data-live-field="margin">${fmt.usd(a.margin)}</strong></div>
        </div>
        <div class="real-risk" data-risk-login="${a.login}">
          <div class="risk-item"><span class="metric-label">P&L hoy</span><strong data-risk-field="daypnl">—</strong></div>
          <div class="risk-item"><span class="metric-label">DD intradía</span><strong data-risk-field="dd">—</strong></div>
          <div class="risk-item risk-margin">
            <span class="metric-label">Margin level <span data-risk-field="mlvl-num"></span></span>
            <div class="risk-margin-bar"><div class="risk-margin-fill" data-risk-field="mlvl-bar"></div></div>
          </div>
        </div>
        <div class="spark-wrapper"><canvas id="spark-${a.login}"></canvas></div>
        <div class="real-card-footer">Broker: ${a.server} · Leverage 1:${a.leverage}</div>
      </div>
    `;
  }).join('');

  // Fila de riesgo con valores del snapshot (el live la refresca después).
  visible.forEach(a => updateRealRiskCard(a.login, a));

  // Draw sparklines after DOM update
  requestAnimationFrame(() => {
    visible.forEach(a => {
      const points = historyForLogin(a.login);
      const canvas = document.getElementById(`spark-${a.login}`);
      const color = a.profit >= 0 ? '#e8c547' : '#ff6b8b';
      drawSpark(canvas, points, color);
    });
  });

  // Open positions
  const posBody = document.getElementById('real-positions-tbody');
  const posEmpty = document.getElementById('real-positions-empty');
  if (!rp.open_positions.length) {
    posBody.innerHTML = '';
    posEmpty.hidden = false;
  } else {
    posEmpty.hidden = true;
    const fmtDist = (price, target) => {
      if (!price || !target) return '—';
      const d = distancePct(price, target);
      if (d == null || !isFinite(d)) return target;
      return `${target} (${d > 0 ? '+' : ''}${d.toFixed(2)}%)`;
    };
    posBody.innerHTML = rp.open_positions.map(p => `
        <tr data-position-login="${p.login}" data-position-ticket="${p.ticket}">
          <td>#${p.login}</td>
          <td><code>${p.magic}</code></td>
          <td><span class="symbol-tag">${p.symbol}</span></td>
          <td class="pos-${(p.type || '').toLowerCase()}">${p.type}</td>
          <td class="num">${p.volume}</td>
          <td class="num">${p.price_open}</td>
          <td class="num">${p.price_current}</td>
          <td class="num">${fmtDist(p.price_current, p.sl)}</td>
          <td class="num">${fmtDist(p.price_current, p.tp)}</td>
          <td class="num ${signedClass(p.profit)}">${fmt.usd(p.profit, true)}</td>
          <td>${fmt.shortTime(p.time_open)}</td>
        </tr>
      `).join('');
  }

  // Bots active in real accounts
  const realLogins = new Set(rp.accounts.map(a => a.login));
  const realBots = s.bots.filter(b => realLogins.has(b.account_login))
    .sort((a, b) => b.net_profit - a.net_profit);
  const botsBody = document.getElementById('real-bots-tbody');
  const botsEmpty = document.getElementById('real-bots-empty');
  if (!realBots.length) {
    botsBody.innerHTML = '';
    botsEmpty.hidden = false;
  } else {
    botsEmpty.hidden = true;
    botsBody.innerHTML = realBots.map(b => `
      <tr class="bot-row" data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}">
        ${buildCompareCheckboxCell(b.vps, b.account_login, b.magic)}
        <td>#${b.account_login}</td>
        <td><code>${b.magic}</code></td>
        <td>${(b.symbols || []).map(sy => `<span class="symbol-tag">${sy}</span>`).join('')}</td>
        <td class="num">${fmt.int(b.trades)}</td>
        <td class="num">${fmt.pct(b.win_rate_pct)}</td>
        <td class="num">${fmt.pf(b.profit_factor)}</td>
        <td class="num ${signedClass(b.expectancy)}">${fmt.usd(b.expectancy, true)}</td>
        <td class="num">${fmt.usd(b.max_drawdown)}</td>
        <td class="num">${b.recovery_factor != null ? b.recovery_factor.toFixed(2) : '—'}</td>
        <td class="num">${b.max_consecutive_losses ?? '—'}</td>
        <td class="num ${signedClass(b.net_profit)}">${fmt.usd(b.net_profit, true)}</td>
        <td>${fmt.shortTime(b.last_trade)}</td>
      </tr>
    `).join('');
  }

  // Activate Realtime stream (idempotent — only attaches once).
  initLiveStream();

  // Historia intradía persistente (idempotente; refresca si ya está wired).
  initRealHistory();

  // Anti-clobber: this render just rewrote the cards/totals/positions with the
  // 30-min snapshot. initLiveStream() above is a no-op after the first call, so
  // re-apply any live row at least as fresh as this snapshot — otherwise a real
  // account shows a 30-min-old balance until the next push. Silent = no flash.
  const snapTs = Date.parse(s.generated_at || 0) || 0;
  liveState.byLogin.forEach((r) => {
    if ((Date.parse(r.ts) || 0) >= snapTs) applyLivePatch(r, { silent: true });
  });
}

function renderDemoWrapper() {
  const accEl = document.getElementById('demo-accounts-count');
  const botEl = document.getElementById('demo-bots-count');
  if (accEl) accEl.textContent = state.demoAccounts.length;
  if (botEl) botEl.textContent = state.demoBots.length;
}

function renderVpsPills() {
  const s = state.snapshot;
  const container = document.getElementById('vps-pills');
  if (!container) return;
  const ids = Object.keys(s.vps_sources || {});
  const staleSet = new Set(s.stale_vps || []);
  const parts = [`<button class="pill vps-pill ${state.vpsFilter === 'all' ? 'active' : ''}" data-vps="all">Todos VPS</button>`];
  for (const id of ids) {
    const stale = staleSet.has(id);
    parts.push(
      `<button class="pill vps-pill vps-${id} ${state.vpsFilter === id ? 'active' : ''}" data-vps="${id}">${vpsPrettyName(id)}${stale ? ' ⚠' : ''}</button>`
    );
  }
  container.innerHTML = parts.join('');
  container.querySelectorAll('.vps-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      state.vpsFilter = pill.dataset.vps;
      container.querySelectorAll('.vps-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      applyFilterAndRender();
    });
  });
}

function renderSourcesFooter() {
  const s = state.snapshot;
  const el = document.getElementById('vps-sources-footer');
  if (!el) return;
  const sources = s.vps_sources || {};
  const parts = Object.entries(sources).map(([id, info]) => {
    const age = info.generated_at ? fmt.shortTime(info.generated_at) : '—';
    const stale = info.stale ? ' ⚠ stale' : '';
    return `${vpsPrettyName(id)}: ${info.account_count} cuentas · ${info.bot_count} bots · ${age}${stale}`;
  });
  el.textContent = parts.join(' · ');
}

// --- Stat counters (animated) --------------------------------------------

function animateCounter(el, target, { prefix = '', signed = false, duration = 900 } = {}) {
  const from = Number(el.dataset.current || 0);
  const to = Number(target || 0);
  const start = performance.now();
  el.dataset.current = to;

  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const v = from + (to - from) * eased;
    const sign = signed && v > 0 ? '+' : '';
    if (prefix === '$') {
      el.textContent = sign + v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
    } else {
      el.textContent = sign + Math.round(v).toLocaleString('en-US');
    }
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderStats() {
  const cards = document.querySelectorAll('[data-counter]');
  const demoAccts = state.demoAccounts;
  const totBal = demoAccts.reduce((s, a) => s + (a.balance || 0), 0);
  const totEq = demoAccts.reduce((s, a) => s + (a.equity || 0), 0);
  const totFl = demoAccts.reduce((s, a) => s + (a.profit || 0), 0);
  const values = [
    totBal,
    totEq,
    totFl,
    demoAccts.length,
    state.demoBots.length,
  ];
  cards.forEach((el, i) => {
    const prefix = el.dataset.prefix || '';
    const signed = el.hasAttribute('data-signed');
    animateCounter(el, values[i], { prefix, signed });
    if (el.classList.contains('pnl')) {
      el.classList.remove('positive', 'negative');
      if (values[i] > 0) el.classList.add('positive');
      else if (values[i] < 0) el.classList.add('negative');
    }
  });
}

// --- Balanced bots (volume × win rate) -----------------------------------

const BALANCED_MIN_TRADES = 25;
const BALANCED_TOP_N = 20;

function renderBalanced() {
  const tbody = document.getElementById('balanced-tbody');
  const empty = document.getElementById('balanced-empty');
  const counter = document.getElementById('balanced-count');
  if (!tbody) return;

  const candidates = state.demoBots
    .filter(b => (b.trades || 0) > BALANCED_MIN_TRADES)
    .slice()
    .sort((a, b) => (b._wilson || 0) - (a._wilson || 0))
    .slice(0, BALANCED_TOP_N)
    .sort((a, b) => (b.net_profit || 0) - (a.net_profit || 0));

  if (counter) counter.textContent = candidates.length;

  if (!candidates.length) {
    tbody.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  tbody.innerHTML = candidates.map((b, i) => {
    const symbols = (b.symbols || []).join(', ') || '—';
    const netCls = b.net_profit >= 0 ? 'profit-positive' : 'profit-negative';
    return `
      <tr class="bot-row" data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}">
        ${buildCompareCheckboxCell(b.vps, b.account_login, b.magic)}
        <td><span class="rank-badge">${i + 1}</span></td>
        <td class="mono">${b.magic}</td>
        <td>${vpsBadge(b.vps)}</td>
        <td class="mono">${b.account_login}</td>
        <td><span class="symbol-tag">${symbols}</span></td>
        <td class="num"><strong>${b.trades}</strong></td>
        <td class="num">${fmt.pct(b.win_rate_pct)}</td>
        <td class="num"><strong style="color: var(--amber)">${fmt.pct(b._wilson)}</strong></td>
        <td class="num">${fmt.pf(b.profit_factor)}</td>
        <td class="num ${netCls}">${fmt.usd(b.net_profit, true)}</td>
        <td class="num">${fmt.shortTime(b.last_trade)}</td>
      </tr>
    `;
  }).join('');
}

// --- New Bots (last 30 days) --------------------------------------------

const NEW_BOTS_DAYS = 30;

// A bot is "new" while its first_trade is within the last NEW_BOTS_DAYS.
// New bots live ONLY in the Bots Nuevos window — excluded from the general
// pool (ranking/balanced/podium/chart/count) until they age out (auto, moving window).
function isNewBot(b) {
  if (!b || !b.first_trade) return false;
  const ft = new Date(b.first_trade).getTime();
  return !!ft && ft >= (Date.now() - NEW_BOTS_DAYS * 24 * 60 * 60 * 1000);
}

function renderNewBots() {
  const tbody = document.getElementById('new-bots-tbody');
  const empty = document.getElementById('new-bots-empty');
  const counter = document.getElementById('new-bots-count');
  if (!tbody) return;

  const now = Date.now();
  const cutoff = now - NEW_BOTS_DAYS * 24 * 60 * 60 * 1000;

  // Source: demo bots only (exclude real-account bots — they live only in the Real Accounts section), magic ≠ 0, ≥1 closed trade, first_trade within 30d
  let allBots = (state.snapshot.bots || [])
    .filter(b => !state.realLogins.has(b.account_login))
    .filter(b => b.magic && b.magic !== 0)
    .filter(b => (b.trades || 0) >= 1)
    .map(b => {
      const ftMs = b.first_trade ? new Date(b.first_trade).getTime() : 0;
      return { ...b, _ftMs: ftMs };
    })
    .filter(b => b._ftMs >= cutoff);

  // Apply filters (search, filter pill, vps pill)
  const q = (state.newBotsSearch || '').trim().toLowerCase();
  if (q) {
    allBots = allBots.filter(b =>
      String(b.magic).includes(q) ||
      String(b.account_login).includes(q) ||
      String(b.vps || '').toLowerCase().includes(q) ||
      (b.symbols || []).some(s => s.toLowerCase().includes(q))
    );
  }
  const f = state.newBotsFilter || 'all';
  if (f === 'winners') allBots = allBots.filter(b => b.net_profit > 0);
  else if (f === 'losers') allBots = allBots.filter(b => b.net_profit < 0);
  if ((state.newBotsVps || 'all') !== 'all') allBots = allBots.filter(b => b.vps === state.newBotsVps);

  // Sort
  if (f === 'by-winrate') {
    allBots.sort((a, b) => (b.win_rate_pct - a.win_rate_pct) || (b.trades - a.trades));
  } else if (f === 'by-trades') {
    allBots.sort((a, b) => (b.trades - a.trades) || (b.win_rate_pct - a.win_rate_pct));
  } else {
    allBots.sort((a, b) => b._ftMs - a._ftMs);
  }

  if (counter) counter.textContent = allBots.length;

  if (!allBots.length) {
    tbody.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  tbody.innerHTML = allBots.map((b, i) => {
    const symbols = (b.symbols || []).join(', ') || '—';
    const netCls = b.net_profit >= 0 ? 'profit-positive' : 'profit-negative';
    const wins = b.wins || 0;
    const losses = (b.trades || 0) - wins;
    const days = Math.max(0, Math.floor((now - b._ftMs) / (24 * 60 * 60 * 1000)));
    const ftLabel = new Date(b._ftMs).toISOString().slice(0, 10);
    return `
      <tr class="bot-row" data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}">
        ${buildCompareCheckboxCell(b.vps, b.account_login, b.magic)}
        <td><span class="rank-badge">${i + 1}</span></td>
        <td class="mono">${b.magic}</td>
        <td>${vpsBadge(b.vps)}</td>
        <td class="mono">${b.account_login}</td>
        <td><span class="symbol-tag">${symbols}</span></td>
        <td class="num"><strong>${b.trades}</strong></td>
        <td class="num profit-positive">${wins}</td>
        <td class="num profit-negative">${losses}</td>
        <td class="num">${fmt.pct(b.win_rate_pct)}</td>
        <td class="num">${fmt.pf(b.profit_factor)}</td>
        <td class="num ${netCls}">${fmt.usd(b.net_profit, true)}</td>
        <td class="mono">${ftLabel}</td>
        <td class="num"><strong>${days}d</strong></td>
      </tr>
    `;
  }).join('');
}

// --- Podium --------------------------------------------------------------

function renderPodium() {
  const container = document.getElementById('podium');
  const top3 = state.demoBots.slice(0, 3);
  const medals = ['🥇', '🥈', '🥉'];
  container.innerHTML = top3.map((b, i) => `
    <div class="podium-card rank-${i + 1} bot-row" data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}">
      <div class="podium-medal">${medals[i]}</div>
      <div class="podium-magic">Magic ${b.magic} · cuenta ${b.account_login} · ${vpsBadge(b.vps)}</div>
      <div class="podium-profit ${b.net_profit < 0 ? 'negative' : ''}">${fmt.usd(b.net_profit, true)}</div>
      <div class="podium-meta">
        <span class="chip">${b.trades} trades</span>
        <span class="chip">Win ${fmt.pct(b.win_rate_pct)}</span>
        <span class="chip">PF ${fmt.pf(b.profit_factor)}</span>
        <span class="chip">${(b.symbols || []).join(', ') || '—'}</span>
      </div>
    </div>
  `).join('');
}

// --- Chart ---------------------------------------------------------------

function renderChart() {
  const ctx = document.getElementById('bots-chart');
  const top = state.demoBots.slice(0, 15);
  const labels = top.map(b => `${b.magic}`);
  const data = top.map(b => b.net_profit);
  const colors = data.map(v => v >= 0 ? 'rgba(61, 220, 151, 0.85)' : 'rgba(255, 107, 139, 0.85)');
  const borders = data.map(v => v >= 0 ? '#3ddc97' : '#ff6b8b');

  if (state.chart) state.chart.destroy();

  state.chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Net Profit (USD)',
        data,
        backgroundColor: colors,
        borderColor: borders,
        borderWidth: 1,
        borderRadius: 6,
        hoverBackgroundColor: borders,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 900, easing: 'easeOutCubic' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(10, 11, 18, 0.95)',
          titleColor: '#e7ebf5',
          bodyColor: '#9aa3bb',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            title: (items) => `Magic ${items[0].label}`,
            label: (item) => {
              const b = top[item.dataIndex];
              return [
                `Net profit: ${fmt.usd(b.net_profit, true)}`,
                `VPS: ${vpsPrettyName(b.vps)}`,
                `Cuenta: ${b.account_login}`,
                `Trades: ${b.trades} · Win ${fmt.pct(b.win_rate_pct)}`,
                `Símbolos: ${(b.symbols || []).join(', ')}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#6b7390', font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 60, minRotation: 45 },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: '#6b7390', font: { family: 'JetBrains Mono', size: 11 },
            callback: (v) => fmt.usd(v),
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
      },
    },
  });
}

// --- Table: filter + sort + render ---------------------------------------

function applyFilterAndRender() {
  let bots = state.demoBots.slice();
  const q = state.search.trim().toLowerCase();
  if (q) {
    bots = bots.filter(b =>
      String(b.magic).includes(q) ||
      String(b.account_login).includes(q) ||
      String(b.vps || '').toLowerCase().includes(q) ||
      (b.symbols || []).some(s => s.toLowerCase().includes(q))
    );
  }
  if (state.filter === 'winners') bots = bots.filter(b => b.net_profit > 0);
  else if (state.filter === 'losers') bots = bots.filter(b => b.net_profit < 0);
  if (state.vpsFilter !== 'all') bots = bots.filter(b => b.vps === state.vpsFilter);

  if (state.filter === 'by-winrate') {
    bots.sort((a, b) => (b.win_rate_pct - a.win_rate_pct) || (b.trades - a.trades));
    state.filteredBots = bots; renderTable(); updateSortIndicators(); return;
  }
  if (state.filter === 'by-trades') {
    bots.sort((a, b) => (b.trades - a.trades) || (b.win_rate_pct - a.win_rate_pct));
    state.filteredBots = bots; renderTable(); updateSortIndicators(); return;
  }

  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  bots.sort((a, b) => {
    if (key === 'rank') return (a._rank - b._rank) * mul;
    if (key === 'symbols') return ((a.symbols[0] || '').localeCompare(b.symbols[0] || '')) * mul;
    if (key === 'vps') return String(a.vps || '').localeCompare(String(b.vps || '')) * mul;
    if (key === 'last_trade') {
      const ta = a.last_trade ? new Date(a.last_trade).getTime() : 0;
      const tb = b.last_trade ? new Date(b.last_trade).getTime() : 0;
      return (ta - tb) * mul;
    }
    const va = a[key] ?? -Infinity;
    const vb = b[key] ?? -Infinity;
    return (va - vb) * mul;
  });

  state.filteredBots = bots;
  renderTable();
  updateSortIndicators();
}

function profitClass(v) {
  if (v > 0) return 'profit-positive';
  if (v < 0) return 'profit-negative';
  return 'profit-neutral';
}

function rankBadge(n) {
  if (n === 1) return `<span class="rank-badge top-1">${n}</span>`;
  if (n === 2) return `<span class="rank-badge top-2">${n}</span>`;
  if (n === 3) return `<span class="rank-badge top-3">${n}</span>`;
  return `<span class="rank-badge">${n}</span>`;
}

function renderTable() {
  const tbody = document.getElementById('bots-tbody');
  const empty = document.getElementById('empty-state');
  const bots = state.filteredBots;
  if (bots.length === 0) {
    tbody.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  tbody.innerHTML = bots.map((b, i) => `
    <tr class="bot-row" data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}" style="animation-delay: ${Math.min(i * 15, 400)}ms">
      <td>${rankBadge(b._rank)}</td>
      <td>${b.magic}</td>
      <td>${vpsBadge(b.vps)}</td>
      <td>${b.account_login}</td>
      <td>${(b.symbols || []).map(s => `<span class="symbol-tag">${s}</span>`).join('')}</td>
      <td class="num">${fmt.int(b.trades)}</td>
      <td class="num profit-positive">${fmt.int(b.wins || 0)}</td>
      <td class="num profit-negative">${fmt.int((b.trades || 0) - (b.wins || 0))}</td>
      <td class="num">
        <div class="winrate-bar">
          <span>${fmt.pct(b.win_rate_pct)}</span>
          <span class="track"><span class="fill" style="width: ${Math.min(100, b.win_rate_pct)}%"></span></span>
        </div>
      </td>
      <td class="num">${fmt.pf(b.profit_factor)}</td>
      <td class="num ${profitClass(b.expectancy)}">${fmt.usd(b.expectancy, true)}</td>
      <td class="num">${fmt.usd(b.max_drawdown || 0)}</td>
      <td class="num">${b.recovery_factor != null ? b.recovery_factor.toFixed(2) : '—'}</td>
      <td class="num">${b.max_consecutive_losses ?? '—'}</td>
      <td class="num ${profitClass(b.net_profit)}">${fmt.usd(b.net_profit, true)}</td>
      <td>${fmt.shortTime(b.last_trade)}</td>
    </tr>
  `).join('');
}

function updateSortIndicators() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    const key = th.dataset.sort;
    th.classList.toggle('active-sort', key === state.sort.key);
    const base = th.textContent.replace(/ [↑↓]$/, '');
    th.textContent = base + (key === state.sort.key ? (state.sort.dir === 'asc' ? ' ↑' : ' ↓') : '');
  });
}

// --- Bot Audit Modal -----------------------------------------------------

const modalState = {
  bot: null,
  trades: [],
  page: 0,
  pageSize: 100,
  charts: { main: null, monthly: null },
  activeTab: 'growth',
};

async function openAccountModal(vps, login) {
  const overlay = document.getElementById('account-modal-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  const titleEl = document.getElementById('account-modal-title');
  const metaEl = document.getElementById('account-modal-meta');
  const chipsEl = document.getElementById('account-modal-chips');
  const gridEl = document.getElementById('account-bots-grid');
  const emptyEl = document.getElementById('account-bots-empty');
  titleEl.textContent = `Cuenta Real #${login} · ${vpsPrettyName(vps)}`;
  metaEl.textContent = 'Cargando bots de la cuenta…';
  chipsEl.innerHTML = '';
  gridEl.innerHTML = '';
  emptyEl.hidden = true;

  try {
    // Find the account stats from the snapshot.
    const account = (state.snapshot.accounts || []).find(a => a.vps === vps && String(a.login) === String(login));
    if (account) {
      metaEl.innerHTML = `
        Broker ${account.server} · Leverage 1:${account.leverage} · Currency ${account.currency}
      `;
      const pnlCls = account.profit >= 0 ? 'win' : 'loss';
      chipsEl.innerHTML = `
        <span class="chip">Balance ${fmt.usd(account.balance)}</span>
        <span class="chip">Equity ${fmt.usd(account.equity)}</span>
        <span class="chip ${pnlCls}">Flotante ${fmt.usd(account.profit, true)}</span>
        <span class="chip">Margin ${fmt.usd(account.margin)}</span>
      `;
    }

    // Find bots of this account from the snapshot (use 365d aggregate for per-bot summary).
    const accountBots = (state.snapshot.bots || [])
      .filter(b => b.vps === vps && String(b.account_login) === String(login))
      .sort((a, b) => b.net_profit - a.net_profit);

    // Cross-check against per-bot files availability via manifest.
    const manifestRes = await fetch(`data/bots/_manifest.json?t=${Date.now()}`);
    const manifest = manifestRes.ok ? await manifestRes.json() : { bots: {} };
    const availableMagics = new Set(
      Object.values(manifest.bots || {})
        .filter(b => b.vps === vps && String(b.login) === String(login))
        .map(b => String(b.magic))
    );

    if (!accountBots.length) {
      emptyEl.hidden = false;
      return;
    }

    gridEl.innerHTML = accountBots.map(b => {
      const hasFile = availableMagics.has(String(b.magic));
      const netCls = b.net_profit >= 0 ? 'positive' : 'negative';
      const symbols = (b.symbols || []).join(', ') || '—';
      const cta = hasFile
        ? `<div class="account-bot-card-cta">→ Click para auditar este bot</div>`
        : `<div class="account-bot-card-cta" style="color:var(--text-faint)">Sin histórico exportable (manual o sin IN/OUT pairs)</div>`;
      return `
        <div class="account-bot-card ${hasFile ? 'has-audit' : 'no-audit'}"
             data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}"
             data-has-file="${hasFile}">
          <div class="account-bot-card-header">
            <span class="account-bot-card-magic">Magic ${b.magic}${b.magic === 0 ? ' (manual)' : ''}</span>
            <span class="account-bot-card-symbol">${symbols}</span>
          </div>
          <div class="account-bot-card-stats">
            <div><span>Trades 365d</span><strong>${fmt.int(b.trades)}</strong></div>
            <div><span>Win Rate</span><strong>${fmt.pct(b.win_rate_pct)}</strong></div>
            <div><span>Net P&L</span><strong class="${netCls}">${fmt.usd(b.net_profit, true)}</strong></div>
            <div><span>Profit Factor</span><strong>${fmt.pf(b.profit_factor)}</strong></div>
            <div><span>Max DD</span><strong>${fmt.usd(b.max_drawdown || 0)}</strong></div>
            <div><span>Último trade</span><strong>${fmt.shortTime(b.last_trade)}</strong></div>
          </div>
          ${cta}
        </div>
      `;
    }).join('');
  } catch (err) {
    metaEl.innerHTML = `<span class="profit-negative">${err.message}</span>`;
  }
}

function closeAccountModal() {
  const overlay = document.getElementById('account-modal-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  if (document.getElementById('bot-modal-overlay').hidden) {
    document.body.style.overflow = '';
  }
}

function computeMaxDD(trades) {
  const sorted = trades.slice().sort((a, b) => a.close_time - b.close_time);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.net;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  return Math.round(maxDD * 100) / 100;
}

async function openBotModal(vps, login, magic) {
  const overlay = document.getElementById('bot-modal-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  document.getElementById('bot-modal-meta').textContent = 'Cargando histórico…';
  document.getElementById('bot-modal-chips').innerHTML = '';
  document.getElementById('bot-trades-tbody').innerHTML = '';
  document.getElementById('bot-monthly-tbody').innerHTML = '';
  modalState.activeTab = 'growth';
  document.querySelectorAll('.bot-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'growth'));

  try {
    const bot = await fetchBotHistoryWithRetry(vps, login, magic);
    if (!bot) throw new Error(`No pude cargar el histórico de este bot tras reintentos. El archivo puede estar regenerándose en el VPS — espera 1 min y reabre.`);
    modalState.bot = { ...bot, vps };
    modalState.trades = (bot.trades || []).slice().sort((a, b) => b.close_time - a.close_time);
    modalState.page = 0;
    renderModalHeader(vps);
    renderTradesPage();
    renderMonthly();
    renderMainChart('growth');
    updateCompareAddBtnState();
  } catch (err) {
    document.getElementById('bot-modal-meta').innerHTML = `<span class="profit-negative">${err.message}</span>`;
  }
}

/* Fetch per-bot history with retry — handles transient 404 windows during
   atomic mirror swaps and tolerates network blips. Up to 4 attempts with
   exponential backoff (180ms, 380ms, 750ms, 1500ms). */
async function fetchBotHistoryWithRetry(vps, login, magic) {
  const url = `data/bots/${vps}/${login}-${magic}.json`;
  const delays = [180, 380, 750, 1500];
  for (let i = 0; i < delays.length; i++) {
    try {
      const res = await fetch(`${url}?t=${Date.now()}_${i}`);
      if (res.ok) return await res.json();
      if (res.status !== 404) return null; // permanent error
    } catch {}
    await new Promise(r => setTimeout(r, delays[i]));
  }
  return null;
}

function closeBotModal() {
  const overlay = document.getElementById('bot-modal-overlay');
  if (!overlay) return;
  // Close DNA drawer first if it was paired with this bot modal
  const dnaOverlay = document.getElementById('dna-modal-overlay');
  if (dnaOverlay && !dnaOverlay.hidden) closeDNAModal();
  overlay.hidden = true;
  overlay.classList.remove('dna-active');
  document.body.style.overflow = '';
  if (modalState.charts.main) { modalState.charts.main.destroy(); modalState.charts.main = null; }
  if (modalState.charts.monthly) { modalState.charts.monthly.destroy(); modalState.charts.monthly = null; }
}

function renderModalHeader(vps) {
  const b = modalState.bot;
  if (!b) return;
  const symbols = (b.symbols || []).join(', ');
  const firstISO = new Date(b.first_trade_time * 1000);
  const lastISO = new Date(b.last_trade_time * 1000);
  const days = Math.max(1, Math.round((b.last_trade_time - b.first_trade_time) / 86400));
  document.getElementById('bot-modal-title').textContent =
    `Magic ${b.magic} · ${vpsPrettyName(vps)} · cuenta ${b.login}`;
  document.getElementById('bot-modal-meta').innerHTML =
    `${symbols} · activo desde ${firstISO.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })} (${days} días) · último trade: ${fmt.shortTime(lastISO.toISOString())}`;
  const netCls = b.net_profit >= 0 ? 'win' : 'loss';
  const accForDD = (state.snapshot.accounts || []).find(a => a.login === Number(b.login));
  const ddPct = accForDD && b.max_drawdown_abs ? round2((b.max_drawdown_abs / accForDD.balance) * 100) : null;
  const ddLabel = ddPct !== null ? `Max DD ${fmt.usd(b.max_drawdown_abs)} (${ddPct}%)` : `Max DD ${fmt.usd(b.max_drawdown_abs)}`;
  const snapBot = findBotInSnapshot(b.login, b.magic) || {};
  const ci = snapBot.confidence_intervals;
  const lowConfBadge = ci && ci.low_confidence ? `<span class="chip chip-warn" title="Sample chico: trades<50 o <4 meses · métricas con CI ancho">📉 Low confidence</span>` : '';
  const battle = snapBot.event_stress;
  const battleBadge = battle && battle.battle_tested ? `<span class="chip chip-ok" title="Sobrevivió ≥3 eventos macro reales">⚔️ Battle-tested</span>` :
                      battle && battle.n_active > 0 ? `<span class="chip" title="${battle.n_active}/${battle.n_total_events} eventos vividos">⚔️ ${battle.n_active}/${battle.n_total_events} eventos</span>` :
                      battle ? `<span class="chip chip-warn" title="Bot demasiado nuevo para tail events macro">⚠️ Untested</span>` : '';
  // Transferencia demo→real (tribunal P1): ¿el gemelo demo predice al real?
  const tr = snapBot.transfer;
  const trBadge = !(tr && tr.status === 'ok') ? '' :
    `<span class="chip ${tr.match_rate_pct >= 70 ? 'chip-ok' : 'chip-warn'}" title="Gemelo demo ${tr.demo_twin} · ${tr.n_pairs} trades emparejados (±120s) · Δnet medio $${tr.mean_delta_net} · tracking error $${tr.tracking_error} · ${tr.real_only} solo-real / ${tr.demo_only} solo-demo">🔁 Transfer ${tr.match_rate_pct}%${tr.match_rate_pct < 70 ? ' ⚠' : ''}</span>`;
  // Floating-DD shadow (Fase B, tribunal 2026-06-09): cota inferior muestreada
  // 120s — NUNCA llamarla "true DD". Solo aparece si el sampler cubre este bot.
  const fdd = snapBot.floating_dd;
  const fddBadge = !fdd ? '' :
    fdd.insufficient_coverage
      ? `<span class="chip" title="Muestreo flotante: ${fdd.coverage_days}d de cobertura (se requieren ≥7d, ≥90%) · cota inferior, cadencia ${Math.round(fdd.cadence_secs)}s">🌊 DD flotante: midiendo (${fdd.coverage_days}d)</span>`
      : `<span class="chip ${snapBot.would_fail_floating_dd ? 'chip-warn' : ''}" title="Peor DD flotante muestreado (cota inferior, ${Math.round(fdd.cadence_secs)}s) · coverage ${fdd.coverage_pct}% · ${fdd.coverage_days}d · shadow, no afecta el score">🌊 DD flotante ${fdd.max_floating_dd_pct_sampled.toFixed(2)}%${snapBot.would_fail_floating_dd ? ' ⚠' : ''}</span>`;
  // Compute wins/losses exactly from the trade list (most accurate)
  const trades = modalState.trades || [];
  const wins = trades.filter(t => (t.net || 0) > 0).length;
  const losses = trades.filter(t => (t.net || 0) < 0).length;
  const breakeven = trades.length - wins - losses;
  const breakevenChip = breakeven > 0
    ? `<span class="chip" title="Operaciones con net = $0">${breakeven} BE</span>`
    : '';
  document.getElementById('bot-modal-chips').innerHTML = `
    <span class="chip">${b.trade_count} trades</span>
    <span class="chip win" title="Operaciones ganadoras (net > $0)">✓ ${wins} ganados</span>
    <span class="chip loss" title="Operaciones perdedoras (net < $0)">✕ ${losses} perdidos</span>
    ${breakevenChip}
    <span class="chip ${b.win_rate_pct >= 50 ? 'win' : 'loss'}">WR ${b.win_rate_pct.toFixed(1)}%</span>
    <span class="chip ${netCls}">Net ${fmt.usd(b.net_profit, true)}</span>
    <span class="chip">${ddLabel}</span>
    ${fddBadge}
    ${trBadge}
    ${lowConfBadge}
    ${battleBadge}
  `;
  document.getElementById('bot-trades-count').textContent = b.trade_count;
}

function buildSeries(trades) {
  const sorted = trades.slice().sort((a, b) => a.close_time - b.close_time);
  // DD relative to account balance: dd% = (peak_equity - current_equity) / account_balance × 100
  const acc = (state.snapshot.accounts || []).find(a => a.login === modalState.bot.login);
  const accountBalance = acc ? Math.max(1, acc.balance) : null;
  let cum = 0;
  let peak = 0;
  let peakEquity = accountBalance || 0;
  const labels = [];
  const equity = [];
  const dd = [];
  for (const t of sorted) {
    cum += t.net;
    if (cum > peak) peak = cum;
    labels.push(new Date(t.close_time * 1000));
    equity.push(round2(cum));
    if (accountBalance) {
      const botEquity = accountBalance + cum;
      if (botEquity > peakEquity) peakEquity = botEquity;
      const ddAbs = Math.max(0, peakEquity - botEquity);
      dd.push(round2((ddAbs / accountBalance) * 100));
    } else {
      dd.push(peak > 0 ? round2(((peak - cum) / peak) * 100) : 0);
    }
  }
  return { labels, equity, dd };
}

function round2(n) { return Math.round(n * 100) / 100; }

function renderMainChart(kind) {
  modalState.activeTab = kind;
  const ctx = document.getElementById('bot-main-chart');
  if (!ctx) return;
  if (modalState.charts.main) { modalState.charts.main.destroy(); modalState.charts.main = null; }
  // Analysis tabs use a side panel instead of chart canvas.
  if (['risk', 'consistency', 'decay', 'score', 'stress', 'oos', 'regime', 'tracker', 'drift', 'capacity', 'underwater', 'events', 'radar', 'violin', 'pairs', 'timemachine', 'survival'].includes(kind)) {
    const b = modalState.bot ? findBotInSnapshot(modalState.bot.login, modalState.bot.magic) : null;
    if (!b) { showAnalysisPanel(`<div class="empty-state">No hay métricas extendidas para este bot (probablemente no está en el snapshot 365d).</div>`); return; }
    if (kind === 'risk') showAnalysisPanel(renderRiskPanel(b));
    else if (kind === 'consistency') showAnalysisPanel(renderConsistencyPanel(b));
    else if (kind === 'decay') showAnalysisPanel(renderDecayPanel(b));
    else if (kind === 'score') showAnalysisPanel(renderScorePanel(b));
    else if (kind === 'stress') showAnalysisPanel(renderStressPanel(b));
    else if (kind === 'oos') showAnalysisPanel(renderOOSPanel(b));
    else if (kind === 'regime') showAnalysisPanel(renderRegimePanel(b));
    else if (kind === 'tracker') showAnalysisPanel(renderTrackerPanel(b));
    else if (kind === 'drift') showAnalysisPanel(renderDriftPanel(b));
    else if (kind === 'capacity') showAnalysisPanel(renderCapacityPanel(b));
    else if (kind === 'underwater') { showAnalysisPanel(renderUnderwaterPanel(b)); setTimeout(() => drawUnderwaterChart(b), 50); }
    else if (kind === 'events') showAnalysisPanel(renderEventsPanel(b));
    else if (kind === 'radar') { showAnalysisPanel(renderRadarPanel(b)); setTimeout(() => drawRadarChart(b), 50); }
    else if (kind === 'violin') { showAnalysisPanel(renderViolinPanel(b)); setTimeout(() => drawViolinChart(b), 50); }
    else if (kind === 'pairs') { showAnalysisPanel(renderPairsPanel(b)); setTimeout(() => drawPairsCharts(b), 50); }
    else if (kind === 'timemachine') { showAnalysisPanel(renderTimeMachinePanel(b)); setTimeout(() => initTimeMachine(b), 50); }
    else if (kind === 'survival') { showAnalysisPanel(renderSurvivalPanel(b)); setTimeout(() => drawSurvivalChart(b), 50); }
    return;
  }
  hideAnalysisPanel();
  const { labels, equity, dd } = buildSeries(modalState.trades);
  let dataset;
  if (kind === 'growth') {
    // Growth as % vs initial gain pool baseline; show cumulative net relative to peak* — keep it simple: show cumulative USD as line.
    // For pure %: derive from account balance available in main snapshot
    const acc = (state.snapshot.accounts || []).find(a => a.login === modalState.bot.login);
    const baseline = acc ? Math.max(1, acc.balance - modalState.bot.net_profit) : null;
    if (baseline && baseline > 1) {
      const pct = equity.map(v => round2((v / baseline) * 100));
      dataset = {
        label: 'Growth %',
        data: pct,
        borderColor: '#3ddc97',
        backgroundColor: 'rgba(61, 220, 151, 0.12)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      };
    } else {
      dataset = {
        label: 'Equity acumulada (USD)',
        data: equity,
        borderColor: '#3ddc97',
        backgroundColor: 'rgba(61, 220, 151, 0.12)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
      };
    }
  } else if (kind === 'profit') {
    dataset = {
      label: 'Net P&L acumulado (USD)',
      data: equity,
      borderColor: '#7c9cff',
      backgroundColor: 'rgba(124, 156, 255, 0.12)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
    };
  } else {
    dataset = {
      label: 'Drawdown (%)',
      data: dd,
      borderColor: '#ff6b8b',
      backgroundColor: 'rgba(255, 107, 139, 0.18)',
      fill: true,
      tension: 0.2,
      pointRadius: 0,
    };
  }
  modalState.charts.main = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [dataset] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: {
        legend: { display: true, labels: { color: '#9aa3bb', font: { family: 'Inter', size: 11 } } },
        tooltip: {
          backgroundColor: 'rgba(10, 11, 18, 0.95)',
          titleColor: '#e7ebf5', bodyColor: '#9aa3bb',
          callbacks: {
            title: (items) => items[0].label.replace(/,\d{2}:\d{2}.*$/, ''),
            label: (item) => {
              const v = item.raw;
              if (kind === 'growth' && dataset.label === 'Growth %') return `Growth: ${v.toFixed(2)}%`;
              if (kind === 'drawdown') return `DD: ${v.toFixed(2)}%`;
              return `${dataset.label.includes('USD') ? '$' : ''}${v.toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: labels.length > 200 ? 'month' : 'week' },
          ticks: { color: '#6b7390', font: { size: 10 } },
          grid: { display: false },
        },
        y: {
          ticks: {
            color: '#6b7390', font: { family: 'JetBrains Mono', size: 10 },
            callback: (v) => kind === 'growth' && dataset.label === 'Growth %' ? `${v}%` : (kind === 'drawdown' ? `${v}%` : `$${v}`),
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
      },
    },
  });
}

function monthlyAggregates(trades) {
  // Group by YYYY-MM (UTC), with running balance baseline.
  const sorted = trades.slice().sort((a, b) => a.close_time - b.close_time);
  const months = new Map();
  for (const t of sorted) {
    const d = new Date(t.close_time * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!months.has(key)) months.set(key, { key, label: d.toLocaleDateString('es-ES', { month: 'short', year: '2-digit', timeZone: 'UTC' }), trades: 0, net: 0, firstTs: t.close_time });
    const m = months.get(key);
    m.trades += 1;
    m.net += t.net;
  }
  // Compute running balance (use account current balance + reverse-cum so first month % is over balance at month start)
  const acc = (state.snapshot.accounts || []).find(a => a.login === modalState.bot.login);
  const initial = acc ? Math.max(1, acc.balance - modalState.bot.net_profit) : null;
  let running = initial || 0;
  const rows = [];
  for (const m of months.values()) {
    const startBal = running > 0 ? running : null;
    const pct = startBal ? (m.net / startBal) * 100 : null;
    rows.push({ ...m, start_balance: startBal, pct });
    running += m.net;
  }
  return rows;
}

function renderMonthly() {
  const rows = monthlyAggregates(modalState.trades);
  const tbody = document.getElementById('bot-monthly-tbody');
  if (!tbody) return;
  tbody.innerHTML = rows.map(r => {
    const cls = r.net >= 0 ? 'profit-positive' : 'profit-negative';
    return `
      <tr>
        <td>${r.label}</td>
        <td class="num">${r.trades}</td>
        <td class="num ${cls}">${fmt.usd(r.net, true)}</td>
        <td class="num ${cls}">${r.pct != null ? (r.pct >= 0 ? '+' : '') + r.pct.toFixed(2) + '%' : '—'}</td>
      </tr>
    `;
  }).join('');

  const ctx = document.getElementById('bot-monthly-chart');
  if (!ctx) return;
  if (modalState.charts.monthly) { modalState.charts.monthly.destroy(); modalState.charts.monthly = null; }
  const labels = rows.map(r => r.label);
  const data = rows.map(r => r.pct != null ? round2(r.pct) : 0);
  const colors = data.map(v => v >= 0 ? 'rgba(61, 220, 151, 0.85)' : 'rgba(255, 107, 139, 0.85)');
  modalState.charts.monthly = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: '% mensual', data, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(10, 11, 18, 0.95)',
          callbacks: {
            label: (item) => {
              const r = rows[item.dataIndex];
              return [`Net: ${fmt.usd(r.net, true)}`, `${r.trades} trades`, r.pct != null ? `${r.pct.toFixed(2)}%` : ''];
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#6b7390', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#6b7390', font: { family: 'JetBrains Mono', size: 10 }, callback: (v) => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    },
  });
}

function renderTradesPage() {
  const tbody = document.getElementById('bot-trades-tbody');
  if (!tbody) return;
  const total = modalState.trades.length;
  const totalPages = Math.max(1, Math.ceil(total / modalState.pageSize));
  if (modalState.page >= totalPages) modalState.page = totalPages - 1;
  if (modalState.page < 0) modalState.page = 0;
  const start = modalState.page * modalState.pageSize;
  const slice = modalState.trades.slice(start, start + modalState.pageSize);
  tbody.innerHTML = slice.map(t => {
    const open = new Date(t.open_time * 1000);
    const close = new Date(t.close_time * 1000);
    const fmtDt = (d) => d.toLocaleDateString('es-ES', { year: '2-digit', month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });
    const dur = formatDuration(t.duration_sec);
    const netCls = t.net >= 0 ? 'profit-positive' : 'profit-negative';
    const pipsCls = t.pips >= 0 ? 'profit-positive' : 'profit-negative';
    const sideCls = t.side === 'BUY' ? 'action-buy' : 'action-sell';
    return `
      <tr>
        <td>${fmtDt(open)}</td>
        <td>${fmtDt(close)}</td>
        <td>${t.symbol}</td>
        <td><span class="${sideCls}">${t.side}</span></td>
        <td class="num">${t.volume.toFixed(2)}</td>
        <td class="num">${t.open_price}</td>
        <td class="num">${t.close_price}</td>
        <td class="num ${pipsCls}">${t.pips.toFixed(1)}</td>
        <td class="num ${netCls}">${fmt.usd(t.net, true)}</td>
        <td class="num">${fmt.usd(t.swap)}</td>
        <td>${dur}</td>
      </tr>
    `;
  }).join('');
  document.getElementById('bot-page-info').textContent = `${modalState.page + 1} / ${totalPages}`;
  document.getElementById('bot-page-prev').disabled = modalState.page === 0;
  document.getElementById('bot-page-next').disabled = modalState.page >= totalPages - 1;
}

function formatDuration(sec) {
  if (!sec || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function wireBotModal() {
  // Delegated clicks limited to:
  //  - .account-card (real-account cards) → openAccountModal
  //  - .account-bot-card[data-has-file="true"] (cards inside account modal) → openBotModal
  //  - #real-bots-tbody tr.bot-row → openBotModal (legacy direct path)
  document.body.addEventListener('click', (e) => {
    const accountCard = e.target.closest('.account-card');
    if (accountCard) {
      const { vps, login } = accountCard.dataset;
      if (vps && login) openAccountModal(vps, login);
      return;
    }
    const accountBotCard = e.target.closest('.account-bot-card');
    if (accountBotCard) {
      if (accountBotCard.dataset.hasFile !== 'true') return;
      const { vps, login, magic } = accountBotCard.dataset;
      if (vps && login && magic) openBotModal(vps, login, magic);
      return;
    }
    const auditableRow = e.target.closest('#real-bots-tbody tr.bot-row, #balanced-tbody tr.bot-row, #new-bots-tbody tr.bot-row, #candidates-tbody tr.bot-row, #podium .bot-row, #bots-tbody tr.bot-row, #portfolio-canvas .port-row.bot-row, #bld-selected-list .bld-selected-row.bot-row');
    if (auditableRow) {
      const { vps, login, magic } = auditableRow.dataset;
      if (vps && login && magic) openBotModal(vps, login, magic);
    }
  });
  document.getElementById('bot-modal-close').addEventListener('click', closeBotModal);
  document.getElementById('bot-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'bot-modal-overlay') closeBotModal();
  });
  document.getElementById('account-modal-close').addEventListener('click', closeAccountModal);
  document.getElementById('account-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'account-modal-overlay') closeAccountModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Close the topmost open modal first (bot modal sits above account modal).
    if (!document.getElementById('bot-modal-overlay').hidden) { closeBotModal(); return; }
    if (!document.getElementById('account-modal-overlay').hidden) { closeAccountModal(); return; }
  });
  document.querySelectorAll('.bot-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.bot-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderMainChart(tab.dataset.tab);
    });
  });
  document.getElementById('bot-page-prev').addEventListener('click', () => { modalState.page -= 1; renderTradesPage(); });
  document.getElementById('bot-page-next').addEventListener('click', () => { modalState.page += 1; renderTradesPage(); });
}

// --- Candidates section (Promotion Score) --------------------------------

function statusBadge(status) {
  const map = {
    READY: { cls: 'status-ready', label: '✅ READY' },
    NEAR: { cls: 'status-near', label: '🟡 NEAR' },
    WATCH: { cls: 'status-watch', label: '👀 WATCH' },
    NO: { cls: 'status-no', label: '❌ NO' },
  };
  const m = map[status] || { cls: 'status-no', label: status || '—' };
  return `<span class="status-pill ${m.cls}">${m.label}</span>`;
}

// Dominance badge: ✅ Caballo = top-25% (≥P75) en los 4 ejes núcleo (dinero, riesgo,
// consistencia, estabilidad) Y ningún otro bot lo supera en todos a la vez. ⚠ Discutible
// = no cumple; el tooltip dice por qué (quién lo domina y/o en qué eje queda bajo P75) +
// los 4 percentiles. Diagnóstico puro del snapshot actual (sin estado → 100% dinámico).
function dominanceBadge(dom) {
  if (!dom || !dom.axes) return '<span style="color:var(--text-dim)" title="Fuera de la cohorte elegible (no pasa gating)">—</span>';
  const pctList = Object.values(dom.axes)
    .map(v => `${v.label}: P${v.pct != null ? Math.round(v.pct) : '—'}`).join(' · ');
  if (dom.is_thoroughbred) {
    return `<span style="color:#16c784;font-weight:600;white-space:nowrap" title="Caballo: top-25% (≥P75) en TODOS los ejes y ningún bot lo supera en todo · ${pctList}">✅ Caballo</span>`;
  }
  const reasons = [];
  if (dom.dominated_by != null) reasons.push(`Superado por #${dom.dominated_by} en todos los ejes`);
  if (!dom.all_ge_p75) {
    const weak = Object.values(dom.axes)
      .filter(v => v.pct == null || v.pct < 75).map(v => v.label).join(', ');
    if (weak) reasons.push(`Bajo P75 en: ${weak}`);
  }
  const title = [...reasons, pctList].join(' · ').replace(/"/g, "'");
  return `<span style="color:#f0a020;font-weight:600;white-space:nowrap" title="${title}">⚠ Discutible</span>`;
}

// Quality badge: resume of the 4 quality score-factors (robustez OOS, seguridad/riesgo
// de ruina, cola/CVaR, significancia estadística). 🟢 sólido / 🟡 medio / 🔴 flojo,
// con el desglose en el tooltip. Son factores del score (no gates) → la sección
// siempre muestra 3; el badge avisa si alguno cojea en calidad.
function qualityBadge(b) {
  const c = b.promotion_components || {};
  const keys = ['oos_robustness', 'safety', 'tail_quality', 'significance'];
  const vals = keys.map(k => (typeof c[k] === 'number' ? c[k] : null)).filter(v => v != null);
  if (!vals.length) return '<span style="color:var(--text-dim)">—</span>';
  const avg = vals.reduce((a, v) => a + v, 0) / vals.length;
  const worst = Math.min(...vals);
  const lbl = { oos_robustness: 'OOS', safety: 'Seguridad', tail_quality: 'Cola', significance: 'Signif' };
  const tip = keys.map(k => `${lbl[k]}: ${c[k] != null ? Math.round(c[k] * 100) : '—'}`).join(' · ');
  const icon = (avg >= 0.6 && worst >= 0.4) ? '🟢' : (avg >= 0.45 ? '🟡' : '🔴');
  return `<span style="white-space:nowrap" title="${tip}">${icon} ${Math.round(avg * 100)}</span>`;
}

function fmtSigned(n, digits = 2) {
  if (n == null) return '—';
  const v = Number(n);
  return (v > 0 ? '+' : '') + v.toFixed(digits);
}

// --- 🏛️ Ultra Tribunal — sincronización veredicto ↔ candidatos ------------
// Visual-only: el veredicto NUNCA reordena asientos. Doble firma = READY
// (gating cuantitativo, cada 30 min) ∧ podio del tribunal (50 pares
// adversariales, semanal). Backend: apply_tribunal() en post_merge.py.

const TRIBUNAL_MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

function tribunalMeta() {
  return (state.snapshot && state.snapshot.tribunal_meta) || null;
}

function tribunalCellHtml(b) {
  const tm = tribunalMeta();
  if (!tm) return '<span style="color:var(--text-dim)">—</span>';
  const t = b.tribunal;
  const parts = [];
  if (t && !t.is_suplente && t.rank != null) {
    const medal = TRIBUNAL_MEDALS[t.rank] || `#${t.rank}`;
    const dis = (t.dissents || []).length;
    parts.push(`<span style="white-space:nowrap" title="Podio del Ultra Tribunal ${t.run_date} · rank #${t.rank} · comp ${t.comp != null ? t.comp.toFixed(1) : '—'} · gate ${t.gate || '—'}${dis ? ` · ${dis} disenso(s) registrado(s) — ver modal` : ''}">${medal}</span>`);
  } else if (t && t.is_suplente) {
    parts.push(`<span style="white-space:nowrap;color:var(--text-dim)" title="Suplente del tribunal ${t.run_date}: ${String(t.note || '').replace(/"/g, "'")}">🎗 supl.</span>`);
  }
  const ds = b.double_signature;
  if (ds === 'confirmed') {
    if (tm.verdict_state === 'vigente') {
      parts.push(`<span class="chip" style="background:rgba(22,199,132,.15);color:#16c784;font-weight:700" title="DOBLE FIRMA: READY (gating cuantitativo, cada 30 min) ∧ podio del Ultra Tribunal (${tm.run_date}). Dos vías independientes coinciden — candidato sí-o-sí a cuenta real (veto humano final).">✓✓ SUBIR</span>`);
    } else if (tm.verdict_state === 'viejo') {
      parts.push(`<span class="chip chip-warn" title="READY ∧ podio, pero el veredicto tiene ${tm.age_days} días (>${tm.fresh_days}d): relanzar el tribunal para re-confirmar la doble firma">✓✓ ${tm.age_days}d</span>`);
    } else {
      parts.push(`<span class="chip" style="color:var(--text-dim)" title="READY ∧ podio, pero el veredicto EXPIRÓ (${tm.age_days}d > ${tm.expired_days}d): la doble firma ya no vale — relanzar tribunal">✓✓ expirado</span>`);
    }
  } else if (ds === 'quant_only') {
    parts.push(`<span class="chip chip-warn" title="READY por score, pero NO está en el podio del tribunal ${tm.run_date} — falta la segunda firma (adversarial)">✓· solo quant</span>`);
  } else if (ds === 'tribunal_only') {
    parts.push(`<span class="chip chip-warn" title="En el podio del tribunal ${tm.run_date} pero HOY no es READY — divergencia que investigar">🏛️ sin READY</span>`);
  }
  const stale = (t && t.stale_reasons) || [];
  if (stale.length) {
    parts.push(`<span class="chip chip-danger" title="Veredicto posiblemente OBSOLETO para este bot — cambio material desde ${t.run_date}: ${stale.join(' · ').replace(/"/g, "'")}">⚠ obsoleto</span>`);
  }
  return parts.join(' ') || '<span style="color:var(--text-dim)">—</span>';
}

function rachaCellHtml(b) {
  const h = b.tribunal_history;
  const pod = h ? h.consecutive_podiums : 0;
  const days = b.ready_streak_days;
  const bits = [];
  if (pod > 0) {
    const path = (h.ranks || []).map(r => '#' + r.rank).join('→');
    bits.push(`<span title="${pod} veredicto(s) consecutivo(s) en el podio (${h.podium_appearances} total, 1º ${h.first_podium}) · trayectoria: ${path}">🏛️×${pod}</span>`);
  }
  if (days != null) bits.push(`<span title="${days} día(s) consecutivo(s) en READY según el ledger append-only (candidates_history)">${days}d</span>`);
  return bits.length ? `<span style="white-space:nowrap">${bits.join(' · ')}</span>` : '<span style="color:var(--text-dim)">—</span>';
}

function renderTribunalStrip() {
  const strip = document.getElementById('tribunal-strip');
  if (!strip) return;
  const tm = tribunalMeta();
  if (!tm) { strip.hidden = true; return; }
  const c = tm.concordance || {};
  const chips = [];
  const ageCls = tm.verdict_state === 'vigente' ? 'background:rgba(22,199,132,.12);color:#16c784'
    : tm.verdict_state === 'viejo' ? 'background:rgba(240,160,32,.12);color:#f0a020'
    : 'background:rgba(234,57,67,.12);color:#ea3943';
  chips.push(`<span class="chip" style="${ageCls};font-weight:600" title="Último veredicto del Ultra Tribunal (50 pares adversariales): ${tm.run_date} · estado ${tm.verdict_state} (vigente ≤${tm.fresh_days}d, expira >${tm.expired_days}d)${tm.verdict_state !== 'vigente' ? ' — relanzar tribunal' : ''}">🏛️ Veredicto hace ${tm.age_days}d · ${tm.verdict_state}</span>`);
  const full = c.matches === c.of;
  const concCls = full ? 'background:rgba(22,199,132,.12);color:#16c784' : 'background:rgba(240,160,32,.12);color:#f0a020';
  const diverge = !full ? ` · divergen: ${(c.podium_not_ready || []).join(', ') || '—'}` : '';
  chips.push(`<span class="chip" style="${concCls};font-weight:600" title="¿Cuántos de los READY actuales coinciden con el podio del tribunal? READY sin podio: ${(c.ready_not_podium || []).join(', ') || 'ninguno'}. Podio sin READY: ${(c.podium_not_ready || []).join(', ') || 'ninguno'}.">🤝 Concordancia tribunal ${c.matches}/${c.of}${diverge}</span>`);
  const cg = tm.continuous_gate || {};
  if (cg.verdict) {
    const pass = cg.verdict === 'PASS';
    const gCls = pass ? 'background:rgba(22,199,132,.12);color:#16c784' : 'background:rgba(234,57,67,.12);color:#ea3943';
    const vio = (cg.violations || []).map(v => `${v.challenger} domina a ${v.winner} en ${v.beats_on}/${v.of} ejes (${(v.axes || []).join(', ')})`).join(' · ').replace(/"/g, "'");
    chips.push(`<span class="chip" style="${gCls};font-weight:600" title="Gate de dominancia del tribunal (12 ejes núcleo, misma regla que verify_verdict.py vía gate_lib) corrido sobre el top-3 READY en CADA ciclo de 30 min · cohorte viva: ${cg.cohort_n || '—'} bots. ${pass ? 'Ningún retador con evidencia comparable domina al top-3.' : 'REJECT — señal temprana de que el próximo tribunal cambiará el podio: ' + vio}">⚖️ Gate continuo ${cg.verdict}${pass ? '' : ` (${(cg.violations || []).length})`}</span>`);
  }
  strip.innerHTML = chips.join('');
  strip.hidden = false;
}

function renderCandidates() {
  const tbody = document.getElementById('candidates-tbody');
  const empty = document.getElementById('candidates-empty');
  const counter = document.getElementById('candidates-count');
  if (!tbody) return;
  renderTribunalStrip();
  // Pool: solo bots candidatos reales (READY/NEAR/WATCH) — NO no se muestra (no es candidato).
  const CANDIDATE_STATUSES = new Set(['READY', 'NEAR', 'WATCH']);
  let pool = (state.snapshot.bots || [])
    .filter(b => b.promotion_score != null && b.magic && b.magic !== 0
              && CANDIDATE_STATUSES.has(b.promotion_status)
              && !state.realLogins.has(b.account_login)
              && !state.realMagics.has(b.magic));
  const honestNet = b => (b.net_after_commission != null ? b.net_after_commission : b.net_profit);
  pool.sort((a, b) => (b.promotion_score - a.promotion_score) || (honestNet(b) - honestNet(a)));
  if (counter) counter.textContent = pool.length;
  const f = CANDIDATE_STATUSES.has(state.candidatesStatusFilter) ? state.candidatesStatusFilter : 'READY';
  pool = pool.filter(b => b.promotion_status === f);
  // Caps from the backend (single source of truth) — keeps FE/BE in lockstep.
  const rc = (state.snapshot.promotion_meta && state.snapshot.promotion_meta.rank_caps) || {};
  const caps = { READY: rc.READY ?? 3, NEAR: rc.NEAR ?? 5, WATCH: rc.WATCH ?? 15 };
  const top = pool.slice(0, caps[f]);
  if (!top.length) {
    tbody.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  tbody.innerHTML = top.map((b, i) => {
    const decay = b.decay_ratio == null ? '—' : (b.decay_flag ? `⚠ ${b.decay_ratio.toFixed(2)}` : b.decay_ratio.toFixed(2));
    const decayCls = b.decay_flag ? 'profit-negative' : '';
    const sm = b.shrinkage_meta;
    const confChip = sm
      ? `<span class="shr-conf shr-conf-${(sm.confidence || 'MEDIUM').toLowerCase()}" title="Score shrunk ${b.promotion_score_shrunk?.toFixed(1)} · Δ ${sm.delta > 0 ? '+' : ''}${(sm.delta||0).toFixed(1)} · ${sm.cohort_prior_used ? 'cohort' : 'global'} prior n=${sm.cohort_n}">${sm.confidence === 'HIGH' ? '◉' : sm.confidence === 'MEDIUM' ? '◐' : '◯'}</span>`
      : '';
    const domCell = dominanceBadge(b.dominance);
    const ddPct = b.dd_pct_of_balance;
    const provChip = b.provisional_low_confidence
      ? `<span class="chip chip-warn" title="Cupo de respaldo: no hay suficientes bots de PLENA confianza en el campo — subido provisionalmente. Fallas de confianza: ${(b.trust_fails || []).join(', ') || '—'}">⚠ provisional</span>`
      : '';
    const dsl = b.days_since_last_trade;
    const freshChip = dsl == null ? ''
      : b.dormant ? `<span class="chip chip-danger" title="Sin operar hace ${dsl} días — fuera de READY/NEAR por frescura (competencia siempre activa)">💤 ${dsl}d</span>`
      : dsl > 7 ? `<span class="chip" title="Último trade hace ${dsl} días">🕒 ${dsl}d</span>` : '';
    return `
      <tr class="bot-row" data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}">
        ${buildCompareCheckboxCell(b.vps, b.account_login, b.magic)}
        <td><span class="rank-badge">${i + 1}</span></td>
        <td class="num"><strong style="color:var(--accent)">${b.promotion_score.toFixed(1)}</strong> ${confChip}</td>
        <td>${statusBadge(b.promotion_status)} ${provChip} ${freshChip}</td>
        <td>${tribunalCellHtml(b)}</td>
        <td class="num">${rachaCellHtml(b)}</td>
        <td>${domCell}</td>
        <td>${qualityBadge(b)}</td>
        <td class="mono">${b.magic}</td>
        <td>${(b.symbols || []).map(s => `<span class="symbol-tag">${s}</span>`).join('') || '—'}</td>
        <td>${vpsBadge(b.vps)}</td>
        <td class="mono">${b.account_login}</td>
        <td class="num">${b.calmar != null ? b.calmar.toFixed(2) : '—'}</td>
        <td class="num ${ddPct != null && ddPct > 10 ? 'profit-negative' : ''}">${ddPct != null ? ddPct.toFixed(1) + '%' : '—'}</td>
        <td class="num">${b.sortino != null ? b.sortino.toFixed(2) : '—'}</td>
        <td class="num">${fmt.pf(b.profit_factor)}</td>
        <td class="num">${b.months_positive_pct != null ? fmt.pct(b.months_positive_pct) : '—'}</td>
        <td class="num ${decayCls}">${decay}</td>
        <td class="num">${fmt.int(b.trades)}</td>
        <td class="num profit-positive">${fmt.int(b.wins || 0)}</td>
        <td class="num profit-negative">${fmt.int((b.trades || 0) - (b.wins || 0))}</td>
        <td class="num">${fmt.pct(b.win_rate_pct)}</td>
        <td class="num ${b.net_profit >= 0 ? 'profit-positive' : 'profit-negative'}">${fmt.usd(b.net_profit, true)}</td>
        <td class="num ${(b.net_after_commission ?? 0) >= 0 ? 'profit-positive' : 'profit-negative'}">${b.net_after_commission != null ? fmt.usd(b.net_after_commission, true) : '—'}</td>
      </tr>
    `;
  }).join('');
}

// Forward Tracker standalone section removed 2026-06-08 (renderForwardTracker +
// #tracker-section). Modal tab 🚀 Tracker (renderTrackerPanel) + backend stay.

// --- 💼 PORTFOLIO MODAL --------------------------------------------------

const portfolioState = { data: null, capital: 50000, method: 'inverse_volatility' };

async function loadPortfolio() {
  try {
    const res = await fetch(`data/portfolio.json?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function openPortfolioModal() {
  const overlay = document.getElementById('portfolio-modal-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!portfolioState.data) portfolioState.data = await loadPortfolio();
  renderPortfolio();
}

function closePortfolioModal() {
  const overlay = document.getElementById('portfolio-modal-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  if (document.getElementById('bot-modal-overlay').hidden &&
      document.getElementById('account-modal-overlay').hidden &&
      document.getElementById('corr-modal-overlay').hidden) {
    document.body.style.overflow = '';
  }
}

function renderPortfolio() {
  const data = portfolioState.data;
  const canvas = document.getElementById('portfolio-canvas');
  if (!canvas) return;
  if (!data) {
    canvas.innerHTML = `<div class="empty-state">No hay portfolio.json — corre <code>post_merge.py</code> primero.</div>`;
    return;
  }
  const cap = portfolioState.capital;
  const method = portfolioState.method;
  // Defense-in-depth: the backend already excludes real-account magics from portfolio.json,
  // so this is a no-op in steady state. It only fires in the window where the backend is one
  // cycle stale, guaranteeing the modal never shows capital assigned to an already-real EA.
  const allocations = ((data.allocations[String(cap)] || {})[method] || [])
    .filter(a => !state.realMagics.has(a.magic));
  document.getElementById('port-stat-bots').textContent = data.n_bots;
  document.getElementById('port-stat-capital').textContent = `$${cap.toLocaleString('en-US')}`;
  const methodLabel = method === 'inverse_volatility' ? 'Inv. Volatility' : method === 'equal_weight' ? 'Equal Weight' : 'Score Weighted';
  document.getElementById('port-stat-method').textContent = methodLabel;
  const total = allocations.reduce((s, a) => s + (a.capital_usd || 0), 0);
  document.getElementById('port-stat-total').textContent = `$${total.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

  // Sort by weight desc.
  const sorted = [...allocations].sort((a, b) => b.weight - a.weight);
  const maxW = Math.max(...sorted.map(a => a.weight), 0.0001);
  const rows = sorted.map((a, i) => {
    const widthPct = (a.weight / maxW) * 100;
    return `
      <div class="port-row bot-row" data-vps="${a.vps}" data-login="${a.login}" data-magic="${a.magic}" style="animation-delay:${i * 60}ms">
        <div class="port-row-rank">#${i + 1}</div>
        <div class="port-row-id">
          <div class="port-row-magic mono">${a.magic}</div>
          <div class="port-row-meta">${(a.symbols || []).join(', ')} · ${(a.vps || '').toUpperCase()} · cuenta ${a.login}</div>
        </div>
        <div class="port-row-score">
          <span class="port-score-pill">${(a.score || 0).toFixed(0)}</span>
          ${statusBadge(a.status)}
        </div>
        <div class="port-row-bar-wrap">
          <div class="port-row-bar"><span class="port-row-bar-fill" style="width:${widthPct.toFixed(1)}%"></span></div>
          <div class="port-row-weight"><strong>${(a.weight * 100).toFixed(2)}%</strong></div>
        </div>
        <div class="port-row-usd">
          <strong>$${(a.capital_usd || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
          <span class="port-row-usd-meta">${a.trades} trades · σ=${(a.daily_stdev || 0).toFixed(2)}</span>
        </div>
      </div>`;
  }).join('');
  canvas.innerHTML = `
    <div class="port-explainer">${data.notes || ''}</div>
    <div class="port-list">${rows}</div>
    <div class="port-footer">
      <div>Generado: <strong>${fmt.dateTime(data.generated_at)}</strong></div>
      <div>Click en cualquier bot para auditarlo</div>
    </div>
  `;
}

function wirePortfolioModal() {
  const btn = document.getElementById('portfolio-btn');
  if (btn) btn.addEventListener('click', openPortfolioModal);
  const close = document.getElementById('portfolio-modal-close');
  if (close) close.addEventListener('click', closePortfolioModal);
  const overlay = document.getElementById('portfolio-modal-overlay');
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target.id === 'portfolio-modal-overlay') closePortfolioModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('portfolio-modal-overlay').hidden &&
        document.getElementById('bot-modal-overlay').hidden &&
        document.getElementById('account-modal-overlay').hidden &&
        document.getElementById('corr-modal-overlay').hidden) {
      closePortfolioModal();
    }
  });
  // Capital pills
  document.querySelectorAll('#port-capital-pills .pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#port-capital-pills .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      portfolioState.capital = Number(p.dataset.capital);
      renderPortfolio();
    });
  });
  // Method pills
  document.querySelectorAll('#port-method-pills .pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#port-method-pills .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      portfolioState.method = p.dataset.method;
      renderPortfolio();
    });
  });
}

// --- 🎛️ MINI-PORTFOLIO BUILDER (Idea 1) ---------------------------------

const builderState = {
  selected: [],            // array of keys "vps-login-magic"
  capital: 50000,
  method: 'risk_parity',
  seriesCache: {},         // key -> per-bot json
  chart: null,
  catalogSearch: '',
};

const BLD_MIN = 2;
const BLD_MAX = 8;

function bldKey(vps, login, magic) { return `${vps}-${login}-${magic}`; }

function bldGetUniverse() {
  const snap = state.snapshot;
  if (!snap) return [];
  return (snap.bots || [])
    .filter(b => (b.promotion_status === 'READY' || b.promotion_status === 'NEAR') && b.magic !== 0
              && !state.realLogins.has(b.account_login)
              && !state.realMagics.has(b.magic))
    .map(b => ({
      key: bldKey(b.vps, b.account_login, b.magic),
      vps: b.vps,
      login: b.account_login,
      magic: b.magic,
      symbols: b.symbols || [],
      status: b.promotion_status,
      score: b.promotion_score || 0,
      net_profit: b.net_profit || 0,
      trades: b.trades || 0,
      calmar: b.calmar,
      sortino: b.sortino,
    }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function bldAccountBalance(vps, login) {
  const acc = (state.snapshot?.accounts || []).find(a => a.vps === vps && String(a.login) === String(login));
  return acc?.balance || 100000;
}

async function bldLoadSeries(key, vps, login, magic) {
  if (builderState.seriesCache[key]) return builderState.seriesCache[key];
  try {
    const res = await fetch(`data/bots/${vps}/${login}-${magic}.json?t=${Date.now()}`);
    if (!res.ok) return null;
    const data = await res.json();
    builderState.seriesCache[key] = data;
    return data;
  } catch { return null; }
}

// Daily series helpers ----------------------------------------------------

function bldDailyStdev(series) {
  if (!series || series.length < 2) return 0;
  const xs = series.map(p => p.daily_net || 0);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function bldPearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 5) return 0;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    sx += x; sy += y; sxy += x * y; sx2 += x * x; sy2 += y * y;
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return den === 0 ? 0 : num / den;
}

// Build aligned date matrix: rows = dates, cols = bots, value = daily_net
function bldAlignSeries(boundles) {
  // boundles: [{key, series:[{date, daily_net}]}]
  const allDates = new Set();
  boundles.forEach(b => (b.series || []).forEach(p => allDates.add(p.date)));
  const dates = Array.from(allDates).sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const matrix = boundles.map(() => new Array(dates.length).fill(0));
  boundles.forEach((b, j) => {
    (b.series || []).forEach(p => {
      const i = dateIdx.get(p.date);
      if (i != null) matrix[j][i] = p.daily_net || 0;
    });
  });
  return { dates, matrix };
}

// Weight methods ----------------------------------------------------------

function bldWeightsEqual(n) {
  return new Array(n).fill(1 / n);
}

function bldWeightsInverseVol(stdevs) {
  const inv = stdevs.map(s => (s > 0 ? 1 / s : 0));
  const sum = inv.reduce((a, b) => a + b, 0);
  if (sum === 0) return bldWeightsEqual(stdevs.length);
  return inv.map(x => x / sum);
}

function bldWeightsScore(scores) {
  const sum = scores.reduce((a, b) => a + b, 0);
  if (sum === 0) return bldWeightsEqual(scores.length);
  return scores.map(s => s / sum);
}

// Risk Parity via cyclical coordinate descent on covariance matrix.
// Σ_ij = ρ_ij * σ_i * σ_j ; equal risk contribution: w_i * (Σ w)_i = const.
function bldWeightsRiskParity(stdevs, corr) {
  const n = stdevs.length;
  if (n === 1) return [1];
  // Build covariance
  const cov = [];
  for (let i = 0; i < n; i++) {
    cov.push(new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const r = (i === j) ? 1 : (corr[i]?.[j] ?? 0);
      cov[i][j] = r * stdevs[i] * stdevs[j];
    }
  }
  // Initialize equal weights
  let w = new Array(n).fill(1 / n);
  for (let iter = 0; iter < 200; iter++) {
    // marginal risk contribution: MRC_i = (Σw)_i ; risk contribution = w_i * MRC_i
    const Sw = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Sw[i] += cov[i][j] * w[j];
    const portVar = w.reduce((s, wi, i) => s + wi * Sw[i], 0);
    if (portVar <= 0) break;
    const target = portVar / n;
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const rc = w[i] * Sw[i];
      if (rc <= 0) continue;
      const adjust = Math.sqrt(target / rc);
      const oldW = w[i];
      w[i] = w[i] * adjust;
      maxDelta = Math.max(maxDelta, Math.abs(w[i] - oldW));
    }
    // Renormalize
    const sum = w.reduce((a, b) => a + b, 0);
    if (sum > 0) w = w.map(x => x / sum);
    if (maxDelta < 1e-6) break;
  }
  return w;
}

// Aggregate metrics from combined daily series -----------------------------

function bldComputeMetrics(weights, bundles, capital) {
  // bundles[i].series gives daily_net AND account_balance.
  // Each bot's contribution to portfolio daily net = daily_net * (capital_assigned_i / account_balance_i).
  const n = bundles.length;
  const capPerBot = weights.map(w => w * capital);
  const scales = bundles.map((b, i) => {
    const bal = b.account_balance || bldAccountBalance(b.vps, b.login) || 100000;
    return capPerBot[i] / bal;
  });
  const { dates, matrix } = bldAlignSeries(bundles);
  if (dates.length === 0) {
    return { dates: [], cum: [], dailies: [], net: 0, maxDD: 0, maxDDPct: 0, calmar: null, sharpe: null, sortino: null, monthsPosPct: null, dailyStdev: 0 };
  }
  // Combined daily net per day
  const dailies = new Array(dates.length).fill(0);
  for (let t = 0; t < dates.length; t++) {
    for (let i = 0; i < n; i++) dailies[t] += matrix[i][t] * scales[i];
  }
  const cum = new Array(dates.length);
  let running = 0, peak = 0, maxDD = 0;
  for (let t = 0; t < dates.length; t++) {
    running += dailies[t];
    cum[t] = running;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }
  const net = running;
  const maxDDPct = capital > 0 ? (maxDD / capital) * 100 : 0;
  const calmar = maxDD > 0 ? net / maxDD : null;
  // Sharpe & Sortino on daily series of portfolio
  const mean = dailies.reduce((a, b) => a + b, 0) / dailies.length;
  const variance = dailies.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, dailies.length - 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : null;
  const downside = dailies.filter(x => x < 0);
  const downStd = downside.length > 1
    ? Math.sqrt(downside.reduce((s, x) => s + x * x, 0) / downside.length)
    : 0;
  const sortino = downStd > 0 ? (mean / downStd) * Math.sqrt(252) : null;
  // Months positive %
  const byMonth = new Map();
  for (let t = 0; t < dates.length; t++) {
    const ym = dates[t].slice(0, 7);
    byMonth.set(ym, (byMonth.get(ym) || 0) + dailies[t]);
  }
  const monthVals = Array.from(byMonth.values());
  const monthsPosPct = monthVals.length > 0
    ? (monthVals.filter(x => x > 0).length / monthVals.length) * 100
    : null;
  return { dates, cum, dailies, net, maxDD, maxDDPct, calmar, sharpe, sortino, monthsPosPct, dailyStdev: std };
}

function bldAvgCorrelation(corrMatrix) {
  const n = corrMatrix.length;
  if (n < 2) return null;
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { sum += corrMatrix[i][j]; count += 1; }
  return count > 0 ? sum / count : null;
}

function bldHerfindahl(items) {
  const total = items.reduce((s, x) => s + x.weight, 0);
  if (total === 0) return 0;
  return items.reduce((s, x) => s + (x.weight / total) ** 2, 0);
}

function bldGroupBySymbol(bundles, weights) {
  const map = new Map();
  bundles.forEach((b, i) => {
    const sym = (b.symbols || ['?'])[0].replace(/\.b$/, '');
    map.set(sym, (map.get(sym) || 0) + weights[i]);
  });
  return Array.from(map.entries()).map(([symbol, weight]) => ({ symbol, weight }));
}

// --- Builder modal lifecycle ----------------------------------------------

async function openBuilderModal() {
  const overlay = document.getElementById('builder-modal-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  bldRenderCatalog();
  await bldRecalc();
}

function closeBuilderModal() {
  const overlay = document.getElementById('builder-modal-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  if (document.getElementById('bot-modal-overlay').hidden &&
      document.getElementById('account-modal-overlay').hidden &&
      document.getElementById('corr-modal-overlay').hidden &&
      document.getElementById('portfolio-modal-overlay').hidden) {
    document.body.style.overflow = '';
  }
}

function bldRenderCatalog() {
  const list = document.getElementById('bld-catalog-list');
  const countEl = document.getElementById('bld-catalog-count');
  if (!list) return;
  const universe = bldGetUniverse();
  countEl.textContent = `${universe.length} disponibles`;
  if (!universe.length) {
    list.innerHTML = `<div class="empty-state">Aún no hay bots READY o NEAR. Vuelve cuando el Promotion Score eleve algunos.</div>`;
    return;
  }
  list.innerHTML = universe.map((b, i) => {
    const sel = builderState.selected.includes(b.key);
    const disabled = !sel && builderState.selected.length >= BLD_MAX;
    return `
      <div class="builder-cat-item ${sel ? 'selected' : ''} ${disabled ? 'disabled' : ''}"
           data-key="${b.key}" style="animation-delay:${i * 40}ms">
        <div class="builder-cat-check">${sel ? '✓' : '+'}</div>
        <div class="builder-cat-id">
          <div class="builder-cat-magic mono">${b.magic}</div>
          <div class="builder-cat-meta">
            ${(b.symbols || []).map(s => s.replace(/\.b$/, '')).join(', ') || '?'} ·
            ${(b.vps || '').toUpperCase()} · cuenta ${b.login}
          </div>
        </div>
        <div class="builder-cat-stats">
          ${statusBadge(b.status)}
          <span class="builder-cat-score">${(b.score || 0).toFixed(0)}</span>
        </div>
      </div>`;
  }).join('');
}

function bldRenderEmpty() {
  document.getElementById('bld-empty').hidden = false;
  document.getElementById('bld-equity-wrap').hidden = true;
  document.getElementById('bld-health').hidden = true;
  document.getElementById('bld-selected-list').innerHTML = '';
  document.getElementById('bld-stat-count').textContent = `${builderState.selected.length} / ${BLD_MAX}`;
  document.getElementById('bld-stat-net').textContent = '$0';
  document.getElementById('bld-stat-dd').textContent = '$0';
  document.getElementById('bld-stat-calmar').textContent = '—';
  document.getElementById('bld-stat-corr').textContent = '—';
}

async function bldRecalc() {
  const selKeys = builderState.selected;
  document.getElementById('bld-stat-count').textContent = `${selKeys.length} / ${BLD_MAX}`;
  document.getElementById('bld-stat-capital').textContent = `$${builderState.capital.toLocaleString('en-US')}`;
  bldRenderCatalog();

  if (selKeys.length < BLD_MIN) {
    bldRenderEmpty();
    return;
  }

  // Load per-bot series for selected
  const universe = bldGetUniverse();
  const bundles = [];
  for (const key of selKeys) {
    const meta = universe.find(u => u.key === key);
    if (!meta) continue;
    const data = await bldLoadSeries(key, meta.vps, meta.login, meta.magic);
    if (!data) continue;
    bundles.push({
      key,
      vps: meta.vps,
      login: meta.login,
      magic: meta.magic,
      symbols: meta.symbols,
      status: meta.status,
      score: meta.score,
      account_balance: data.account_balance,
      series: data.daily_equity_series || [],
    });
  }
  if (bundles.length < BLD_MIN) {
    bldRenderEmpty();
    return;
  }

  // Compute σ per bot
  const stdevs = bundles.map(b => bldDailyStdev(b.series));

  // Pairwise correlation among selected bots from aligned dailies
  const { matrix } = bldAlignSeries(bundles);
  const corr = bundles.map((_, i) => bundles.map((_, j) => i === j ? 1 : bldPearson(matrix[i], matrix[j])));

  // Weights per method
  let weights;
  switch (builderState.method) {
    case 'equal_weight':       weights = bldWeightsEqual(bundles.length); break;
    case 'inverse_volatility': weights = bldWeightsInverseVol(stdevs); break;
    case 'score_weighted':     weights = bldWeightsScore(bundles.map(b => b.score || 0)); break;
    case 'risk_parity':
    default:                   weights = bldWeightsRiskParity(stdevs, corr); break;
  }
  // Defensive normalization
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (wsum > 0) weights = weights.map(w => w / wsum);

  const metrics = bldComputeMetrics(weights, bundles, builderState.capital);
  const avgCorr = bldAvgCorrelation(corr);
  const symbolGroups = bldGroupBySymbol(bundles, weights);
  const symHHI = bldHerfindahl(symbolGroups);

  // Header stats
  document.getElementById('bld-stat-net').textContent = fmt.usd(metrics.net, true);
  document.getElementById('bld-stat-net').className = metrics.net >= 0 ? 'positive' : 'negative';
  document.getElementById('bld-stat-dd').textContent = `${fmt.usd(metrics.maxDD)} (${metrics.maxDDPct.toFixed(2)}%)`;
  document.getElementById('bld-stat-calmar').textContent = metrics.calmar != null ? metrics.calmar.toFixed(2) : '—';
  document.getElementById('bld-stat-corr').textContent = avgCorr != null ? avgCorr.toFixed(2) : '—';

  // Equity chart
  document.getElementById('bld-empty').hidden = true;
  document.getElementById('bld-equity-wrap').hidden = false;
  bldRenderEquityChart(metrics);

  // Health card
  bldRenderHealth(avgCorr, symbolGroups, symHHI, metrics);

  // Selected list
  bldRenderSelectedList(bundles, weights, stdevs, corr);
}

function bldRenderEquityChart(metrics) {
  const canvas = document.getElementById('bld-equity-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (builderState.chart) { builderState.chart.destroy(); builderState.chart = null; }
  const data = metrics.dates.map((d, i) => ({ x: d, y: metrics.cum[i] }));
  builderState.chart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Equity portafolio (USD)',
        data,
        borderColor: '#22d3ee',
        backgroundColor: 'rgba(34,211,238,0.18)',
        fill: true,
        tension: 0.18,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 350 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => `Equity: ${fmt.usd(item.parsed.y, true)}`,
          },
        },
      },
      scales: {
        x: { type: 'time', time: { unit: 'month' }, ticks: { color: 'rgba(255,255,255,0.55)' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: 'rgba(255,255,255,0.55)', callback: (v) => fmt.usd(v) }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });
}

function bldRenderHealth(avgCorr, symbolGroups, symHHI, metrics) {
  const el = document.getElementById('bld-health');
  if (!el) return;
  el.hidden = false;
  const corrLevel = avgCorr == null ? 'neutral' : avgCorr < 0.3 ? 'good' : avgCorr < 0.6 ? 'warn' : 'bad';
  const corrLabel = avgCorr == null ? '—' : avgCorr < 0.3 ? 'Diversificado' : avgCorr < 0.6 ? 'Mixto' : 'Redundante';
  const concLevel = symHHI < 0.3 ? 'good' : symHHI < 0.55 ? 'warn' : 'bad';
  const concLabel = symHHI < 0.3 ? 'Diversificado' : symHHI < 0.55 ? 'Concentrado' : 'Muy concentrado';
  const symBars = symbolGroups
    .sort((a, b) => b.weight - a.weight)
    .map(g => `<div class="bld-sym-row"><span class="bld-sym-name">${g.symbol}</span><div class="bld-sym-bar"><span style="width:${(g.weight * 100).toFixed(1)}%"></span></div><span class="bld-sym-pct">${(g.weight * 100).toFixed(1)}%</span></div>`)
    .join('');
  const sharpe = metrics.sharpe != null ? metrics.sharpe.toFixed(2) : '—';
  const sortino = metrics.sortino != null ? metrics.sortino.toFixed(2) : '—';
  const monthsPos = metrics.monthsPosPct != null ? metrics.monthsPosPct.toFixed(0) + '%' : '—';
  el.innerHTML = `
    <div class="bld-health-grid">
      <div class="bld-health-card health-${corrLevel}">
        <div class="bld-health-label">Correlación promedio</div>
        <div class="bld-health-value">${avgCorr != null ? avgCorr.toFixed(2) : '—'}</div>
        <div class="bld-health-hint">${corrLabel} · &lt;0.30 ideal</div>
      </div>
      <div class="bld-health-card health-${concLevel}">
        <div class="bld-health-label">Concentración símbolo</div>
        <div class="bld-health-value">${(symHHI * 100).toFixed(0)} HHI</div>
        <div class="bld-health-hint">${concLabel}</div>
      </div>
      <div class="bld-health-card">
        <div class="bld-health-label">Sharpe anual.</div>
        <div class="bld-health-value">${sharpe}</div>
        <div class="bld-health-hint">Sortino ${sortino}</div>
      </div>
      <div class="bld-health-card">
        <div class="bld-health-label">% meses positivos</div>
        <div class="bld-health-value">${monthsPos}</div>
        <div class="bld-health-hint">Histórico combinado</div>
      </div>
    </div>
    <div class="bld-symbols-block">
      <div class="bld-health-label">Asignación por símbolo</div>
      ${symBars || '<div class="bld-sym-empty">Sin datos</div>'}
    </div>`;
}

function bldRenderSelectedList(bundles, weights, stdevs, corr) {
  const list = document.getElementById('bld-selected-list');
  if (!list) return;
  const cap = builderState.capital;
  const maxW = Math.max(...weights, 0.0001);
  list.innerHTML = bundles.map((b, i) => {
    const w = weights[i];
    const usd = w * cap;
    const widthPct = (w / maxW) * 100;
    return `
      <div class="bld-selected-row bot-row" data-vps="${b.vps}" data-login="${b.login}" data-magic="${b.magic}" style="animation-delay:${i * 50}ms">
        <button class="bld-remove-btn" data-remove="${b.key}" title="Quitar del portafolio" aria-label="Quitar">×</button>
        <div class="bld-sel-id">
          <div class="bld-sel-magic mono">${b.magic}</div>
          <div class="bld-sel-meta">
            ${(b.symbols || []).map(s => s.replace(/\.b$/, '')).join(', ') || '?'} ·
            ${(b.vps || '').toUpperCase()} · cuenta ${b.login}
          </div>
        </div>
        <div class="bld-sel-status">
          ${statusBadge(b.status)}
          <span class="bld-sel-score">${(b.score || 0).toFixed(0)}</span>
        </div>
        <div class="bld-sel-bar-wrap">
          <div class="bld-sel-bar"><span style="width:${widthPct.toFixed(1)}%"></span></div>
          <div class="bld-sel-weight"><strong>${(w * 100).toFixed(2)}%</strong></div>
        </div>
        <div class="bld-sel-usd">
          <strong>$${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
          <span class="bld-sel-usd-meta">σ=${stdevs[i].toFixed(2)}</span>
        </div>
      </div>`;
  }).join('');
}

function bldToggleSelection(key) {
  const idx = builderState.selected.indexOf(key);
  if (idx >= 0) {
    builderState.selected.splice(idx, 1);
  } else {
    if (builderState.selected.length >= BLD_MAX) return;
    builderState.selected.push(key);
  }
  bldRecalc();
}

function wireBuilderModal() {
  const btn = document.getElementById('builder-btn');
  if (btn) btn.addEventListener('click', openBuilderModal);
  const close = document.getElementById('builder-modal-close');
  if (close) close.addEventListener('click', closeBuilderModal);
  const overlay = document.getElementById('builder-modal-overlay');
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target.id === 'builder-modal-overlay') closeBuilderModal(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('builder-modal-overlay').hidden) return;
    if (!document.getElementById('bot-modal-overlay').hidden) return;       // bot audit on top
    if (!document.getElementById('account-modal-overlay').hidden) return;
    closeBuilderModal();
  });

  // Catalog click → toggle selection. Avoid bubbling to audit modal.
  document.getElementById('bld-catalog-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('.builder-cat-item');
    if (!item || item.classList.contains('disabled')) return;
    bldToggleSelection(item.dataset.key);
  });

  // Selected list: × removes, click on row body opens audit (handled by global wireBotModal selector)
  document.getElementById('bld-selected-list')?.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      e.stopPropagation();
      const key = remove.dataset.remove;
      const i = builderState.selected.indexOf(key);
      if (i >= 0) { builderState.selected.splice(i, 1); bldRecalc(); }
    }
  });

  // Clear button
  document.getElementById('bld-clear-btn')?.addEventListener('click', () => {
    builderState.selected = [];
    bldRecalc();
  });

  // Capital pills + custom input
  document.querySelectorAll('#bld-capital-pills .pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#bld-capital-pills .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      builderState.capital = Number(p.dataset.capital);
      const input = document.getElementById('bld-capital-input');
      if (input) input.value = '';
      bldRecalc();
    });
  });
  const capInput = document.getElementById('bld-capital-input');
  if (capInput) {
    capInput.addEventListener('input', () => {
      const v = Number(capInput.value);
      if (!Number.isFinite(v) || v < 1000) return;
      document.querySelectorAll('#bld-capital-pills .pill').forEach(x => x.classList.remove('active'));
      builderState.capital = v;
      bldRecalc();
    });
  }

  // Method pills
  document.querySelectorAll('#bld-method-pills .pill').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#bld-method-pills .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      builderState.method = p.dataset.method;
      bldRecalc();
    });
  });
}

// --- Bot Modal: Risk / Consistency / Decay / Score panels -----------------

function renderRiskPanel(b) {
  const card = (label, val, hint) => `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${val}</div>
      <div class="metric-hint">${hint || ''}</div>
    </div>`;
  const calmarLabel = b.calmar == null ? '—' : b.calmar.toFixed(2);
  const calmarHint = b.calmar != null && b.calmar > 0
    ? `Ganas $${b.calmar.toFixed(2)} por cada $1 que arriesgas en máximo DD`
    : 'Sin DD o no rentable';
  const sortinoHint = b.sortino == null ? '—' : (b.sortino > 1.5 ? 'Excelente — riesgo bajo controlado' : b.sortino > 0.5 ? 'Aceptable' : 'Bajo — alto riesgo en pérdidas');

  // --- Institutional metrics block ---
  const inst = b.institutional || {};
  const interp = inst.interpretation || {};
  const cvarVal = inst.cvar_95_pct != null ? `${inst.cvar_95_pct.toFixed(2)}%` : '—';
  const cvarHint = interp.cvar_95
    ? `${interp.cvar_95} — pérdida promedio en peor 5% días`
    : 'Tail risk diario (% balance)';
  const ulcerVal = inst.ulcer_index_pct != null ? `${inst.ulcer_index_pct.toFixed(2)}%` : '—';
  const ulcerHint = interp.ulcer
    ? `${interp.ulcer} — RMS de DD% (profundidad × duración)`
    : 'Mide agonía: DD prolongado pesa igual que DD profundo';
  const martinVal = inst.martin_ratio != null ? inst.martin_ratio.toFixed(2) : '—';
  const martinHint = inst.martin_ratio != null
    ? (inst.martin_ratio > 50 ? 'Excelente — return anual / Ulcer' : inst.martin_ratio > 10 ? 'Robusto' : 'Marginal')
    : 'Net anualizado / Ulcer Index';
  const kVal = inst.k_ratio != null ? inst.k_ratio.toFixed(2) : '—';
  const kHint = interp.k_ratio
    ? `${interp.k_ratio} — equity curve regularidad`
    : 'K-Ratio Kestner: linealidad de la equity curve';
  const sqnVal = inst.sqn != null ? inst.sqn.toFixed(2) : '—';
  const sqnBandLabels = {
    MALO: '🔴 Malo (<1.6)',
    PROMEDIO: '🟡 Promedio (1.6-2)',
    BUENO: '🟢 Bueno (2-3)',
    EXCELENTE: '🟢 Excelente (3-5)',
    SANTO_GRIAL: '✨ Santo Grial (5-7)',
    SOSPECHOSO_OVERFIT: '⚠️ Sospechoso overfit (>7)',
  };
  const sqnHint = inst.sqn_band ? sqnBandLabels[inst.sqn_band] : 'System Quality Number (Van Tharp)';
  const tailVal = inst.tail_ratio != null ? inst.tail_ratio.toFixed(2) : '—';
  const tailHint = interp.tail_ratio
    ? `${interp.tail_ratio} — P95/|P5| de returns`
    : 'Asimetría de cola — <1 indica "vender opciones"';

  return `
    <div class="metric-grid">
      ${card('Calmar', calmarLabel, calmarHint)}
      ${card('Sortino (anualizado)', b.sortino != null ? b.sortino.toFixed(2) : '—', sortinoHint)}
      ${card('Sharpe (anualizado)', b.sharpe_annualized != null ? b.sharpe_annualized.toFixed(2) : '—', 'Rendimiento por unidad de volatilidad total')}
      ${card('Profit Factor', fmt.pf(b.profit_factor), b.profit_factor && b.profit_factor > 1.5 ? 'Robusto (>1.5)' : 'Marginal o pérdida')}
      ${card('Recovery Factor', b.recovery_factor != null ? b.recovery_factor.toFixed(2) : '—', 'Net / Max DD — capacidad de recuperar')}
      ${card('Max DD %', b.dd_pct_of_balance != null ? `${b.dd_pct_of_balance.toFixed(2)}%` : '—', '% del balance de la cuenta consumido en peor DD')}
    </div>
    ${renderCIBlock(b)}
    <h4 class="panel-title" style="margin-top:24px">🏦 Métricas institucionales (real-money due-diligence)</h4>
    <div class="metric-grid">
      ${card('CVaR 95%', cvarVal, cvarHint)}
      ${card('Ulcer Index', ulcerVal, ulcerHint)}
      ${card('Martin Ratio', martinVal, martinHint)}
      ${card('K-Ratio (Kestner)', kVal, kHint)}
      ${card('SQN (Van Tharp)', sqnVal, sqnHint)}
      ${card('Tail Ratio', tailVal, tailHint)}
    </div>`;
}

function renderCIBlock(b) {
  const ci = b.confidence_intervals;
  if (!ci) return '';
  const items = [
    { key: 'sharpe', label: 'Sharpe', decimals: 2 },
    { key: 'sortino', label: 'Sortino', decimals: 2 },
    { key: 'calmar', label: 'Calmar', decimals: 2 },
    { key: 'profit_factor', label: 'Profit Factor', decimals: 2 },
    { key: 'win_rate_pct', label: 'Win Rate %', decimals: 1, suffix: '%' },
  ];
  const cards = items.map(it => {
    const c = ci[it.key];
    if (!c) return `<div class="ci-card"><div class="ci-label">${it.label}</div><div class="ci-pt">—</div></div>`;
    const stableCls = c.stable ? 'ci-stable' : 'ci-unstable';
    const pt = it.suffix ? `${c.point.toFixed(it.decimals)}${it.suffix}` : c.point.toFixed(it.decimals);
    const lo = it.suffix ? `${c.lo.toFixed(it.decimals)}${it.suffix}` : c.lo.toFixed(it.decimals);
    const hi = it.suffix ? `${c.hi.toFixed(it.decimals)}${it.suffix}` : c.hi.toFixed(it.decimals);
    return `<div class="ci-card ${stableCls}">
      <div class="ci-label">${it.label}</div>
      <div class="ci-pt">${pt}</div>
      <div class="ci-band-wrap">
        <span class="ci-band-fill"></span>
      </div>
      <div class="ci-range">${lo} ↔ ${hi}</div>
    </div>`;
  }).join('');
  const lowConfBanner = ci.low_confidence
    ? `<div class="decay-banner danger">📉 Sample chico (${ci.n_trades} trades · ${ci.n_days} días) — el bootstrap CI es ancho. Métricas no se estabilizan hasta ~50 trades + 4 meses.</div>`
    : `<div class="decay-banner ok">✅ Sample suficiente (${ci.n_trades} trades · ${ci.n_days} días) — bootstrap CI confiable.</div>`;
  return `
    <h4 class="panel-title" style="margin-top:24px">📊 Intervalos de confianza 95% (Bootstrap × ${ci.n_runs.toLocaleString('en-US')})</h4>
    ${lowConfBanner}
    <div class="ci-grid">${cards}</div>
    <p class="events-explainer" style="margin-top:12px">Bootstrap remuestrea los daily returns ${ci.n_runs} veces. Banda <strong>verde estrecha</strong> = métrica estable (skill). Banda <strong>roja ancha</strong> = mucha incertidumbre (puede ser suerte por sample chico).</p>`;
}

function renderConsistencyPanel(b) {
  const card = (label, val, hint) => `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${val}</div>
      <div class="metric-hint">${hint || ''}</div>
    </div>`;
  const monthsPos = b.months_positive ?? 0;
  const monthsActive = b.months_active ?? 0;
  const monthsNeg = monthsActive - monthsPos;
  return `
    <div class="metric-grid">
      ${card('% Meses positivos', b.months_positive_pct != null ? fmt.pct(b.months_positive_pct) : '—', `${monthsPos} / ${monthsActive} meses con net > 0`)}
      ${card('Meses activo', String(monthsActive), b.first_trade ? `desde ${new Date(b.first_trade).toLocaleDateString('es-ES', { month: 'short', year: 'numeric' })}` : '')}
      ${card('σ mensual ($)', b.monthly_net_stdev != null ? fmt.usd(b.monthly_net_stdev) : '—', 'Cuanto menor, más predecible')}
      ${card('Coef. variación', b.monthly_net_cov != null ? b.monthly_net_cov.toFixed(2) : '—', 'σ / |media| — <1 estable, >1 volátil')}
      ${card('Racha mala (meses)', String(b.longest_losing_streak_months ?? 0), 'Meses negativos consecutivos máximo')}
      ${card('DD más largo', `${(b.longest_dd_duration_days ?? 0).toFixed(0)}d`, 'Días bajo el peak histórico')}
    </div>
    <div class="consistency-bars">
      <div class="cbar"><span class="cbar-pos" style="flex:${monthsPos}"></span><span class="cbar-neg" style="flex:${monthsNeg}"></span></div>
      <div class="cbar-legend"><span class="positive">${monthsPos} meses+</span> · <span class="negative">${monthsNeg} meses−</span></div>
    </div>`;
}

function renderDecayPanel(b) {
  const card = (label, val, hint) => `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${val}</div>
      <div class="metric-hint">${hint || ''}</div>
    </div>`;
  const banner = b.decay_flag
    ? `<div class="decay-banner danger">⚠ DECAY DETECTADO — el bot ha perdido tracción reciente. Revisar antes de promover.</div>`
    : `<div class="decay-banner ok">✓ Sin decay detectado — la pendiente reciente sigue alineada con la lifetime.</div>`;
  return `
    ${banner}
    <div class="metric-grid">
      ${card('Net 30d', b.net_30d != null ? fmt.usd(b.net_30d, true) : '—', 'Net cerrado en últimos 30 días')}
      ${card('Net 90d', b.net_90d != null ? fmt.usd(b.net_90d, true) : '—', 'Net cerrado en últimos 90 días')}
      ${card('Slope lifetime', b.slope_lifetime != null ? `$${b.slope_lifetime.toFixed(3)}/d` : '—', 'Pendiente lineal lifetime (USD/día)')}
      ${card('Slope reciente 90d', b.slope_recent_90d != null ? `$${b.slope_recent_90d.toFixed(3)}/d` : '—', 'Pendiente últimos 90 días')}
      ${card('Decay ratio', b.decay_ratio != null ? b.decay_ratio.toFixed(2) : '—', '<0.3 o negativo = degradación severa')}
    </div>`;
}

function renderScorePanel(b) {
  const meta = state.snapshot.promotion_meta || {};
  const weights = meta.weights || {};
  const comps = b.promotion_components || {};
  const labels = {
    calmar: 'Calmar',
    months_positive_pct: '% Meses+',
    sortino: 'Sortino',
    decay: 'Salud (decay)',
    profit_factor: 'Profit Factor',
    age: 'Edad',
    trade_count: 'Trades',
    net_return: 'Dinero (return mens.)',
    oos_robustness: 'Robustez OOS (walk-forward)',
    safety: 'Seguridad (1−prob. negativo)',
    tail_quality: 'Cola/CVaR (riesgo extremo)',
    significance: 'Significancia estadística',
  };
  const rows = Object.keys(weights).map(k => {
    const w = weights[k] || 0;
    const v = comps[k] || 0;
    const contrib = (v * w * 100).toFixed(1);
    return `
      <div class="score-row">
        <div class="score-label">${labels[k] || k}</div>
        <div class="score-bar"><span style="width:${(v * 100).toFixed(0)}%"></span></div>
        <div class="score-value">${(v * 100).toFixed(0)}%</div>
        <div class="score-weight">×${(w * 100).toFixed(0)}%</div>
        <div class="score-contrib">+${contrib}</div>
      </div>`;
  }).join('');
  const gating = b.promotion_gating || {};
  const gatingHtml = Object.entries(gating).map(([k, ok]) => `
    <li class="${ok ? 'gate-ok' : 'gate-fail'}">${ok ? '✅' : '❌'} ${k.replace(/_/g, ' ')}</li>
  `).join('');
  const fails = b.promotion_fails || [];
  const verdict = b.promotion_status === 'READY'
    ? `<div class="score-verdict status-ready"><strong>✅ READY</strong> — listo para evaluar promoción a real</div>`
    : b.promotion_status === 'NEAR'
    ? `<div class="score-verdict status-near"><strong>🟡 NEAR</strong> — cerca pero falta refinar (score ${b.promotion_score.toFixed(1)})</div>`
    : b.promotion_status === 'WATCH'
    ? `<div class="score-verdict status-watch"><strong>👀 WATCH</strong> — observar, score ${b.promotion_score.toFixed(1)}</div>`
    : `<div class="score-verdict status-no"><strong>❌ NO</strong> — no califica${fails.length ? ': ' + fails.join(', ') : ''}</div>`;
  // 🏛️ Ultra Tribunal block — veredicto adversarial + doble firma + tenure.
  const tmModal = tribunalMeta();
  const trib = b.tribunal || null;
  let tribunalBlock = '';
  if (tmModal && (trib || b.double_signature || b.tribunal_history)) {
    const ds = b.double_signature;
    const dsLine = ds === 'confirmed'
      ? (tmModal.verdict_state === 'vigente'
        ? `<div class="score-verdict status-ready"><strong>✓✓ SUBIR</strong> — doble firma: READY (cuantitativo) ∧ podio del tribunal ${tmModal.run_date}. Dos vías independientes coinciden (veto humano final).</div>`
        : `<div class="score-verdict status-watch"><strong>✓✓ con veredicto ${tmModal.verdict_state}</strong> — READY ∧ podio, pero el veredicto tiene ${tmModal.age_days} días. Relanzar el tribunal para re-confirmar.</div>`)
      : ds === 'quant_only'
      ? `<div class="score-verdict status-watch"><strong>✓· solo quant</strong> — READY por score pero sin podio en el tribunal ${tmModal.run_date}: falta la segunda firma adversarial.</div>`
      : ds === 'tribunal_only'
      ? `<div class="score-verdict status-watch"><strong>🏛️ sin READY</strong> — en el podio del tribunal pero hoy no es READY. Divergencia que investigar.</div>`
      : '';
    const podLine = trib && !trib.is_suplente && trib.rank != null
      ? `<p style="margin:8px 0 0">${TRIBUNAL_MEDALS[trib.rank] || '#' + trib.rank} <strong>Rank #${trib.rank}</strong> del podio · composite ${trib.comp != null ? trib.comp.toFixed(1) : '—'}/100 · gate determinístico ${trib.gate || '—'} · validador adversarial ${trib.validator_holds ? 'sostiene el veredicto' : '—'}</p>`
      : trib && trib.is_suplente
      ? `<p style="margin:8px 0 0">🎗 <strong>Suplente</strong> del tribunal · comp ${trib.comp != null ? trib.comp.toFixed(1) : '—'} — ${trib.note || ''}</p>`
      : '';
    const staleLine = trib && (trib.stale_reasons || []).length
      ? `<div class="score-verdict status-no" style="margin-top:8px"><strong>⚠ Veredicto posiblemente obsoleto</strong> — cambio material desde ${trib.run_date}: ${trib.stale_reasons.join(' · ')}</div>`
      : '';
    const h = b.tribunal_history;
    const tenureLine = h
      ? `<p style="margin:8px 0 0">📜 <strong>Tenure:</strong> ${h.consecutive_podiums} podio(s) consecutivo(s) · ${h.podium_appearances} aparición(es) desde ${h.first_podium} · trayectoria ${(h.ranks || []).map(r => `#${r.rank} (${r.run_date})`).join(' → ')}${b.ready_streak_days != null ? ` · ${b.ready_streak_days} día(s) seguidos en READY` : ''}</p>`
      : '';
    const dissents = (trib && trib.dissents || []);
    const dissentsHtml = dissents.length
      ? `<p style="margin:10px 0 4px"><strong>Disensos y riesgos registrados que mencionan a este bot:</strong></p><ul class="gating-list">${dissents.map(d => `<li>⚠ ${d}</li>`).join('')}</ul>`
      : '';
    const recLine = trib && !trib.is_suplente && tmModal.recommendation
      ? `<p style="margin:10px 0 0;color:var(--muted)"><strong>Recomendación del Domain Outsider:</strong> ${tmModal.recommendation}</p>`
      : '';
    tribunalBlock = `
      <h4 class="panel-title" style="margin-top:18px">🏛️ Ultra Tribunal <small style="font-weight:400;color:var(--muted)">(veredicto ${tmModal.run_date} · ${tmModal.verdict_state} · concordancia ${tmModal.concordance.matches}/${tmModal.concordance.of} · visual-only, nunca mueve asientos)</small></h4>
      ${dsLine}${podLine}${staleLine}${tenureLine}${dissentsHtml}${recLine}`;
  }
  // Dominance block — ¿es uno de los caballos? (top-25% en cada eje + no dominado).
  const dom = b.dominance || null;
  let dominanceBlock = '';
  if (dom && dom.axes) {
    const axHtml = Object.values(dom.axes).map(a => {
      const pct = a.pct;
      const cls = pct == null ? '' : pct >= 75 ? 'profit-positive' : pct < 50 ? 'profit-negative' : '';
      return `
        <div class="score-row">
          <div class="score-label">${a.label}</div>
          <div class="score-bar"><span style="width:${pct != null ? Math.round(pct) : 0}%"></span></div>
          <div class="score-value ${cls}">P${pct != null ? Math.round(pct) : '—'}</div>
        </div>`;
    }).join('');
    const verdictDom = dom.is_thoroughbred
      ? `<div class="score-verdict status-ready"><strong>✅ Caballo</strong> — top-25% (≥P75) en los 4 ejes y ningún bot lo supera en todo. Candidato indiscutible.</div>`
      : `<div class="score-verdict status-watch"><strong>⚠ Discutible</strong> — ${dom.dominated_by != null ? `el bot #${dom.dominated_by} lo supera en TODOS los ejes. ` : ''}${!dom.all_ge_p75 ? `No está en el top-25% en: ${Object.values(dom.axes).filter(a => a.pct == null || a.pct < 75).map(a => a.label).join(', ')}.` : ''}</div>`;
    dominanceBlock = `
      <h4 class="panel-title" style="margin-top:18px">🐎 Dominancia <small style="font-weight:400;color:var(--muted)">(percentil vs cohorte elegible)</small></h4>
      ${verdictDom}
      <div class="score-breakdown">${axHtml}</div>`;
  }
  // Shrinkage block — bayesian cohort-adjusted view.
  const shr = b.shrinkage_meta || null;
  const raw = b.promotion_score_raw;
  const shrunk = b.promotion_score_shrunk;
  let shrinkageBlock = '';
  if (shr && raw != null && shrunk != null) {
    const delta = shr.delta || 0;
    const dCls = delta < -2 ? 'profit-negative' : delta > 2 ? 'profit-positive' : '';
    const wPct = ((shr.weight_observed || 0) * 100).toFixed(0);
    const interp = delta < -3
      ? `🔻 El cohort jala el score hacia abajo (${delta.toFixed(1)}). Muestra pequeña → bot probablemente no es tan bueno como aparenta. <strong>Esperar más trades.</strong>`
      : delta > 3
      ? `🔺 El cohort empuja el score hacia arriba (+${delta.toFixed(1)}). Bot atípicamente robusto vs sus pares.`
      : `⚖️ Score robusto: ${shr.cohort_prior_used ? 'cohort' : 'global'} ≈ raw, sin gran ajuste (${delta > 0 ? '+' : ''}${delta.toFixed(1)}).`;
    shrinkageBlock = `
      <div class="shrinkage-block">
        <h4 class="panel-title" style="margin-top:0">🧪 Bayesian Shrinkage <small style="font-weight:400;color:var(--muted)">(cohort: ${shr.cohort_key})</small></h4>
        <div class="shrinkage-grid">
          <div class="shr-card">
            <div class="shr-label">Score raw</div>
            <div class="shr-value">${raw.toFixed(1)}</div>
            <div class="shr-hint">observado</div>
          </div>
          <div class="shr-card shr-card-final">
            <div class="shr-label">Score shrunk</div>
            <div class="shr-value">${shrunk.toFixed(1)}</div>
            <div class="shr-hint ${dCls}">Δ ${delta > 0 ? '+' : ''}${delta.toFixed(1)}</div>
          </div>
          <div class="shr-card">
            <div class="shr-label">Prior</div>
            <div class="shr-value">${(shr.prior_value || 0).toFixed(1)}</div>
            <div class="shr-hint">${shr.cohort_prior_used ? `cohort n=${shr.cohort_n}` : 'global (cohort < 3)'}</div>
          </div>
          <div class="shr-card">
            <div class="shr-label">Confianza</div>
            <div class="shr-value">${wPct}%</div>
            <div class="shr-hint">peso observado · n_eff=${shr.n_eff}</div>
          </div>
        </div>
        <div class="shr-bar">
          <div class="shr-bar-track">
            <div class="shr-bar-prior" style="width:${100 - wPct}%"></div>
            <div class="shr-bar-obs" style="width:${wPct}%"></div>
          </div>
          <div class="shr-bar-legend">
            <span><i class="dot dot-prior"></i> Prior ${100 - wPct}%</span>
            <span><i class="dot dot-obs"></i> Observado ${wPct}%</span>
          </div>
        </div>
        <p class="shr-interp">${interp}</p>
      </div>`;
  }
  return `
    <div class="score-summary">
      <div class="score-big">${(b.promotion_score ?? 0).toFixed(1)}<span class="score-big-suffix">/100</span></div>
      ${verdict}
    </div>
    ${tribunalBlock}
    ${dominanceBlock}
    ${shrinkageBlock}
    <h4 class="panel-title" style="margin-top:18px">Composición del score</h4>
    <div class="score-breakdown">${rows}</div>
    <h4 class="panel-title" style="margin-top:18px">Filtros gating</h4>
    <ul class="gating-list">${gatingHtml}</ul>`;
}

// --- 🚨 DRIFT WATCHDOG PANEL --------------------------------------------
function renderDriftPanel(b) {
  const d = b.drift;
  if (!d) {
    return `<div class="empty-state">⚠️ Sin análisis de drift: el bot tiene menos de 30 días en su daily_equity_series.</div>`;
  }
  if (!d.flag) {
    return `
      <div class="drift-banner ok">
        <strong>✅ SIN DRIFT</strong> · Page-Hinkley no detectó quiebre estructural en ${d.n_days} días de operación.
      </div>
      <div class="metric-grid">
        ${card('λ (umbral)', d.lambda?.toFixed(3) ?? '—', 'PH_LAMBDA_FACTOR × stdev_daily')}
        ${card('σ daily', d.stdev_daily?.toFixed(3) ?? '—', 'Volatilidad de daily_net')}
        ${card('Días analizados', d.n_days ?? '—', '')}
      </div>
      <p class="muted-note">Page-Hinkley = CUSUM secuencial sobre <code>daily_net</code>. Detecta el día exacto del quiebre, no el decay agregado.</p>`;
  }
  const sevCls = d.severity >= 2.0 ? 'profit-negative' : d.severity >= 1.3 ? 'warning' : '';
  const deltaCls = (d.net_delta_per_day ?? 0) < 0 ? 'profit-negative' : 'profit-positive';
  return `
    <div class="drift-banner alert">
      <div>
        <strong>🚨 ${d.interpretation}</strong>
        <div class="drift-banner-sub">Quiebre detectado el <strong>${d.breakpoint_date}</strong> · hace ${d.days_since_break ?? '—'} días</div>
      </div>
      <div class="drift-banner-sev ${sevCls}">
        <div class="drift-sev-num">${(d.severity || 0).toFixed(2)}×</div>
        <div class="drift-sev-label">severidad (excursión / λ)</div>
      </div>
    </div>
    <div class="metric-grid">
      ${card('Net/día antes', `$${(d.net_before_per_day ?? 0).toFixed(2)}`, `${d.days_before} días pre-quiebre`)}
      ${card('Net/día después', `$${(d.net_after_per_day ?? 0).toFixed(2)}`, `${d.days_after} días post-quiebre`)}
      ${card('Δ Net/día', `<span class="${deltaCls}">${(d.net_delta_per_day ?? 0) > 0 ? '+' : ''}$${(d.net_delta_per_day ?? 0).toFixed(2)}</span>`, 'cambio diario tras el quiebre')}
      ${card('λ (umbral)', (d.lambda ?? 0).toFixed(3), 'PH_LAMBDA_FACTOR × σ')}
      ${card('σ daily', (d.stdev_daily ?? 0).toFixed(3), 'Volatilidad de daily_net')}
      ${card('Días totales', d.n_days ?? '—', 'serie diaria evaluada')}
    </div>
    <p class="muted-note">El bot mostró un cambio sostenido en su rentabilidad diaria. ${d.severity >= 2.0 ? '<strong>Considerar pausar candidatura a real.</strong>' : 'Vigilar las próximas semanas.'}</p>`;
}

// --- ⚙️ CAPACITY PANEL ---------------------------------------------------
function renderCapacityPanel(b) {
  const c = b.capacity;
  if (!c) {
    return `<div class="empty-state">⚠️ Sin estimación de capacidad: faltan trades para inferir cadencia y volumen.</div>`;
  }
  const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const verdictCls = c.verdict.startsWith('🟢') ? 'positive'
    : c.verdict.startsWith('🟡') ? 'warning'
    : c.verdict.startsWith('🟠') ? 'warning'
    : 'profit-negative';
  const realBlock = b.real_vs_demo ? `
    <div class="capacity-real-block">
      <h4 class="panel-title" style="margin-top:18px">💰 Bot operando en cuenta REAL</h4>
      <div class="metric-grid">
        ${card('Net real', usd(b.real_vs_demo.real_net_profit), 'PnL acumulado en cuenta real')}
        ${card('Trades real', b.real_vs_demo.real_trades ?? '—', 'Operaciones cerradas')}
        ${card('WR real', `${(b.real_vs_demo.real_wr ?? 0).toFixed(1)}%`, 'Win rate observado en real')}
        ${card('PF real', (b.real_vs_demo.real_pf ?? 0).toFixed(2), 'Profit factor en real')}
      </div>
      <p class="muted-note">${b.real_vs_demo.note}</p>
    </div>` : '';
  return `
    <div class="capacity-hero">
      <div class="cap-hero-main">
        <div class="cap-hero-label">Capacidad estimada</div>
        <div class="cap-hero-value">${usd(c.capacity_usd)}</div>
        <div class="cap-hero-band">Banda: ${usd(c.capacity_usd_low)} – ${usd(c.capacity_usd_high)}</div>
      </div>
      <div class="cap-hero-verdict ${verdictCls}">${c.verdict}</div>
    </div>
    <div class="metric-grid">
      ${card('Tier liquidez', `${c.tier} · ${c.tier_label}`, '1=majors · 2=minors · 3=exotics/metales')}
      ${card('Trades / día', (c.trades_per_day ?? 0).toFixed(2), 'Cadencia operativa')}
      ${card('Duración media', `${(c.avg_duration_hours ?? 0).toFixed(1)}h`, 'Holding time promedio')}
      ${card('Volumen medio', `${(c.avg_volume_lots ?? 0).toFixed(3)} lots`, 'Tamaño típico de posición')}
    </div>
    <h4 class="panel-title" style="margin-top:18px">Factores aplicados</h4>
    <div class="cap-factors">
      <div class="cap-factor"><span class="cap-factor-label">Liquidez (tier)</span><span class="cap-factor-bar"><span style="width:${(c.liquidity_factor || 0) * 100}%"></span></span><span class="cap-factor-val">${((c.liquidity_factor || 0) * 100).toFixed(0)}%</span></div>
      <div class="cap-factor"><span class="cap-factor-label">Pace (cadencia)</span><span class="cap-factor-bar"><span style="width:${(c.pace_factor || 0) * 100}%"></span></span><span class="cap-factor-val">${((c.pace_factor || 0) * 100).toFixed(0)}%</span></div>
      <div class="cap-factor"><span class="cap-factor-label">Position (volumen)</span><span class="cap-factor-bar"><span style="width:${(c.position_factor || 0) * 100}%"></span></span><span class="cap-factor-val">${((c.position_factor || 0) * 100).toFixed(0)}%</span></div>
    </div>
    <p class="muted-note">Estimación heurística: <code>base_tier × liquidity × pace × position</code>. Scalpers en exotics → cap baja; swing en majors → cap alta. Validar contra slippage real al promover.</p>
    ${realBlock}`;
}

function card(label, value, hint) {
  return `<div class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div>${hint ? `<div class="metric-hint">${hint}</div>` : ''}</div>`;
}

// --- 🎲 STRESS TEST PANEL -----------------------------------------------
function renderStressPanel(b) {
  const s = b.stress;
  if (!s) {
    return `<div class="empty-state">⚠️ Sin Monte Carlo: el bot tiene menos de 30 trades cerrados (mínimo necesario para bootstrap estadísticamente válido).</div>`;
  }
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const usd = (v) => fmt.usd(v, true);
  const ddBalanceVerdict = s.dd_pct_balance_p95 == null ? 'sin balance ref.'
    : s.dd_pct_balance_p95 < 5 ? '✅ MUY SEGURO'
    : s.dd_pct_balance_p95 < 15 ? '🟡 ACEPTABLE'
    : s.dd_pct_balance_p95 < 30 ? '⚠️ ELEVADO'
    : '🔴 PELIGROSO';
  const ruinVerdict = s.prob_ruin == null ? '—'
    : s.prob_ruin < 0.01 ? '✅ < 1%'
    : s.prob_ruin < 0.05 ? '🟡 ' + pct(s.prob_ruin)
    : '🔴 ' + pct(s.prob_ruin);
  return `
    <div class="stress-hero">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">🎲 Monte Carlo · ${s.runs.toLocaleString('en-US')} simulaciones · ${s.horizon_trades} trades por corrida</div>
        <div class="stress-hero-grid">
          <div class="stress-big">
            <div class="stress-big-label">Max DD esperado P95</div>
            <div class="stress-big-value negative">${fmt.usd(s.dd_p95)}</div>
            <div class="stress-big-hint">${s.dd_pct_balance_p95 != null ? s.dd_pct_balance_p95.toFixed(2) + '% del balance · ' + ddBalanceVerdict : ddBalanceVerdict}</div>
          </div>
          <div class="stress-big">
            <div class="stress-big-label">Prob. de ruina (DD ≥ 50% balance)</div>
            <div class="stress-big-value">${ruinVerdict}</div>
            <div class="stress-big-hint">Probabilidad de perder la mitad del capital en cualquier corrida</div>
          </div>
          <div class="stress-big">
            <div class="stress-big-label">Net P50 (mediano)</div>
            <div class="stress-big-value ${s.net_p50 >= 0 ? 'positive' : 'negative'}">${usd(s.net_p50)}</div>
            <div class="stress-big-hint">Banda P25–P75: ${usd(s.net_p25)} → ${usd(s.net_p75)}</div>
          </div>
        </div>
      </div>
    </div>
    <h4 class="panel-title">Distribución de Max Drawdown bootstrapped</h4>
    <div class="stress-dd-grid">
      <div class="stress-dd-card"><span>P50 (mediano)</span><strong>${fmt.usd(s.dd_p50)}</strong></div>
      <div class="stress-dd-card stress-warn"><span>P95 (1 de 20)</span><strong>${fmt.usd(s.dd_p95)}</strong></div>
      <div class="stress-dd-card stress-crit"><span>P99 (1 de 100)</span><strong>${fmt.usd(s.dd_p99)}</strong></div>
      <div class="stress-dd-card"><span>Histórico observado</span><strong>${fmt.usd(s.observed_max_dd || 0)}</strong></div>
    </div>
    <h4 class="panel-title">Riesgo de cierre negativo</h4>
    <div class="stress-bar-wrap">
      <div class="stress-bar">
        <span class="stress-bar-fill" style="width:${(s.prob_negative * 100).toFixed(1)}%"></span>
      </div>
      <div class="stress-bar-label">
        <strong>${pct(s.prob_negative)}</strong> de las corridas terminaron con net &lt; 0
        <span class="stress-bar-verdict">${s.prob_negative < 0.05 ? '✅ Casi imposible perder' : s.prob_negative < 0.20 ? '🟡 Riesgo moderado' : '🔴 Riesgo alto'}</span>
      </div>
    </div>
  `;
}

// --- 🔬 OOS / WALK-FORWARD PANEL ----------------------------------------
function renderOOSPanel(b) {
  const o = b.oos;
  if (!o) {
    return `<div class="empty-state">⚠️ Sin Walk-Forward: el bot tiene menos de 40 trades cerrados (mínimo para 2 folds train/test).</div>`;
  }
  const decayBadge = o.sharpe_decay >= 0.7 ? '✅ ESTABLE'
    : o.sharpe_decay >= 0.4 ? '🟡 LEVE EROSIÓN'
    : '🔴 OVERFITTING';
  const sigBadge = o.is_significant ? '✅ SIGNIFICATIVO' : '⚠️ NO DISTINGUIBLE DE RUIDO';
  const pctTest = o.pct_folds_test_profitable;
  const foldsHtml = o.folds.map(f => {
    const cls = f.test_profitable ? 'oos-fold-pos' : 'oos-fold-neg';
    return `
      <div class="oos-fold ${cls}">
        <div class="oos-fold-k">Fold ${f.k}</div>
        <div class="oos-fold-row"><span>Train n=${f.train_n}</span><strong>${f.sharpe_train.toFixed(2)}</strong></div>
        <div class="oos-fold-row"><span>Test n=${f.test_n}</span><strong>${f.sharpe_test.toFixed(2)}</strong></div>
        <div class="oos-fold-row"><span>Net test</span><strong class="${f.test_profitable ? 'positive' : 'negative'}">${fmt.usd(f.test_net, true)}</strong></div>
      </div>`;
  }).join('');
  return `
    <div class="oos-hero">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">🔬 Walk-Forward Validation · ${o.n_folds} folds rolling · ${o.fold_size} trades por fold</div>
        <div class="stress-hero-grid">
          <div class="stress-big">
            <div class="stress-big-label">OOS Sharpe Decay</div>
            <div class="stress-big-value">${o.sharpe_decay.toFixed(2)}</div>
            <div class="stress-big-hint">${decayBadge} · Sharpe Test/Train</div>
          </div>
          <div class="stress-big">
            <div class="stress-big-label">% Folds con Test+ </div>
            <div class="stress-big-value ${pctTest >= 70 ? 'positive' : pctTest >= 50 ? '' : 'negative'}">${pctTest.toFixed(0)}%</div>
            <div class="stress-big-hint">${o.folds.filter(f=>f.test_profitable).length} de ${o.folds.length} folds rentables fuera de muestra</div>
          </div>
          <div class="stress-big">
            <div class="stress-big-label">P-value (permutation)</div>
            <div class="stress-big-value">${o.permutation_p_value.toFixed(4)}</div>
            <div class="stress-big-hint">${sigBadge} · ${o.is_significant ? 'p < 0.05 → edge real' : 'p ≥ 0.05 → indistinguible de azar'}</div>
          </div>
        </div>
      </div>
    </div>
    <h4 class="panel-title">Folds rolling — entrena en pasado, valida en futuro</h4>
    <div class="oos-folds-grid">${foldsHtml}</div>
    <div class="oos-summary">
      <div class="oos-summary-row"><span>Sharpe avg train</span><strong>${o.avg_sharpe_train.toFixed(3)}</strong></div>
      <div class="oos-summary-row"><span>Sharpe avg test</span><strong class="${o.avg_sharpe_test > 0 ? 'positive' : 'negative'}">${o.avg_sharpe_test.toFixed(3)}</strong></div>
      <div class="oos-summary-row"><span>OOS Score (combinado)</span><strong>${(o.oos_score * 100).toFixed(0)}/100</strong></div>
    </div>
  `;
}

// --- 🌊 REGIME / TEMPORAL ROBUSTNESS PANEL -------------------------------
function renderRegimePanel(b) {
  const r = b.regime;
  if (!r) return `<div class="empty-state">⚠️ Sin análisis de régimen: el bot tiene menos de 20 trades.</div>`;
  const dows = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  const maxNetDow = Math.max(...Object.values(r.by_day_of_week).map(v => Math.abs(v.net)), 1);
  const dowHtml = dows.map((d, i) => {
    const v = r.by_day_of_week[i] || { net: 0, trades: 0, win_rate_pct: 0 };
    const pct = (Math.abs(v.net) / maxNetDow) * 100;
    const cls = v.net >= 0 ? 'reg-pos' : 'reg-neg';
    return `
      <div class="regime-bar-row">
        <div class="regime-bar-label">${d}</div>
        <div class="regime-bar-track"><span class="regime-bar-fill ${cls}" style="width:${pct.toFixed(1)}%"></span></div>
        <div class="regime-bar-stats">
          <span class="${v.net >= 0 ? 'positive' : 'negative'}">${fmt.usd(v.net, true)}</span>
          <span class="regime-bar-meta">${v.trades}t · ${v.win_rate_pct}% WR</span>
        </div>
      </div>`;
  }).join('');
  const maxNetHour = Math.max(...Object.values(r.by_hour_utc).map(v => Math.abs(v.net)), 1);
  const hourHtml = Array.from({ length: 24 }, (_, h) => {
    const v = r.by_hour_utc[h] || { net: 0, trades: 0 };
    const intensity = Math.abs(v.net) / maxNetHour;
    const cls = v.net >= 0 ? 'reg-hour-pos' : 'reg-hour-neg';
    return `<div class="regime-hour-cell ${cls}" style="opacity:${0.25 + intensity * 0.75}" title="${String(h).padStart(2,'0')}:00 UTC · ${v.trades} trades · ${fmt.usd(v.net, true)}">${String(h).padStart(2,'0')}</div>`;
  }).join('');
  const durHtml = Object.entries(r.by_duration).map(([label, v]) => {
    return `
      <div class="regime-dur-card ${v.net >= 0 ? 'pos' : 'neg'}">
        <div class="regime-dur-label">${label}</div>
        <div class="regime-dur-net ${v.net >= 0 ? 'positive' : 'negative'}">${fmt.usd(v.net, true)}</div>
        <div class="regime-dur-meta">${v.trades} trades · ${v.win_rate_pct}% WR</div>
      </div>`;
  }).join('');
  const robClass = r.robustness_score >= 0.7 ? 'positive' : r.robustness_score >= 0.5 ? '' : 'negative';
  return `
    <div class="regime-hero">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">🌊 Robustez temporal · sin OHLC externo · solo close_time + duration</div>
        <div class="regime-overall">
          <div class="regime-overall-score ${robClass}">${(r.robustness_score * 100).toFixed(0)}<span class="regime-overall-suffix">/100</span></div>
          <div class="regime-overall-verdict">${r.interpretation}</div>
          <div class="regime-overall-hint">Herfindahl menor = PnL más distribuido en el tiempo. Bot fragil si todo el net viene de una hora/día específico.</div>
        </div>
      </div>
    </div>
    <h4 class="panel-title">PnL por día de la semana (UTC)</h4>
    <div class="regime-bars">${dowHtml}</div>
    <div class="regime-herf-row"><span>Herfindahl DoW: <strong>${r.herfindahl_dow ?? '—'}</strong></span><span>Herfindahl Hora: <strong>${r.herfindahl_hour ?? '—'}</strong></span><span>Herfindahl Duración: <strong>${r.herfindahl_duration ?? '—'}</strong></span></div>
    ${(() => {
      const inst = b.institutional || {};
      const ac = inst.return_autocorr_lag1;
      if (ac == null) return '';
      const acInt = (inst.interpretation || {}).autocorr || '';
      const acCls = Math.abs(ac) < 0.15 ? 'positive' : ac > 0.3 ? 'negative' : '';
      return `<div class="regime-autocorr"><span>📊 Autocorrelación lag-1: <strong class="${acCls}">${ac.toFixed(3)}</strong></span><span class="regime-autocorr-int">${acInt}</span><span class="regime-autocorr-hint">>0.3 invalida los Monte Carlo (asumen IID); el DD real será mayor que el simulado.</span></div>`;
    })()}
    <h4 class="panel-title">Mapa de calor por hora UTC</h4>
    <div class="regime-hours-grid">${hourHtml}</div>
    <h4 class="panel-title">PnL por duración del trade</h4>
    <div class="regime-dur-grid">${durHtml}</div>
  `;
}

// --- 🚀 FORWARD TRACKER PANEL --------------------------------------------
function renderTrackerPanel(b) {
  const t = b.tracker;
  if (!t) return `<div class="empty-state">⚠️ Tracker no disponible: este bot no está en READY/NEAR (solo se trackean candidatos serios).</div>`;
  const verdictMap = {
    ABOVE: { cls: 'verdict-above', label: '✅ POR ENCIMA', hint: 'El bot supera la banda P75 esperada — performance real mejor que el modelo proyectó' },
    ON_TRACK: { cls: 'verdict-ontrack', label: '🟡 EN BANDA', hint: 'El bot está dentro de la banda P25–P75 esperada — modelo calibrado correctamente' },
    BELOW: { cls: 'verdict-below', label: '🔴 BAJO P25', hint: 'El bot está por debajo del 25% inferior esperado — revisar si el scoring está sobreestimando' },
    TOO_SOON: { cls: 'verdict-soon', label: '⏳ MUY PRONTO', hint: 'Menos de 7 días desde candidatura — datos insuficientes' },
  };
  const v = verdictMap[t.verdict] || { cls: '', label: '⏳ ESPERANDO DATOS', hint: 'Primer registro en el tracker — vuelve mañana para ver evolución' };
  const expectedRange = (t.expected_p25 != null && t.expected_p75 != null)
    ? `${fmt.usd(t.expected_p25, true)} → ${fmt.usd(t.expected_p75, true)}`
    : '—';
  return `
    <div class="tracker-hero ${v.cls}">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">🚀 Forward Tracker · since ${t.first_seen_date} · ${t.history_points} snapshots</div>
        <div class="tracker-verdict-big">${v.label}</div>
        <div class="tracker-verdict-hint">${v.hint}</div>
      </div>
    </div>
    <div class="metric-grid">
      <div class="metric-card">
        <div class="metric-label">Días desde candidatura</div>
        <div class="metric-value">${t.days_since_first_seen}</div>
        <div class="metric-hint">Estado inicial: ${t.first_seen_status}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Net real desde entonces</div>
        <div class="metric-value ${t.net_since_first_seen >= 0 ? 'positive' : 'negative'}">${fmt.usd(t.net_since_first_seen, true)}</div>
        <div class="metric-hint">Diferencia entre net hoy y net al entrar al tracker</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Rango esperado (banda MC)</div>
        <div class="metric-value" style="font-size:1.1rem">${expectedRange}</div>
        <div class="metric-hint">Banda P25–P75 escalada al periodo transcurrido</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Snapshots acumulados</div>
        <div class="metric-value">${t.history_points}</div>
        <div class="metric-hint">Cada ejecución de post_merge añade uno (si sigue READY/NEAR)</div>
      </div>
    </div>
    <p class="tracker-explainer">El tracker valida si el <strong>Promotion Score</strong> está calibrado: si la mayoría de READY/NEAR caen sistemáticamente bajo P25, el modelo sobreestima. Sirve para falsear nuestro propio scoring antes de poner capital real.</p>
  `;
}

function findBotInSnapshot(login, magic) {
  return (state.snapshot?.bots || []).find(b =>
    String(b.account_login) === String(login) && String(b.magic) === String(magic)
  );
}

function showAnalysisPanel(html) {
  const panel = document.getElementById('bot-analysis-panel');
  const canvas = document.getElementById('bot-main-chart');
  if (!panel || !canvas) return;
  panel.innerHTML = html;
  panel.hidden = false;
  canvas.style.display = 'none';
}

function hideAnalysisPanel() {
  const panel = document.getElementById('bot-analysis-panel');
  const canvas = document.getElementById('bot-main-chart');
  if (panel) panel.hidden = true;
  if (canvas) canvas.style.display = '';
}

// --- Correlation Modal ---------------------------------------------------

async function loadCorrelations() {
  try {
    const res = await fetch(`data/correlations.json?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function openCorrModal() {
  const overlay = document.getElementById('corr-modal-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!state.correlations) state.correlations = await loadCorrelations();
  renderHeatmap();
}

function closeCorrModal() {
  const overlay = document.getElementById('corr-modal-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  if (document.getElementById('bot-modal-overlay').hidden && document.getElementById('account-modal-overlay').hidden) {
    document.body.style.overflow = '';
  }
}

// Color scale: -1 (blue) → 0 (green) → +1 (red), interpolating through accent stops.
function corrColor(c) {
  if (c == null) return 'rgba(40, 44, 60, 0.4)';
  // Clamp
  const v = Math.max(-1, Math.min(1, c));
  // Use HSL interpolation: blue 220 → green 150 → amber 40 → red 350
  let h, s, l, a;
  if (v <= 0) {
    // -1..0 : blue → green
    const t = v + 1; // 0..1
    h = 220 - t * 70;     // 220 → 150
    s = 70;
    l = 55 - Math.abs(v) * 8;
    a = 0.55 + Math.abs(v) * 0.35;
  } else {
    // 0..1 : green → amber → red
    if (v < 0.4) {
      const t = v / 0.4;
      h = 150 - t * 110;  // 150 → 40
      s = 70 + t * 10;
      l = 55 - t * 5;
      a = 0.55 + t * 0.20;
    } else {
      const t = (v - 0.4) / 0.6;
      h = 40 - t * 50;    // 40 → -10 (~350)
      s = 80;
      l = 50 + t * 5;
      a = 0.75 + t * 0.20;
    }
  }
  if (h < 0) h += 360;
  return `hsla(${h.toFixed(0)}, ${s}%, ${l}%, ${a.toFixed(2)})`;
}

function corrBucket(c) {
  if (c == null) return null;
  if (c > 0.7) return 'red';
  if (c > 0.4) return 'orange';
  if (c >= -0.1) return 'green';
  if (c >= -0.4) return 'green';
  return 'blue';
}

function renderHeatmap() {
  const wrap = document.getElementById('corr-heatmap');
  const data = state.correlations;
  if (!data || !data.matrix) {
    wrap.innerHTML = `<div class="empty-state">No hay datos de correlación todavía. Corre el mirror.</div>`;
    return;
  }
  const meta = data.bots || {};
  const keys = Object.keys(data.matrix);
  keys.sort((a, b) => (meta[b]?.promotion_score || 0) - (meta[a]?.promotion_score || 0));
  const N = keys.length;

  // Dynamic cell sizing: fill the available canvas width.
  const wrapper = document.querySelector('.corr-canvas-wrap');
  const ROW_HEAD_W = 150;
  const PADDING = 36; // left + right padding
  const avail = Math.max(400, (wrapper?.clientWidth || 1200) - ROW_HEAD_W - PADDING);
  const cell = Math.max(10, Math.min(34, Math.floor(avail / N)));

  // Stats
  let pairCount = 0, redCount = 0, greenCount = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const v = data.matrix[keys[i]][keys[j]];
      if (v == null) continue;
      pairCount++;
      if (v > 0.7) redCount++;
      else if (v >= -0.1 && v <= 0.4) greenCount++;
    }
  }
  document.getElementById('corr-stat-bots').textContent = N;
  document.getElementById('corr-stat-pairs').textContent = pairCount;
  document.getElementById('corr-stat-red').textContent = redCount;
  document.getElementById('corr-stat-green').textContent = greenCount;

  let html = '';
  // Corner
  html += `<div class="corr-corner" style="grid-row:1; grid-column:1">Magic ↓ / Magic →</div>`;
  // Column headers
  for (let j = 0; j < N; j++) {
    const m = meta[keys[j]] || {};
    html += `<div class="corr-colhead" data-key="${keys[j]}" data-axis="col" data-idx="${j}" style="grid-row:1; grid-column:${j + 2}" title="${keys[j]}">${m.magic || keys[j]}</div>`;
  }
  // Rows
  for (let i = 0; i < N; i++) {
    const ki = keys[i];
    const m = meta[ki] || {};
    html += `<div class="corr-rowhead" data-key="${ki}" data-axis="row" data-idx="${i}" style="grid-row:${i + 2}; grid-column:1" title="${ki} · ${(m.symbols||[]).join(',')} · Score ${m.promotion_score}">
      <span class="corr-magic">${m.magic}</span>
      <span class="corr-score-pill">${(m.promotion_score || 0).toFixed(0)}</span>
    </div>`;
    for (let j = 0; j < N; j++) {
      const kj = keys[j];
      const v = data.matrix[ki][kj];
      const bg = corrColor(v);
      const text = v == null ? '' : (Math.abs(v) >= 0.5 || i === j ? v.toFixed(2) : '');
      const delay = Math.min(800, (i + j) * 4);
      html += `<div class="corr-cell" data-i="${ki}" data-j="${kj}" data-row="${i}" data-col="${j}" data-c="${v == null ? '' : v}" style="grid-row:${i + 2}; grid-column:${j + 2}; background:${bg}; animation-delay:${delay}ms">${text ? `<span style="font-size:${Math.max(7, cell * 0.4)}px;color:rgba(255,255,255,0.92);font-family:JetBrains Mono,monospace">${text}</span>` : ''}</div>`;
    }
  }

  wrap.style.setProperty('--n', N);
  wrap.style.setProperty('--cell', `${cell}px`);
  wrap.innerHTML = html;
}

function showCorrDetail(ki, kj, c) {
  const floating = document.getElementById('corr-floating');
  const content = document.getElementById('corr-side-content');
  const data = state.correlations;
  const meta = data?.bots || {};
  const a = meta[ki] || {};
  const b = meta[kj] || {};
  let bucket, title, text;
  if (c == null) {
    bucket = 'green'; title = 'Sin datos'; text = 'No hay suficientes días superpuestos para calcular correlación.';
  } else if (c > 0.7) {
    bucket = 'red'; title = '⚠ Redundantes';
    text = `Estos bots se mueven casi idéntico. Promover ambos a real <strong>duplica exposure</strong> sin diversificar. Quédate con el de mayor score (Magic ${(a.promotion_score >= b.promotion_score ? a.magic : b.magic)}).`;
  } else if (c > 0.4) {
    bucket = 'orange'; title = 'Correlación moderada';
    text = `Comparten parte del riesgo. <strong>Diversificación parcial</strong> — útil si vienen de pares o estrategias distintas, redundante si no.`;
  } else if (c >= -0.1) {
    bucket = 'green'; title = '✅ Diversificados';
    text = `Comportamiento <strong>independiente</strong>. Excelentes candidatos para portfolio real conjunto: cuando uno pierde el otro no necesariamente lo sigue.`;
  } else if (c >= -0.4) {
    bucket = 'green'; title = '✅ Diversificados';
    text = `Bots con cierta independencia y leve cobertura. Buenos para reducir varianza del portfolio en real.`;
  } else {
    bucket = 'blue'; title = '🛡 Anti-correlacionados';
    text = `Cuando uno gana, el otro suele perder. <strong>Excelente cobertura</strong> — promovidos juntos a real reducen drawdown del portfolio agregado.`;
  }

  const cls = `is-${bucket}`;
  const cv = c == null ? '—' : (c > 0 ? '+' : '') + c.toFixed(3);
  content.innerHTML = `
    <div class="corr-correlation-display">
      <div class="corr-correlation-num ${cls}">${cv}</div>
      <div class="corr-correlation-label">Correlación Pearson</div>
    </div>
    <div class="corr-pair-cards">
      <div class="corr-bot-card">
        <span class="corr-bot-card-vps">${(a.vps || '').toUpperCase()}</span>
        <div>
          <div class="corr-bot-card-magic">Magic ${a.magic}</div>
          <div class="corr-bot-card-meta">${(a.symbols||[]).join(', ')} · #${a.login} · Net ${fmt.usd(a.net_profit||0, true)} · ${a.trades || 0}t</div>
        </div>
        <span class="corr-bot-card-score">${(a.promotion_score||0).toFixed(0)}</span>
      </div>
      <div class="corr-vs-icon">⇋</div>
      <div class="corr-bot-card">
        <span class="corr-bot-card-vps">${(b.vps || '').toUpperCase()}</span>
        <div>
          <div class="corr-bot-card-magic">Magic ${b.magic}</div>
          <div class="corr-bot-card-meta">${(b.symbols||[]).join(', ')} · #${b.login} · Net ${fmt.usd(b.net_profit||0, true)} · ${b.trades || 0}t</div>
        </div>
        <span class="corr-bot-card-score">${(b.promotion_score||0).toFixed(0)}</span>
      </div>
    </div>
    <div class="corr-verdict ${cls}">
      <div class="corr-verdict-title">${title}</div>
      <div>${text}</div>
    </div>`;
  // Re-trigger entry animation each time
  if (floating) {
    floating.hidden = false;
    floating.style.animation = 'none';
    void floating.offsetWidth;
    floating.style.animation = '';
  }

  // Highlight the cell + ripple
  document.querySelectorAll('#corr-heatmap .corr-cell.is-selected').forEach(el => el.classList.remove('is-selected'));
  const sel = document.querySelector(`#corr-heatmap .corr-cell[data-i="${ki}"][data-j="${kj}"]`);
  if (sel) {
    sel.classList.add('is-selected', 'is-rippling');
    setTimeout(() => sel.classList.remove('is-rippling'), 800);
  }
}

function closeCorrFloating() {
  const f = document.getElementById('corr-floating');
  if (f) f.hidden = true;
  document.querySelectorAll('#corr-heatmap .corr-cell.is-selected').forEach(el => el.classList.remove('is-selected'));
}

// --- Event wiring --------------------------------------------------------

function wireEvents() {
  document.getElementById('refresh-btn').addEventListener('click', loadSnapshot);

  // Debounce the ranking search so we don't re-render 248 rows on every keystroke
  // (the tribunal's pragmatic alternative to row virtualization — same perceived
  // win at 248 rows, zero structural risk; the perf chip will flag if true
  // virtualization is ever needed).
  let _searchT = null;
  document.getElementById('search-input').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(_searchT);
    _searchT = setTimeout(applyFilterAndRender, 150);
  });

  // Only wire the status filter pills here; VPS pills are wired in renderVpsPills().
  document.querySelectorAll('#filter-pills .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#filter-pills .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.filter = pill.dataset.filter;
      applyFilterAndRender();
    });
  });

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort.key = key; state.sort.dir = ['rank', 'magic', 'vps', 'account_login', 'symbols'].includes(key) ? 'asc' : 'desc'; }
      applyFilterAndRender();
    });
  });

  setInterval(() => {
    if (state.snapshot) setFreshness(state.snapshot.oldest_source_generated_at || state.snapshot.generated_at);
  }, 30000);
}

function wireCandidatesControls() {
  document.querySelectorAll('#candidates-status-pills .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#candidates-status-pills .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.candidatesStatusFilter = pill.dataset.status;
      try { renderCandidates(); } catch(err) { console.error(err); }
    });
  });
}

function clearAxisHighlight() {
  document.querySelectorAll('#corr-heatmap .is-axis-active, #corr-heatmap .is-row-active, #corr-heatmap .is-col-active')
    .forEach(el => el.classList.remove('is-axis-active', 'is-row-active', 'is-col-active'));
  hideCorrTooltip();
}
function highlightAxis(row, col) {
  clearAxisHighlight();
  const wrap = document.getElementById('corr-heatmap');
  if (!wrap) return;
  const rh = wrap.querySelector(`.corr-rowhead[data-idx="${row}"]`);
  const ch = wrap.querySelector(`.corr-colhead[data-idx="${col}"]`);
  if (rh) rh.classList.add('is-axis-active');
  if (ch) ch.classList.add('is-axis-active');
  wrap.querySelectorAll(`.corr-cell[data-row="${row}"]`).forEach(el => el.classList.add('is-row-active'));
  wrap.querySelectorAll(`.corr-cell[data-col="${col}"]`).forEach(el => el.classList.add('is-col-active'));
}
function showCorrTooltip(cell, evt) {
  let tip = document.getElementById('corr-cell-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'corr-cell-tooltip';
    tip.className = 'corr-cell-tooltip';
    document.body.appendChild(tip);
  }
  const meta = state.correlations?.bots || {};
  const a = meta[cell.dataset.i] || {};
  const b = meta[cell.dataset.j] || {};
  const c = cell.dataset.c === '' ? null : Number(cell.dataset.c);
  tip.innerHTML = `<strong>${a.magic || cell.dataset.i}</strong> ↔ <strong>${b.magic || cell.dataset.j}</strong><br>r = ${c == null ? '—' : (c > 0 ? '+' : '') + c.toFixed(3)}`;
  const r = cell.getBoundingClientRect();
  tip.style.left = (r.left + r.width / 2) + 'px';
  tip.style.top  = (r.top) + 'px';
  tip.style.display = 'block';
}
function hideCorrTooltip() {
  const tip = document.getElementById('corr-cell-tooltip');
  if (tip) tip.style.display = 'none';
}

function wireCorrModal() {
  const btn = document.getElementById('corr-btn');
  if (btn) btn.addEventListener('click', openCorrModal);
  const closeBtn = document.getElementById('corr-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeCorrModal);
  const floatClose = document.getElementById('corr-floating-close');
  if (floatClose) floatClose.addEventListener('click', closeCorrFloating);
  const overlay = document.getElementById('corr-modal-overlay');
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target.id === 'corr-modal-overlay') closeCorrModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('corr-modal-overlay').hidden &&
        document.getElementById('bot-modal-overlay').hidden && document.getElementById('account-modal-overlay').hidden) {
      closeCorrModal();
    }
  });

  // Click delegation
  document.body.addEventListener('click', (e) => {
    const cell = e.target.closest('#corr-heatmap .corr-cell');
    if (!cell) return;
    const { i, j } = cell.dataset;
    const c = cell.dataset.c === '' ? null : Number(cell.dataset.c);
    showCorrDetail(i, j, c);
  });

  // Hover: highlight row+col + show tooltip
  document.body.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('#corr-heatmap .corr-cell');
    if (!cell) return;
    highlightAxis(Number(cell.dataset.row), Number(cell.dataset.col));
    showCorrTooltip(cell, e);
  });
  document.body.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('#corr-heatmap')) {
      // Only clear when leaving the whole heatmap
      const to = e.relatedTarget;
      if (!to || !to.closest || !to.closest('#corr-heatmap')) clearAxisHighlight();
    }
  });

  // Re-render on resize (debounced) so cells fill canvas
  let resizeTimer;
  window.addEventListener('resize', () => {
    if (document.getElementById('corr-modal-overlay').hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderHeatmap, 200);
  });
}

// =========================================================================
//  🔎 QUERY DSL — saved views — URL share
// =========================================================================

const QUERY_FIELDS = {
  // numeric
  score: b => b.promotion_score,
  score_raw: b => b.promotion_score_raw,
  score_shrunk: b => b.promotion_score_shrunk,
  trades: b => b.trades,
  net: b => b.net_profit,
  pf: b => b.profit_factor,
  calmar: b => b.calmar,
  sortino: b => b.sortino,
  sharpe: b => b.sharpe_annualized,
  win_rate: b => b.win_rate_pct,
  months_active: b => b.months_active,
  age_days: b => (b.months_active || 0) * 30,
  decay_ratio: b => b.decay_ratio,
  capacity_usd: b => b.capacity?.capacity_usd,
  drift_severity: b => b.drift?.severity,
  dd_pct: b => b.dd_pct_of_balance,
  tribunal_rank: b => (b.tribunal && !b.tribunal.is_suplente) ? b.tribunal.rank : null,
  tribunal_comp: b => b.tribunal ? b.tribunal.comp : null,
  podium_streak: b => b.tribunal_history ? b.tribunal_history.consecutive_podiums : null,
  ready_streak: b => b.ready_streak_days,
  // boolean
  drift_flag: b => !!(b.drift && b.drift.flag),
  decay_flag: b => !!b.decay_flag,
  is_real: b => !!(b.real_vs_demo && b.real_vs_demo.is_real),
  in_podium: b => !!(b.tribunal && !b.tribunal.is_suplente && b.tribunal.rank != null),
  // strings (for IN / =)
  double_signature: b => b.double_signature || '',
  status: b => b.promotion_status,
  vps: b => b.vps,
  login: b => String(b.account_login),
  magic: b => String(b.magic),
  symbol: b => (b.symbols && b.symbols[0]) ? b.symbols[0].split('.')[0].toUpperCase() : '',
};

function tokenizeQuery(text) {
  const toks = [];
  let i = 0;
  const upper = text.toUpperCase();
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')' || ch === ',') { toks.push({ t: ch }); i++; continue; }
    if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) throw new Error(`String sin cerrar en pos ${i}`);
      toks.push({ t: 'str', v: text.slice(i + 1, end) });
      i = end + 1; continue;
    }
    if (/[0-9.\-]/.test(ch) && (i === 0 || /[\s(,=<>!]/.test(text[i - 1]))) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE]/.test(text[j])) j++;
      const num = parseFloat(text.slice(i, j));
      if (!isNaN(num)) { toks.push({ t: 'num', v: num }); i = j; continue; }
    }
    if (ch === '>' || ch === '<' || ch === '=' || ch === '!') {
      const next = text[i + 1];
      if ((ch === '>' || ch === '<') && next === '=') { toks.push({ t: 'op', v: ch + '=' }); i += 2; continue; }
      if (ch === '!' && next === '=') { toks.push({ t: 'op', v: '!=' }); i += 2; continue; }
      if (ch === '=' || ch === '>' || ch === '<') { toks.push({ t: 'op', v: ch }); i++; continue; }
      throw new Error(`Operador inválido en pos ${i}`);
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      const wu = word.toUpperCase();
      if (['AND', 'OR', 'NOT', 'IN', 'TRUE', 'FALSE', 'SORT', 'BY', 'ASC', 'DESC', 'LIMIT'].includes(wu)) {
        toks.push({ t: 'kw', v: wu });
      } else {
        toks.push({ t: 'id', v: word });
      }
      i = j; continue;
    }
    throw new Error(`Token inesperado en pos ${i}: ${ch}`);
  }
  return toks;
}

function parseQuery(text) {
  const toks = tokenizeQuery(text);
  let pos = 0;
  const peek = () => toks[pos];
  const eat = () => toks[pos++];
  const expect = (t, v) => {
    const tk = toks[pos];
    if (!tk || tk.t !== t || (v !== undefined && tk.v !== v)) {
      throw new Error(`Esperado ${t}${v ? ' ' + v : ''}, encontré ${tk ? tk.t + (tk.v ? ' ' + tk.v : '') : 'EOF'}`);
    }
    pos++; return tk;
  };

  function parseValue() {
    const tk = eat();
    if (!tk) throw new Error('Valor faltante');
    if (tk.t === 'num') return tk.v;
    if (tk.t === 'str') return tk.v;
    if (tk.t === 'kw' && (tk.v === 'TRUE' || tk.v === 'FALSE')) return tk.v === 'TRUE';
    if (tk.t === 'id') return tk.v; // bareword treated as string
    throw new Error('Valor inválido: ' + JSON.stringify(tk));
  }

  function parseAtom() {
    const tk = peek();
    if (!tk) throw new Error('Expresión vacía');
    if (tk.t === '(') {
      eat();
      const expr = parseOr();
      expect(')');
      return expr;
    }
    if (tk.t === 'kw' && tk.v === 'NOT') {
      eat();
      const inner = parseAtom();
      return b => !inner(b);
    }
    if (tk.t === 'id') {
      const field = eat().v;
      const fn = QUERY_FIELDS[field];
      if (!fn) throw new Error(`Campo desconocido: ${field}. Disponibles: ${Object.keys(QUERY_FIELDS).join(', ')}`);
      const opTk = eat();
      if (!opTk) throw new Error('Operador faltante después de ' + field);
      // IN (...)
      if (opTk.t === 'kw' && opTk.v === 'IN') {
        expect('(');
        const list = [];
        while (true) {
          list.push(parseValue());
          const n = peek();
          if (n && n.t === ',') { eat(); continue; }
          break;
        }
        expect(')');
        const setVals = new Set(list.map(v => typeof v === 'string' ? v.toUpperCase() : v));
        return b => {
          let v = fn(b);
          if (typeof v === 'string') v = v.toUpperCase();
          return setVals.has(v);
        };
      }
      if (opTk.t !== 'op') throw new Error(`Operador inválido: ${opTk.v}`);
      const val = parseValue();
      const op = opTk.v;
      return b => {
        let v = fn(b);
        if (v == null) v = (typeof val === 'number') ? 0 : (typeof val === 'boolean' ? false : '');
        if (typeof val === 'string' && typeof v === 'string') {
          const a = v.toUpperCase(); const c = val.toUpperCase();
          if (op === '=') return a === c;
          if (op === '!=') return a !== c;
          throw new Error(`Operador ${op} no soportado entre strings`);
        }
        if (op === '=') return v === val;
        if (op === '!=') return v !== val;
        if (op === '>') return v > val;
        if (op === '>=') return v >= val;
        if (op === '<') return v < val;
        if (op === '<=') return v <= val;
        return false;
      };
    }
    throw new Error('Expresión inesperada: ' + JSON.stringify(tk));
  }
  function parseAnd() {
    let left = parseAtom();
    while (peek() && peek().t === 'kw' && peek().v === 'AND') { eat(); const right = parseAtom(); const l = left, r = right; left = b => l(b) && r(b); }
    return left;
  }
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === 'kw' && peek().v === 'OR') { eat(); const right = parseAnd(); const l = left, r = right; left = b => l(b) || r(b); }
    return left;
  }
  // Consume the predicate, then optional SORT BY <field> [ASC|DESC] LIMIT <n>
  let predicate = null;
  if (toks.length) predicate = parseOr();
  let sortField = null;
  let sortDir = 'desc';
  let limit = null;
  while (pos < toks.length) {
    const tk = eat();
    if (tk.t === 'kw' && tk.v === 'SORT') {
      expect('kw', 'BY');
      const f = expect('id').v;
      if (!QUERY_FIELDS[f]) throw new Error(`Campo desconocido en SORT BY: ${f}`);
      sortField = f;
      if (peek() && peek().t === 'kw' && (peek().v === 'ASC' || peek().v === 'DESC')) {
        sortDir = eat().v.toLowerCase();
      }
    } else if (tk.t === 'kw' && tk.v === 'LIMIT') {
      const n = eat();
      if (!n || n.t !== 'num') throw new Error('LIMIT requiere número');
      limit = Math.max(0, Math.floor(n.v));
    } else {
      throw new Error('Token inesperado: ' + JSON.stringify(tk));
    }
  }
  return { predicate: predicate || (() => true), sortField, sortDir, limit };
}

function applyQuery(text) {
  const errEl = document.getElementById('query-error');
  const cntEl = document.getElementById('query-count');
  const results = document.getElementById('query-results');
  const tbody = document.getElementById('query-tbody');
  if (!text || !text.trim()) {
    if (errEl) errEl.hidden = true;
    if (results) results.hidden = true;
    if (cntEl) cntEl.textContent = '— bots';
    return;
  }
  let q;
  try {
    q = parseQuery(text);
  } catch (e) {
    if (errEl) { errEl.textContent = '⚠ ' + e.message; errEl.hidden = false; }
    if (cntEl) cntEl.textContent = 'error';
    if (results) results.hidden = true;
    return;
  }
  if (errEl) errEl.hidden = true;
  let bots = (state.snapshot?.bots || []).filter(b => b.magic && b.magic !== 0);
  bots = bots.filter(q.predicate);
  if (q.sortField) {
    const fn = QUERY_FIELDS[q.sortField];
    bots.sort((a, c) => {
      const va = fn(a), vc = fn(c);
      if (typeof va === 'string') return q.sortDir === 'desc' ? String(vc).localeCompare(String(va)) : String(va).localeCompare(String(vc));
      return q.sortDir === 'desc' ? (Number(vc || 0) - Number(va || 0)) : (Number(va || 0) - Number(vc || 0));
    });
  }
  if (q.limit != null) bots = bots.slice(0, q.limit);
  if (cntEl) cntEl.textContent = `${bots.length} bots`;
  if (!bots.length) {
    if (results) results.hidden = false;
    tbody.innerHTML = '<tr><td colspan="13" class="empty-state" style="padding:24px;text-align:center">Sin bots que cumplan el query.</td></tr>';
    return;
  }
  tbody.innerHTML = bots.map((b, i) => {
    const drift = b.drift?.flag ? `<span class="profit-negative">${b.drift.severity?.toFixed(2)}×</span>` : '—';
    const cap = b.capacity?.capacity_usd ? `$${Math.round(b.capacity.capacity_usd / 1000)}K` : '—';
    return `
      <tr class="bot-row" data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}">
        <td><span class="rank-badge">${i + 1}</span></td>
        <td class="num"><strong style="color:var(--accent)">${(b.promotion_score ?? 0).toFixed(1)}</strong></td>
        <td>${statusBadge(b.promotion_status)}</td>
        <td class="mono">${b.magic}</td>
        <td>${vpsBadge(b.vps)}</td>
        <td class="mono">${b.account_login}</td>
        <td>${(b.symbols || []).join(',')}</td>
        <td class="num">${b.trades ?? 0}</td>
        <td class="num">${(b.profit_factor ?? 0).toFixed(2)}</td>
        <td class="num">${(b.calmar ?? 0).toFixed(2)}</td>
        <td class="num">${drift}</td>
        <td class="num">${cap}</td>
        <td class="num">${fmt.usd(b.net_profit, true)}</td>
      </tr>`;
  }).join('');
  if (results) results.hidden = false;
}

function loadSavedViews() {
  try {
    const raw = localStorage.getItem('kiz.queryViews');
    state.query.savedViews = raw ? JSON.parse(raw) : [];
  } catch { state.query.savedViews = []; }
  refreshViewsDropdown();
}
function saveView() {
  const txt = document.getElementById('query-input').value.trim();
  if (!txt) return alert('Escribe un query antes de guardar.');
  const name = prompt('Nombre de la vista:', '');
  if (!name) return;
  state.query.savedViews = state.query.savedViews.filter(v => v.name !== name);
  state.query.savedViews.push({ name, q: txt });
  localStorage.setItem('kiz.queryViews', JSON.stringify(state.query.savedViews));
  refreshViewsDropdown();
}
function refreshViewsDropdown() {
  const sel = document.getElementById('query-views');
  if (!sel) return;
  const opts = ['<option value="">— vistas guardadas —</option>'];
  for (const v of state.query.savedViews) {
    opts.push(`<option value="${encodeURIComponent(v.q)}">${v.name}</option>`);
  }
  // built-in presets
  opts.push('<option disabled>— presets —</option>');
  opts.push(`<option value="${encodeURIComponent('status = "READY" SORT BY score DESC LIMIT 20')}">★ Top READY</option>`);
  opts.push(`<option value="${encodeURIComponent('status IN ("READY","NEAR") AND drift_flag = false AND capacity_usd >= 10000 SORT BY score DESC')}">🚀 Promotion pipeline</option>`);
  opts.push(`<option value="${encodeURIComponent('drift_flag = true SORT BY drift_severity DESC')}">🚨 Drift watch</option>`);
  opts.push(`<option value="${encodeURIComponent('is_real = true SORT BY net DESC')}">💰 Bots reales</option>`);
  opts.push(`<option value="${encodeURIComponent('age_days >= 180 AND pf >= 1.5 AND drift_flag = false SORT BY calmar DESC LIMIT 30')}">⚖️ Maduros + sanos</option>`);
  sel.innerHTML = opts.join('');
}
function shareQuery() {
  const txt = document.getElementById('query-input').value.trim();
  if (!txt) return;
  const url = `${location.origin}${location.pathname}#q=${encodeURIComponent(txt)}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('query-share');
    const old = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = old; }, 1200);
  });
}
function loadFromHash() {
  const h = location.hash;
  if (h.startsWith('#q=')) {
    const text = decodeURIComponent(h.slice(3));
    const input = document.getElementById('query-input');
    if (input) input.value = text;
    const sec = document.getElementById('query-bar-section');
    if (sec) sec.hidden = false;
    applyQuery(text);
  }
}
function toggleQueryBar() {
  const sec = document.getElementById('query-bar-section');
  if (!sec) return;
  sec.hidden = !sec.hidden;
  if (!sec.hidden) {
    const input = document.getElementById('query-input');
    if (input) setTimeout(() => input.focus(), 50);
  }
}
function showQueryHelper() {
  const help = document.getElementById('query-helper');
  if (!help) return;
  help.hidden = !help.hidden;
  if (!help.hidden) {
    help.innerHTML = `
      <div class="query-helper-grid">
        <div>
          <strong>Operadores</strong>
          <code>=</code> <code>!=</code> <code>&gt;</code> <code>&gt;=</code> <code>&lt;</code> <code>&lt;=</code> <code>IN</code> <code>AND</code> <code>OR</code> <code>NOT</code>
        </div>
        <div>
          <strong>Modificadores</strong>
          <code>SORT BY &lt;campo&gt; [ASC|DESC]</code> · <code>LIMIT &lt;n&gt;</code>
        </div>
        <div>
          <strong>Campos numéricos</strong>
          ${['score','score_raw','score_shrunk','trades','net','pf','calmar','sortino','sharpe','win_rate','months_active','age_days','decay_ratio','capacity_usd','drift_severity','dd_pct'].map(x => `<code>${x}</code>`).join(' ')}
        </div>
        <div>
          <strong>Booleanos</strong>
          ${['drift_flag','decay_flag','is_real'].map(x => `<code>${x}</code>`).join(' ')}
        </div>
        <div>
          <strong>String</strong>
          ${['status','vps','login','magic','symbol'].map(x => `<code>${x}</code>`).join(' ')}
        </div>
        <div>
          <strong>Ejemplo</strong>
          <code>status IN ("READY","NEAR") AND drift_flag = false AND capacity_usd &gt;= 15000 SORT BY calmar DESC LIMIT 20</code>
        </div>
      </div>`;
  }
}
function wireQueryBar() {
  const btn = document.getElementById('query-btn');
  if (btn) btn.addEventListener('click', toggleQueryBar);
  const input = document.getElementById('query-input');
  if (input) {
    let dbTimer;
    input.addEventListener('input', (e) => {
      clearTimeout(dbTimer);
      dbTimer = setTimeout(() => applyQuery(e.target.value), 250);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyQuery(input.value); }
      if (e.key === 'Escape') { input.value = ''; applyQuery(''); }
    });
  }
  document.getElementById('query-clear')?.addEventListener('click', () => {
    if (input) input.value = '';
    applyQuery('');
  });
  document.getElementById('query-save')?.addEventListener('click', saveView);
  document.getElementById('query-share')?.addEventListener('click', shareQuery);
  document.getElementById('query-help')?.addEventListener('click', showQueryHelper);
  document.getElementById('query-results-close')?.addEventListener('click', () => {
    document.getElementById('query-results').hidden = true;
  });
  document.getElementById('query-views')?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v) return;
    const text = decodeURIComponent(v);
    if (input) input.value = text;
    applyQuery(text);
  });
  loadSavedViews();
  window.addEventListener('hashchange', loadFromHash);
}

wireEvents();
wireBotModal();
wireNewBotsControls();
wireCandidatesControls();
wireCorrModal();
wirePortfolioModal();
wireBuilderModal();
wireQueryBar();
wireDNAModal();
wireCompareModal();
wireMcpHealth();
wireTiming();
paintCachedSnapshot();  // instant first paint from localStorage (SWR)
loadSnapshot();         // then revalidate from the network in the background

// ----------------------- MCP Health chip + modal -----------------------
async function fetchMcpHealth() {
  try {
    const res = await fetch('data/mcp_health.json?ts=' + Date.now());
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

function classifyMcp(data) {
  if (!data || typeof data.ok_count !== 'number') return { tone: 'loading', label: '—/5' };
  const label = `${data.ok_count}/${data.total}`;
  if (data.ok_count === data.total) {
    // RAM under the pre-freeze floor (<40MB) is informational amber: the VPS is
    // still 'ok' (SSH + snapshot + freshness passed) but worth a glance.
    const ramCrit = Object.values(data.vps || {}).some(r => r && r.ram_critical_info);
    return ramCrit ? { tone: 'warn', label } : { tone: 'ok', label };
  }
  if (data.any_critical) return { tone: 'crit', label };
  return { tone: 'warn', label };
}

function _mcpEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMcpChip(data) {
  const chip = document.getElementById('mcp-chip');
  if (!chip) return;
  const count = document.getElementById('mcp-chip-count');
  const { tone, label } = classifyMcp(data);
  chip.classList.remove('mcp-chip--loading', 'mcp-chip--ok', 'mcp-chip--warn', 'mcp-chip--crit');
  chip.classList.add(`mcp-chip--${tone}`);
  if (count) count.textContent = label;
}

function renderMcpModal(data) {
  const grid = document.getElementById('mcp-grid');
  if (!grid) return;
  const sub = document.getElementById('mcp-modal-sub');
  const sOk = document.getElementById('mcp-stat-ok');
  const sTot = document.getElementById('mcp-stat-total');
  const sCrit = document.getElementById('mcp-stat-crit');
  const sChk = document.getElementById('mcp-stat-checked');

  if (!data) {
    grid.innerHTML = '<div class="empty-state">Sin datos todavía. El workflow mcp-health corre cada 5 min.</div>';
    if (sOk) sOk.textContent = '—';
    if (sTot) sTot.textContent = '—';
    if (sCrit) sCrit.textContent = '—';
    if (sChk) sChk.textContent = '—';
    return;
  }
  const rows = Object.values(data.vps || {}).sort((a, b) => a.vps_id.localeCompare(b.vps_id));
  const crit = rows.filter(r => (r.consecutive_fails || 0) >= 2).length;
  if (sOk) sOk.textContent = data.ok_count;
  if (sTot) sTot.textContent = data.total;
  if (sCrit) sCrit.textContent = crit;
  if (sChk) sChk.textContent = data.checked_at ? new Date(data.checked_at).toLocaleString() : '—';

  grid.innerHTML = rows.map(r => {
    const ramCrit = !!r.ram_critical_info;
    const dot = r.status === 'ok' ? (ramCrit ? '🟡' : '🟢') : ((r.consecutive_fails || 0) >= 2 ? '🔴' : '🟡');
    const age = (r.snapshot_age_sec != null) ? `${Math.round(r.snapshot_age_sec / 60)} min` : '—';
    const ssh = (r.ssh_ms != null) ? `${Math.round(r.ssh_ms)} ms` : '—';
    const ram = (r.free_ram_mb != null)
      ? `${r.free_ram_mb} MB${(r.pagefile_commit_pct != null) ? ` · pf ${r.pagefile_commit_pct}%` : ''}`
      : '—';
    const reason = r.fail_reason ? `<div class="mcp-card-reason">⚠️ ${_mcpEsc(r.fail_reason)}</div>`
      : (ramCrit ? `<div class="mcp-card-reason">🟡 RAM crítica (&lt;40MB libres) — informativo, VPS operativa</div>` : '');
    const fails = r.consecutive_fails || 0;
    return `
      <article class="mcp-card mcp-card--${_mcpEsc(r.status)}">
        <header class="mcp-card-head">
          <span class="mcp-card-dot">${dot}</span>
          <strong class="mcp-card-title">${_mcpEsc(r.vps_id).toUpperCase()}</strong>
          <span class="mcp-card-host">${_mcpEsc(r.host)}</span>
        </header>
        <div class="mcp-card-stats">
          <div><span>Status</span><strong>${_mcpEsc(r.status)}</strong></div>
          <div><span>SSH</span><strong>${ssh}</strong></div>
          <div><span>Snapshot</span><strong>${age}</strong></div>
          <div><span>RAM</span><strong class="${ramCrit ? 'negative' : ''}">${_mcpEsc(ram)}</strong></div>
          <div><span>Fails</span><strong class="${fails >= 2 ? 'negative' : ''}">${fails}</strong></div>
        </div>
        ${reason}
      </article>`;
  }).join('');
}

async function refreshMcpHealth() {
  const data = await fetchMcpHealth();
  window.__kizMcpHealth = data;
  renderMcpChip(data);
  renderMcpModal(data);
}

function wireMcpHealth() {
  const chip = document.getElementById('mcp-chip');
  const overlay = document.getElementById('mcp-modal-overlay');
  const closeBtn = document.getElementById('mcp-modal-close');
  if (chip && overlay) {
    chip.addEventListener('click', () => {
      renderMcpModal(window.__kizMcpHealth);
      overlay.hidden = false;
    });
  }
  if (closeBtn && overlay) closeBtn.addEventListener('click', () => { overlay.hidden = true; });
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target.id === 'mcp-modal-overlay') overlay.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) overlay.hidden = true;
  });
  refreshMcpHealth();
  setInterval(refreshMcpHealth, 60000);
}

// ----------------------- Pipeline latency chip + modal -----------------------
// Reads data/pipeline_timing.json (emitted by mirror.sh/emit_timing.py). Mirrors
// the MCP chip pattern. The chip shows end-to-end seconds; the modal breaks down
// each stage (mirror/post_merge/upload/…) with p50/p95, and the "what moved"
// delta derived in the browser. This is the observability that proved the mirror
// transport (not post_merge) was 91% of the cycle.
function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

async function fetchTiming() {
  try {
    const res = await fetch('data/pipeline_timing.json?ts=' + Date.now());
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

function classifyTiming(t) {
  const e2e = t && t.cycle && t.cycle.end_to_end_ms;
  if (e2e == null) return { tone: 'loading', label: '—' };
  const label = fmtMs(e2e);
  // Thresholds tuned to the parallel-mirror baseline (~113s e2e). Amber/red flag
  // regressions so a slowdown is visible before it becomes staleness.
  if (e2e <= 180000) return { tone: 'ok', label };
  if (e2e <= 300000) return { tone: 'warn', label };
  return { tone: 'crit', label };
}

function renderTimingChip(t) {
  const chip = document.getElementById('timing-chip');
  if (!chip) return;
  const lab = document.getElementById('timing-chip-label');
  const { tone, label } = classifyTiming(t);
  chip.classList.remove('timing-chip--loading', 'timing-chip--ok', 'timing-chip--warn', 'timing-chip--crit');
  chip.classList.add(`timing-chip--${tone}`);
  if (lab) lab.textContent = label;
}

const TIMING_STAGES = [
  ['mirror_ms', 'Mirror (scp 6 VPS)'],
  ['reconcile_ms', 'Reconcile'],
  ['fetch_ledger_ms', 'Fetch ledger'],
  ['post_merge_ms', 'Post-merge (scores/MC/OOS)'],
  ['verify_ms', 'Verify integrity'],
  ['upload_ms', 'Upload Supabase'],
];

function renderTimingModal(t) {
  const grid = document.getElementById('timing-grid');
  if (!grid) return;
  const sE2E = document.getElementById('timing-stat-e2e');
  const sSamples = document.getElementById('timing-stat-samples');
  const sWhen = document.getElementById('timing-stat-when');
  const sMoved = document.getElementById('timing-stat-moved');

  if (!t || !t.cycle) {
    grid.innerHTML = '<div class="empty-state">Sin datos todavía. La telemetría se emite cada ciclo de refresh.</div>';
    if (sE2E) sE2E.textContent = '—';
    if (sSamples) sSamples.textContent = '—';
    if (sWhen) sWhen.textContent = '—';
    if (sMoved) sMoved.textContent = (window.__kizDeltas ? String(window.__kizDeltas.total) : '—');
    return;
  }
  const cyc = t.cycle, p50 = t.p50 || {}, p95 = t.p95 || {};
  const e2e = cyc.end_to_end_ms || 0;
  if (sE2E) sE2E.textContent = fmtMs(e2e);
  if (sSamples) sSamples.textContent = t.samples != null ? String(t.samples) : '—';
  if (sWhen) sWhen.textContent = t.generated_at ? new Date(t.generated_at).toLocaleString() : '—';
  if (sMoved) sMoved.textContent = window.__kizDeltas ? String(window.__kizDeltas.total) : '—';

  const maxStage = Math.max(1, ...TIMING_STAGES.map(([k]) => cyc[k] || 0));
  grid.innerHTML = TIMING_STAGES.map(([k, label]) => {
    const v = cyc[k] || 0;
    const pctBar = Math.round((v / maxStage) * 100);
    const pctCycle = e2e ? Math.round((v / e2e) * 100) : 0;
    const dominant = pctCycle >= 50 ? ' timing-row--dominant' : '';
    return `
      <article class="timing-row${dominant}">
        <div class="timing-row-head">
          <strong>${_mcpEsc(label)}</strong>
          <span class="timing-row-val">${fmtMs(v)} · ${pctCycle}%</span>
        </div>
        <div class="timing-bar"><span class="timing-bar-fill" style="width:${pctBar}%"></span></div>
        <div class="timing-row-pct">p50 ${fmtMs(p50[k])} · p95 ${fmtMs(p95[k])}</div>
      </article>`;
  }).join('');

  // "What moved" section
  const movedBox = document.getElementById('timing-moved');
  if (movedBox) {
    const d = window.__kizDeltas;
    if (!d || d.total === 0) {
      movedBox.innerHTML = '<div class="empty-state">Sin cambios desde el ciclo anterior.</div>';
    } else {
      const items = [];
      d.transitions.forEach(x => items.push(`<li><span class="moved-tag moved-tag--${_mcpEsc(x.dir)}">${_mcpEsc(x.from)}→${_mcpEsc(x.to)}</span> magic ${x.magic} <span class="moved-vps">${_mcpEsc(x.vps)}</span></li>`));
      d.scoreMoves.slice(0, 8).forEach(x => items.push(`<li><span class="moved-tag moved-tag--${x.delta >= 0 ? 'up' : 'down'}">${x.delta >= 0 ? '▲' : '▼'} ${Math.abs(x.delta).toFixed(1)}</span> score · magic ${x.magic} <span class="moved-vps">${_mcpEsc(x.vps)}</span></li>`));
      movedBox.innerHTML = `<ul class="moved-list">${items.join('')}</ul>`;
    }
  }
}

async function refreshTiming() {
  const data = await fetchTiming();
  window.__kizTiming = data;
  renderTimingChip(data);
  renderTimingModal(data);
}

// Derive "what moved" between two snapshots, in the browser. Surfaces status
// transitions (READY/NEAR/WATCH/NO) and material promotion_score changes.
function computeWhatMoved(prev, next) {
  const result = { total: 0, transitions: [], scoreMoves: [] };
  if (!prev || !next || !Array.isArray(prev.bots) || !Array.isArray(next.bots)) {
    window.__kizDeltas = result; return;
  }
  const keyOf = b => `${b.vps}/${b.account_login}/${b.magic}`;
  const prevMap = new Map(prev.bots.map(b => [keyOf(b), b]));
  const rank = { NO: 0, WATCH: 1, NEAR: 2, READY: 3 };
  for (const b of next.bots) {
    const p = prevMap.get(keyOf(b));
    if (!p) continue;
    const ps = p.promotion_status, ns = b.promotion_status;
    if (ps && ns && ps !== ns) {
      result.transitions.push({
        vps: b.vps, magic: b.magic, from: ps, to: ns,
        dir: (rank[ns] ?? 0) >= (rank[ps] ?? 0) ? 'up' : 'down',
      });
    }
    const pScore = p.promotion_score, nScore = b.promotion_score;
    if (typeof pScore === 'number' && typeof nScore === 'number') {
      const delta = nScore - pScore;
      if (Math.abs(delta) >= 2) result.scoreMoves.push({ vps: b.vps, magic: b.magic, delta });
    }
  }
  result.scoreMoves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  result.total = result.transitions.length + result.scoreMoves.length;
  window.__kizDeltas = result;
  // Reflect the count on the chip badge if present.
  const badge = document.getElementById('timing-moved-badge');
  if (badge) { badge.textContent = result.total > 0 ? String(result.total) : ''; badge.hidden = result.total === 0; }
}

function wireTiming() {
  const chip = document.getElementById('timing-chip');
  const overlay = document.getElementById('timing-modal-overlay');
  const closeBtn = document.getElementById('timing-modal-close');
  if (chip && overlay) {
    chip.addEventListener('click', () => { renderTimingModal(window.__kizTiming); overlay.hidden = false; });
  }
  if (closeBtn && overlay) closeBtn.addEventListener('click', () => { overlay.hidden = true; });
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target.id === 'timing-modal-overlay') overlay.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) overlay.hidden = true;
  });
  refreshTiming();
  setInterval(refreshTiming, 60000);
}

function wireNewBotsControls() {
  const search = document.getElementById('new-bots-search');
  if (search) {
    search.addEventListener('input', (e) => {
      state.newBotsSearch = e.target.value;
      try { renderNewBots(); } catch(err) { console.error(err); }
    });
  }
  document.querySelectorAll('#new-bots-filter-pills .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#new-bots-filter-pills .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.newBotsFilter = pill.dataset.filter;
      try { renderNewBots(); } catch(err) { console.error(err); }
    });
  });
  // VPS pills are populated dynamically; delegate clicks
  document.getElementById('new-bots-vps-pills')?.addEventListener('click', (e) => {
    const pill = e.target.closest('.vps-pill');
    if (!pill) return;
    document.querySelectorAll('#new-bots-vps-pills .vps-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    state.newBotsVps = pill.dataset.vps;
    try { renderNewBots(); } catch(err) { console.error(err); }
  });
}

function renderNewBotsVpsPills() {
  const container = document.getElementById('new-bots-vps-pills');
  if (!container) return;
  const ids = Object.keys(state.snapshot?.vps_sources || {});
  const parts = [`<button class="pill vps-pill ${state.newBotsVps === 'all' ? 'active' : ''}" data-vps="all">Todos VPS</button>`];
  for (const id of ids) {
    parts.push(`<button class="pill vps-pill vps-${id} ${state.newBotsVps === id ? 'active' : ''}" data-vps="${id}">${(id||'').toUpperCase()}</button>`);
  }
  container.innerHTML = parts.join('');
}

// =====================================================================
// 🌊 UNDERWATER PANEL
// =====================================================================
function renderUnderwaterPanel(b) {
  const uw = b.underwater;
  if (!uw) {
    return `<div class="empty-state">⚠️ Sin análisis underwater: el bot tiene menos de 10 días en daily_equity_series.</div>`;
  }
  const longest = uw.longest_underwater_days || 0;
  const longestCls = longest > 60 ? 'uw-bad' : longest > 30 ? 'uw-warn' : 'uw-ok';
  const longestVerdict = longest > 60 ? '🔴 ZOMBI' : longest > 30 ? '🟡 LARGO' : '✅ SANO';
  const painCls = (uw.pain_index_pct || 0) > 5 ? 'uw-bad' : (uw.pain_index_pct || 0) > 2 ? 'uw-warn' : 'uw-ok';
  const fmtDate = (s) => {
    if (!s) return '—';
    try { return new Date(s).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' }); }
    catch { return s; }
  };
  const rowsHtml = (uw.top_drawdowns || []).map((e, i) => {
    const uwCls = e.underwater_days > 60 ? 'uw-bad' : e.underwater_days > 30 ? 'uw-warn' : '';
    const recVal = e.ongoing ? '<span class="uw-bad">EN CURSO</span>' : `${e.recovery_days || 0}d`;
    return `<tr>
      <td>${i + 1}</td>
      <td>${fmtDate(e.start_date)}</td>
      <td>${fmtDate(e.max_dd_date)}</td>
      <td>${fmtDate(e.end_date)}</td>
      <td class="num ${uwCls}">${e.underwater_days}d</td>
      <td class="num">${recVal}</td>
      <td class="num negative">${fmt.usd(e.max_dd_abs)}</td>
      <td class="num negative">${(e.max_dd_pct || 0).toFixed(2)}%</td>
    </tr>`;
  }).join('');
  return `
    <div class="stress-hero">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">🌊 Underwater · ${uw.n_episodes} episodios totales · top 10 por profundidad</div>
        <div class="stress-hero-grid">
          <div class="stress-big">
            <div class="stress-big-label">Días bajo agua máximo</div>
            <div class="stress-big-value ${longestCls}">${longest}d</div>
            <div class="stress-big-hint">${longestVerdict} · DD continuo más largo</div>
          </div>
          <div class="stress-big">
            <div class="stress-big-label">Pain Index</div>
            <div class="stress-big-value ${painCls}">${(uw.pain_index_pct || 0).toFixed(2)}%</div>
            <div class="stress-big-hint">DD% promedio diario · sufrimiento medio</div>
          </div>
          <div class="stress-big">
            <div class="stress-big-label">Recovery Factor</div>
            <div class="stress-big-value ${(uw.recovery_factor_proper || 0) > 3 ? 'positive' : ''}">${uw.recovery_factor_proper != null ? uw.recovery_factor_proper.toFixed(2) : '—'}</div>
            <div class="stress-big-hint">Net acumulado / Max DD — capacidad de recuperar</div>
          </div>
        </div>
      </div>
    </div>
    <div class="underwater-chart-wrap">
      <canvas id="underwater-chart"></canvas>
    </div>
    <h4 class="panel-title">Top 10 drawdowns por profundidad</h4>
    <div class="table-wrapper compact">
      <table class="underwater-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Inicio</th>
            <th>Mín. equity</th>
            <th>Recuperación</th>
            <th class="num">Días bajo agua</th>
            <th class="num">Días recovery</th>
            <th class="num">Profundidad $</th>
            <th class="num">Profundidad %</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="8" class="empty-state">Sin episodios de drawdown.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

async function drawUnderwaterChart(b) {
  const canvas = document.getElementById('underwater-chart');
  if (!canvas) return;
  // Load per-bot daily series
  let daily = [];
  try {
    const res = await fetch(`data/bots/${b.vps}/${b.account_login}-${b.magic}.json?t=${Date.now()}`);
    if (res.ok) { const j = await res.json(); daily = j.daily_equity_series || []; }
  } catch {}
  if (!daily.length) { canvas.parentElement.innerHTML = '<div class="empty-state">Sin daily_equity_series.</div>'; return; }
  const labels = daily.map(p => new Date(p.date));
  const ddPct = daily.map(p => -(p.dd_pct || 0));
  if (modalState.charts.main) { modalState.charts.main.destroy(); modalState.charts.main = null; }
  modalState.charts.main = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [{
      label: 'Underwater (% bajo peak)',
      data: ddPct,
      borderColor: '#ff6b8b',
      backgroundColor: 'rgba(255, 107, 139, 0.25)',
      fill: 'origin',
      pointRadius: 0,
      tension: 0,
    }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: {
        legend: { display: true, labels: { color: '#9aa3bb' } },
        tooltip: {
          backgroundColor: 'rgba(10, 11, 18, 0.95)',
          callbacks: { label: (it) => `Underwater: ${it.raw.toFixed(2)}%` },
        },
      },
      scales: {
        x: { type: 'time', time: { unit: labels.length > 200 ? 'month' : 'week' }, ticks: { color: '#6b7390', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#6b7390', callback: (v) => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' }, max: 0 },
      },
    },
  });
}

// =====================================================================
// ⚡ HISTORICAL EVENT STRESS PANEL
// =====================================================================
function renderEventsPanel(b) {
  const ev = b.event_stress;
  if (!ev) {
    return `<div class="empty-state">⚠️ Sin análisis de eventos: este bot no tiene daily_equity_series suficiente.</div>`;
  }
  const totalEvents = ev.n_total_events || (ev.events || []).length;
  const tested = ev.battle_tested ? '⚔️ BATTLE-TESTED' : (ev.n_active >= 1 ? `⚠️ Vivió ${ev.n_active}/${totalEvents} eventos` : '⚠️ UNTESTED — bot demasiado nuevo');
  const testedCls = ev.battle_tested ? 'positive' : 'negative';
  const cards = (ev.events || []).map(e => {
    if (!e.active) {
      const reasonLabel = e.reason === 'not_yet_running' ? 'Bot no estaba activo aún' : 'Sin actividad en ventana';
      return `<div class="event-card event-card-inactive">
        <div class="event-icon">${e.icon}</div>
        <div class="event-name">${e.name}</div>
        <div class="event-window">${e.start} → ${e.end}</div>
        <div class="event-status">${reasonLabel}</div>
      </div>`;
    }
    const cls = e.verdict === 'positive' ? 'event-pos' : e.verdict === 'negative' ? 'event-neg' : 'event-flat';
    return `<div class="event-card ${cls}">
      <div class="event-icon">${e.icon}</div>
      <div class="event-name">${e.name}</div>
      <div class="event-window">${e.start} → ${e.end}</div>
      <div class="event-stats">
        <div><span>Net:</span><strong class="${e.verdict === 'positive' ? 'positive' : 'negative'}">${fmt.usd(e.net, true)}</strong></div>
        <div><span>Trades:</span><strong>${e.trades}</strong></div>
        ${e.win_rate_pct != null ? `<div><span>WR:</span><strong>${e.win_rate_pct.toFixed(1)}%</strong></div>` : ''}
        <div><span>Max DD:</span><strong class="negative">${fmt.usd(e.max_dd_intra)}</strong></div>
      </div>
    </div>`;
  }).join('');
  return `
    <div class="stress-hero">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">⚡ Replay durante eventos macro reales · ${ev.n_active}/${totalEvents} vividos · ${ev.n_positive} positivos</div>
        <div class="events-verdict ${testedCls}">${tested}</div>
        <p class="events-explainer">A diferencia del Monte Carlo (que asume distribución estable), este replay muestra cómo el bot se comportó en <strong>tail events reales</strong> — la única prueba de que sobrevive condiciones que ningún bootstrap puede reproducir. Promovible a real solo con ≥3 eventos vividos en verde.</p>
      </div>
    </div>
    <div class="events-grid">${cards}</div>
  `;
}

// =====================================================================
// 🎯 PROMOTION RADAR (8-axis percentile-rank spider)
// =====================================================================
function renderRadarPanel(b) {
  const r = b.promotion_radar;
  if (!r) return `<div class="empty-state">⚠️ Radar no disponible: el bot no está en la cohorte gating-eligible (necesita pasar trades≥30, meses≥3, DD≤15%, net>0).</div>`;
  const meta = (state.snapshot.enrichment_meta || {}).promotion_radar || {};
  const cohort = meta.cohort || {};
  const shapeCls = r.area_pct >= 70 ? 'radar-shape-good' : r.area_pct >= 50 ? 'radar-shape-mid' : r.area_pct >= 30 ? 'radar-shape-low' : 'radar-shape-bad';
  const asymCls = (r.asymmetry || 0) > 25 ? 'profit-negative' : (r.asymmetry || 0) > 18 ? 'warning' : 'positive';
  const rows = Object.entries(r.axes).map(([k, v]) => {
    const pct = v.pct;
    const cohortMed = (cohort[k] || {}).p50;
    const barCls = pct == null ? 'bar-na' : pct >= 70 ? 'bar-strong' : pct >= 50 ? 'bar-mid' : pct >= 30 ? 'bar-low' : 'bar-weak';
    const rawDisp = v.raw == null ? '—' : (Math.abs(v.raw) >= 1000 ? Math.round(v.raw).toLocaleString('en-US') : v.raw.toFixed(3));
    const medDisp = cohortMed == null ? '—' : (Math.abs(cohortMed) >= 1000 ? Math.round(cohortMed).toLocaleString('en-US') : cohortMed.toFixed(3));
    return `<tr>
      <td class="radar-axis-label">${v.label}</td>
      <td class="num">${rawDisp}</td>
      <td class="num radar-pct"><span class="radar-bar ${barCls}" style="width:${pct == null ? 0 : pct}%"></span><strong>${pct == null ? '—' : pct.toFixed(0)}</strong></td>
      <td class="num">${medDisp}</td>
    </tr>`;
  }).join('');
  return `
    <div class="radar-hero ${shapeCls}">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">🎯 Promotion Radar · 8 ejes percentil-rank · cohorte n=${meta.n_eligible ?? '—'}</div>
        <div class="radar-hero-grid">
          <div class="radar-big">
            <div class="radar-big-num">${r.area_pct == null ? '—' : r.area_pct.toFixed(0)}<span class="radar-big-suffix">/100</span></div>
            <div class="radar-big-label">Área media (composite)</div>
          </div>
          <div class="radar-big">
            <div class="radar-big-shape">${r.shape_label}</div>
            <div class="radar-big-label">Forma del polígono</div>
          </div>
          <div class="radar-big">
            <div class="radar-big-num ${asymCls}">${r.asymmetry == null ? '—' : r.asymmetry.toFixed(1)}σ</div>
            <div class="radar-big-label">${r.asymmetry_label} · stdev de ejes</div>
          </div>
        </div>
      </div>
    </div>
    <div class="radar-grid-2">
      <div class="radar-canvas-wrap"><canvas id="radar-chart"></canvas></div>
      <div class="radar-table-wrap">
        <table class="radar-table">
          <thead><tr><th>Eje</th><th class="num">Tu valor</th><th class="num">Percentil</th><th class="num">Mediana cohorte</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
    <p class="muted-note">El radar normaliza cada eje al rango percentil dentro de la cohorte gating-eligible (mediana = 50). El polígono dorado punteado es el bot mediano. Un eje en 90 + otro en 20 = bot <strong>espiga</strong> (riesgoso); ejes parejos cerca de 70 = <strong>equilibrado alto</strong> (ideal para promover).</p>
  `;
}

function drawRadarChart(b) {
  const canvas = document.getElementById('radar-chart');
  if (!canvas) return;
  const r = b.promotion_radar;
  if (!r) return;
  const order = ['returns','risk_adjusted','consistency','decay_health','sample_size','regime_robustness','oos_generalization','capacity_headroom'];
  const labels = order.map(k => (r.axes[k] || {}).label || k);
  const botData = order.map(k => (r.axes[k] || {}).pct ?? 0);
  const medianData = order.map(() => 50);  // P50 by definition of percentile rank
  if (modalState.charts.main) { modalState.charts.main.destroy(); modalState.charts.main = null; }
  modalState.charts.main = new Chart(canvas, {
    type: 'radar',
    data: {
      labels,
      datasets: [
        {
          label: 'Cohorte mediana (P50)',
          data: medianData,
          borderColor: 'rgba(255,195,107,0.7)',
          backgroundColor: 'rgba(255,195,107,0.06)',
          borderDash: [5, 5],
          pointRadius: 2,
          pointBackgroundColor: 'rgba(255,195,107,0.8)',
          borderWidth: 1.5,
        },
        {
          label: `Este bot (área ${(r.area_pct ?? 0).toFixed(0)})`,
          data: botData,
          borderColor: '#3ddc97',
          backgroundColor: 'rgba(61,220,151,0.22)',
          pointRadius: 4,
          pointBackgroundColor: '#3ddc97',
          pointBorderColor: '#0a0b12',
          pointBorderWidth: 2,
          borderWidth: 2.5,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 700 },
      plugins: {
        legend: { display: true, labels: { color: '#9aa3bb', font: { size: 11 } } },
        tooltip: {
          backgroundColor: 'rgba(10,11,18,0.95)',
          callbacks: { label: (it) => `${it.dataset.label}: ${it.raw.toFixed(0)} pct` },
        },
      },
      scales: {
        r: {
          min: 0, max: 100,
          ticks: { color: '#6b7390', backdropColor: 'transparent', stepSize: 25, font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.07)' },
          angleLines: { color: 'rgba(255,255,255,0.1)' },
          pointLabels: { color: '#cfd5e6', font: { size: 11, weight: '600' } },
        },
      },
    },
  });
}

// =====================================================================
// 🎻 TRADE QUALITY VIOLIN — distribución de $ por trade
// =====================================================================
function renderViolinPanel(b) {
  const td = b.trade_distribution;
  if (!td) return `<div class="empty-state">⚠️ Sin distribución de trades: el bot tiene menos de 30 trades cerrados.</div>`;
  const dtypeCls = ({
    GRINDER: 'positive',
    BALANCEADO: 'positive',
    OUTLIER_DEPENDIENTE: 'warning',
    LOTTERY: 'profit-negative',
    PERDEDOR: 'profit-negative',
    INDETERMINADO: '',
  })[td.distribution_type] || '';
  const usd = (n) => n == null ? '—' : `$${n.toFixed(2)}`;
  return `
    <div class="violin-hero ${dtypeCls}">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">🎻 Distribución $ por trade · n=${td.n} · ${td.wins_count} wins · ${td.losses_count} losses</div>
        <div class="violin-verdict-big">${td.distribution_type}</div>
        <div class="violin-verdict-hint">${td.interpretation || ''}</div>
      </div>
    </div>
    <div class="violin-canvas-wrap"><canvas id="violin-chart"></canvas></div>
    <div class="metric-grid violin-metrics">
      ${card('Mediana', usd(td.median), 'P50 — el trade típico')}
      ${card('Promedio', usd(td.mean), 'Sensible a outliers')}
      ${card('σ (stdev)', usd(td.stdev), 'Volatilidad por trade')}
      ${card('Skewness', td.skewness.toFixed(2), '+ = cola derecha (lottery); − = cola izquierda (grandes losses)')}
      ${card('Kurtosis exceso', td.excess_kurtosis.toFixed(2), '>0 = colas pesadas; >3 = muy peligroso')}
      ${card('Top 5% contribución', td.top5pct_contribution_pct == null ? '—' : `${td.top5pct_contribution_pct.toFixed(0)}%`, `Los ${td.top5pct_count} mejores trades aportan este % del net total`)}
      ${card('P5 (peor 5%)', usd(td.p5), 'Cola izquierda — si los pierdes, cuánto duele')}
      ${card('P95 (mejor 5%)', usd(td.p95), 'Cola derecha — máximo win típico')}
      ${card('Best / Worst', `${usd(td.max)} / ${usd(td.min)}`, 'Trade más grande arriba y abajo')}
    </div>
    <p class="muted-note">Una cola derecha enorme (LOTTERY) implica que la rentabilidad en cuenta real es frágil: si el broker recorta esos outliers (slippage, gaps, requotes), el net colapsa. Bots <strong>GRINDER</strong> son los preferidos para promoción — pequeñas ganancias consistentes que la realidad real no puede destruir.</p>
  `;
}

async function drawViolinChart(b) {
  const canvas = document.getElementById('violin-chart');
  if (!canvas) return;
  const td = b.trade_distribution;
  if (!td) return;
  let trades = [];
  try {
    const res = await fetch(`data/bots/${b.vps}/${b.account_login}-${b.magic}.json?t=${Date.now()}`);
    if (res.ok) { const j = await res.json(); trades = (j.trades || []).map(t => t.net).filter(n => typeof n === 'number'); }
  } catch {}
  if (trades.length === 0) { canvas.parentElement.innerHTML = '<div class="empty-state">Sin trades disponibles.</div>'; return; }

  const W = canvas.clientWidth || 700;
  const H = 240;
  canvas.width = W * (window.devicePixelRatio || 1);
  canvas.height = H * (window.devicePixelRatio || 1);
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

  const padL = 60, padR = 30, padT = 20, padB = 36;
  const w = W - padL - padR, h = H - padT - padB;

  const xMin = td.min, xMax = td.max;
  const xRange = xMax - xMin || 1;
  const xPad = xRange * 0.05;
  const x0 = xMin - xPad, x1 = xMax + xPad;
  const xToPx = (v) => padL + ((v - x0) / (x1 - x0)) * w;

  // KDE Gaussian, Silverman bandwidth from backend (or recompute)
  const bw = td.kde_bandwidth || (1.06 * td.stdev * Math.pow(trades.length, -0.2)) || 1;
  const NBINS = 220;
  const dens = new Array(NBINS).fill(0);
  const xs = new Array(NBINS);
  for (let i = 0; i < NBINS; i++) xs[i] = x0 + (i / (NBINS - 1)) * (x1 - x0);
  const norm = 1 / (Math.sqrt(2 * Math.PI) * bw);
  for (const t of trades) {
    for (let i = 0; i < NBINS; i++) {
      const z = (xs[i] - t) / bw;
      dens[i] += norm * Math.exp(-0.5 * z * z);
    }
  }
  let maxD = 0;
  for (const d of dens) if (d > maxD) maxD = d;
  if (maxD <= 0) maxD = 1;
  const cy = padT + h / 2;
  const halfH = h * 0.42;
  const dToOffset = (d) => (d / maxD) * halfH;

  // BG
  ctx.fillStyle = 'rgba(10,11,18,0.5)';
  ctx.fillRect(padL, padT, w, h);

  // Zero line
  if (x0 < 0 && x1 > 0) {
    const xZero = xToPx(0);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xZero, padT); ctx.lineTo(xZero, padT + h); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Violin polygon — mirror upper/lower around cy
  ctx.beginPath();
  for (let i = 0; i < NBINS; i++) {
    const px = xToPx(xs[i]);
    const py = cy - dToOffset(dens[i]);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  for (let i = NBINS - 1; i >= 0; i--) {
    const px = xToPx(xs[i]);
    const py = cy + dToOffset(dens[i]);
    ctx.lineTo(px, py);
  }
  ctx.closePath();

  // Gradient fill: red side (negative) → green side (positive)
  const grad = ctx.createLinearGradient(padL, 0, padL + w, 0);
  if (x0 < 0 && x1 > 0) {
    const tZero = (0 - x0) / (x1 - x0);
    grad.addColorStop(0, 'rgba(255,107,139,0.55)');
    grad.addColorStop(Math.max(0, tZero - 0.02), 'rgba(255,107,139,0.4)');
    grad.addColorStop(Math.min(1, tZero + 0.02), 'rgba(61,220,151,0.4)');
    grad.addColorStop(1, 'rgba(61,220,151,0.55)');
  } else {
    grad.addColorStop(0, td.mean >= 0 ? 'rgba(61,220,151,0.45)' : 'rgba(255,107,139,0.45)');
    grad.addColorStop(1, td.mean >= 0 ? 'rgba(61,220,151,0.65)' : 'rgba(255,107,139,0.65)');
  }
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Inner box (P25–P75)
  const xP25 = xToPx(td.p25), xP75 = xToPx(td.p75);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(xP25, cy - 6, xP75 - xP25, 12);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.strokeRect(xP25, cy - 6, xP75 - xP25, 12);

  // Median line
  const xMed = xToPx(td.median);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.moveTo(xMed, cy - 12); ctx.lineTo(xMed, cy + 12); ctx.stroke();

  // P5/P95 whiskers
  for (const [v, lab] of [[td.p5, 'P5'], [td.p95, 'P95']]) {
    const px = xToPx(v);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(px, cy - 10); ctx.lineTo(px, cy + 10); ctx.stroke();
    ctx.fillStyle = '#9aa3bb';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(lab, px, padT + h + 18);
  }

  // X-axis ticks (5 ticks)
  ctx.fillStyle = '#6b7390';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const v = x0 + (i / 5) * (x1 - x0);
    const px = padL + (i / 5) * w;
    ctx.fillText(`$${v.toFixed(2)}`, px, padT + h + 30);
  }
  // Y-axis label
  ctx.save();
  ctx.translate(18, padT + h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#9aa3bb';
  ctx.font = '11px Inter, sans-serif';
  ctx.fillText('densidad de trades', 0, 0);
  ctx.restore();
}

// =====================================================================
// ⚖️ ADVERSARIAL PAIR FINDER — top-3 partners
// =====================================================================
function renderPairsPanel(b) {
  const pr = b.pair_recommendations;
  if (!pr) return `<div class="empty-state">⚠️ Pair Finder solo disponible para bots READY/NEAR (este es ${b.promotion_status || '—'}).</div>`;
  const usd = (n) => n == null ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const cards = pr.partners.map((p, idx) => {
    const gainCls = (p.diversification_gain_pct || 0) > 0 ? 'positive' : 'profit-negative';
    const rhoCls = p.rho == null ? '' : p.rho < -0.2 ? 'positive' : p.rho < 0.2 ? 'warning' : 'profit-negative';
    const rhoLabel = p.rho == null ? '—' : p.rho < -0.2 ? '🟢 hedge' : p.rho < 0.2 ? '🟡 indep.' : '🔴 redundante';
    const c = p.combined || {};
    return `
      <div class="pair-card pair-card-${idx + 1}">
        <div class="pair-card-header">
          <div class="pair-rank">#${idx + 1}</div>
          <div>
            <div class="pair-magic">${p.magic} <span class="status-pill status-${(p.status||'').toLowerCase()}">${p.status}</span></div>
            <div class="pair-sub">${p.symbol || '—'} · ${p.vps} · cuenta ${p.login} · score ${p.score?.toFixed(1) ?? '—'}</div>
          </div>
        </div>
        <canvas class="pair-canvas" data-pair-idx="${idx}"></canvas>
        <div class="pair-metrics-row">
          <div class="pair-metric"><span>ρ corr</span><strong class="${rhoCls}">${p.rho == null ? '—' : p.rho.toFixed(2)} ${rhoLabel}</strong></div>
          <div class="pair-metric"><span>Combo Calmar</span><strong>${c.calmar?.toFixed(2) ?? '—'}</strong></div>
          <div class="pair-metric"><span>Combo Sharpe</span><strong>${c.sharpe?.toFixed(2) ?? '—'}</strong></div>
          <div class="pair-metric"><span>Combo DD</span><strong class="profit-negative">${usd(c.max_dd)}</strong></div>
          <div class="pair-metric pair-metric-gain"><span>Diversification gain</span><strong class="${gainCls}">${p.diversification_gain_pct == null ? '—' : (p.diversification_gain_pct > 0 ? '+' : '') + p.diversification_gain_pct.toFixed(1) + '%'}</strong></div>
        </div>
      </div>`;
  }).join('');
  return `
    <div class="pairs-hero">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">⚖️ Adversarial Pair Finder · evaluó ${pr.n_evaluated} candidatos · top-3 partners</div>
        <div class="pairs-hero-title">No promuevas un bot solo — promuévelo en par</div>
        <div class="pairs-hero-sub">Solo Calmar de este bot: <strong>${pr.solo.calmar?.toFixed(2) ?? '—'}</strong> · DD solo: <strong class="profit-negative">${usd(pr.solo.max_dd)}</strong>. Cada par calculado al 50/50 sobre daily_net. Ranking: diversificación gain ↓ + ρ asc.</div>
      </div>
    </div>
    <div class="pairs-grid">${cards}</div>
    <p class="muted-note">${pr.method} Una <strong>diversification gain positiva</strong> indica que el par mejora el Calmar combinado vs cualquiera de los dos solo — eso es la verdadera firma de diversificación. ρ negativo = hedge real (cuando uno cae, el otro sube).</p>
  `;
}

async function drawPairsCharts(b) {
  const pr = b.pair_recommendations;
  if (!pr) return;
  // Load main bot series
  const baseUrl = (k) => `data/bots/${k.vps}/${k.login}-${k.magic}.json?t=${Date.now()}`;
  const aSeries = await loadDailyNetMap({ vps: b.vps, login: b.account_login, magic: b.magic });
  if (!aSeries) return;
  for (let i = 0; i < pr.partners.length; i++) {
    const p = pr.partners[i];
    const canvas = document.querySelector(`.pair-canvas[data-pair-idx="${i}"]`);
    if (!canvas) continue;
    const bSeries = await loadDailyNetMap(p);
    if (!bSeries) continue;
    drawPairCanvas(canvas, aSeries, bSeries);
  }
}

async function loadDailyNetMap({ vps, login, magic }) {
  try {
    const res = await fetch(`data/bots/${vps}/${login}-${magic}.json?t=${Date.now()}`);
    if (!res.ok) return null;
    const j = await res.json();
    const map = {};
    for (const row of (j.daily_equity_series || [])) {
      if (row.date) map[row.date] = row.daily_net || 0;
    }
    return map;
  } catch { return null; }
}

function drawPairCanvas(canvas, aMap, bMap) {
  const W = canvas.clientWidth || 380;
  const H = 130;
  canvas.width = W * (window.devicePixelRatio || 1);
  canvas.height = H * (window.devicePixelRatio || 1);
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  const dates = Array.from(new Set([...Object.keys(aMap), ...Object.keys(bMap)])).sort();
  if (dates.length < 5) return;
  let cumA = 0, cumB = 0, cumC = 0;
  const a = [], bArr = [], cArr = [];
  for (const d of dates) {
    cumA += aMap[d] || 0;
    cumB += bMap[d] || 0;
    cumC += 0.5 * (aMap[d] || 0) + 0.5 * (bMap[d] || 0);
    a.push(cumA); bArr.push(cumB); cArr.push(cumC);
  }
  const all = [...a, ...bArr, ...cArr];
  const yMin = Math.min(0, ...all);
  const yMax = Math.max(0, ...all);
  const yRange = (yMax - yMin) || 1;
  const padL = 8, padR = 8, padT = 8, padB = 18;
  const w = W - padL - padR, h = H - padT - padB;
  const xToPx = (i) => padL + (i / (dates.length - 1)) * w;
  const yToPx = (v) => padT + h - ((v - yMin) / yRange) * h;
  // Zero line
  if (yMin < 0 && yMax > 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(padL, yToPx(0)); ctx.lineTo(padL + w, yToPx(0)); ctx.stroke();
    ctx.setLineDash([]);
  }
  const drawLine = (data, color, width, alpha) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const px = xToPx(i), py = yToPx(data[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  };
  drawLine(a, '#7c9cff', 1, 0.55);     // bot A solo (subtle)
  drawLine(bArr, '#ffc36b', 1, 0.55);  // bot B solo (subtle)
  drawLine(cArr, '#3ddc97', 2.4, 1);   // 50/50 combined (highlighted)
  // Legend
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#7c9cff'; ctx.fillText('— A solo', padL, H - 6);
  ctx.fillStyle = '#ffc36b'; ctx.fillText('— B solo', padL + 60, H - 6);
  ctx.fillStyle = '#3ddc97'; ctx.fillText('— A+B (50/50)', padL + 120, H - 6);
}

// =====================================================================
// 🕰️ TIME MACHINE — retroactive promotion replay
// =====================================================================
const tmState = { capital: 10000, daily: null, dates: null, cum: null, idx: 0 };

function renderTimeMachinePanel(b) {
  return `
    <div class="tm-hero">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">🕰️ Time Machine · simulación retroactiva con cuenta real</div>
        <div class="tm-hero-title">¿Qué pasaría si lo prometía en X fecha con Y capital?</div>
        <div class="tm-hero-sub">Mueve el slider para escoger la fecha de promoción hipotética. La curva muestra cómo evolucionaría tu equity REAL desde ese día hasta hoy, asumiendo que el bot reproduce sus daily_net históricos sobre tu capital inicial.</div>
      </div>
    </div>
    <div class="tm-controls">
      <label class="tm-label">Capital inicial:
        <input id="tm-capital" type="number" min="1000" max="1000000" step="500" value="10000" />
        <span class="tm-currency">USD</span>
      </label>
      <label class="tm-label tm-slider-label">Fecha de promoción:
        <input id="tm-date" type="range" min="0" max="0" step="1" value="0" />
        <span id="tm-date-display">—</span>
      </label>
    </div>
    <div class="tm-stats">
      <div class="tm-stat">
        <div class="tm-stat-label">Capital inicial</div>
        <div class="tm-stat-value" id="tm-stat-initial">—</div>
        <div class="tm-stat-hint" id="tm-stat-since">—</div>
      </div>
      <div class="tm-stat tm-stat-final">
        <div class="tm-stat-label">Capital HOY</div>
        <div class="tm-stat-value" id="tm-stat-final">—</div>
        <div class="tm-stat-hint" id="tm-stat-pnl">—</div>
      </div>
      <div class="tm-stat">
        <div class="tm-stat-label">Retorno total</div>
        <div class="tm-stat-value" id="tm-stat-return">—</div>
        <div class="tm-stat-hint" id="tm-stat-cagr">—</div>
      </div>
      <div class="tm-stat">
        <div class="tm-stat-label">Max DD durante</div>
        <div class="tm-stat-value" id="tm-stat-dd">—</div>
        <div class="tm-stat-hint">peak-to-trough sobre capital</div>
      </div>
    </div>
    <div class="tm-canvas-wrap"><canvas id="tm-chart"></canvas></div>
    <p class="muted-note">⚠️ Simulación: asume que el bot operaría idéntico sobre tu capital. No re-escala lots a tu balance ni considera margin/slippage diferentes. Es un <strong>recall histórico</strong>, no una predicción. Útil para validar arrepentimiento ("si hubiera promovido este bot el día X, hoy tendría $Y").</p>
  `;
}

async function initTimeMachine(b) {
  const dateInput = document.getElementById('tm-date');
  const capInput = document.getElementById('tm-capital');
  const display = document.getElementById('tm-date-display');
  if (!dateInput || !capInput) return;
  let daily = null;
  try {
    const res = await fetch(`data/bots/${b.vps}/${b.account_login}-${b.magic}.json?t=${Date.now()}`);
    if (res.ok) { const j = await res.json(); daily = j.daily_equity_series || []; }
  } catch {}
  if (!daily || daily.length < 2) {
    document.querySelector('.tm-canvas-wrap').innerHTML = '<div class="empty-state">Sin daily_equity_series suficiente.</div>';
    return;
  }
  tmState.daily = daily;
  tmState.dates = daily.map(p => p.date);
  // Allow promotion at any historical date EXCEPT the very last (need ≥1 day forward)
  const maxIdx = Math.max(0, daily.length - 2);
  dateInput.min = 0;
  dateInput.max = maxIdx;
  dateInput.value = 0;  // earliest date
  const update = () => {
    const idx = parseInt(dateInput.value, 10) || 0;
    const cap = Math.max(1000, parseFloat(capInput.value) || 10000);
    tmState.idx = idx;
    tmState.capital = cap;
    if (display) display.textContent = tmState.dates[idx];
    drawTimeMachine(b);
  };
  dateInput.oninput = update;
  capInput.oninput = update;
  update();
}

function drawTimeMachine(b) {
  const canvas = document.getElementById('tm-chart');
  if (!canvas || !tmState.daily) return;
  const startIdx = tmState.idx;
  const cap = tmState.capital;
  const slice = tmState.daily.slice(startIdx);
  if (slice.length < 2) return;
  // Compute equity from selected start date forward
  let cum = 0, peak = 0, maxDD = 0;
  const labels = [];
  const eq = [];
  const ddLine = [];
  for (const p of slice) {
    cum += p.daily_net || 0;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    labels.push(new Date(p.date));
    eq.push(round2(cap + cum));
    ddLine.push(-round2(dd));
  }
  const finalEquity = cap + cum;
  const totalRet = (cum / cap) * 100;
  const days = slice.length;
  const cagr = days >= 30 ? (Math.pow(finalEquity / cap, 365 / days) - 1) * 100 : null;
  const ddPct = (maxDD / cap) * 100;
  // Update stats
  const setText = (id, txt, cls) => { const el = document.getElementById(id); if (el) { el.textContent = txt; if (cls != null) el.className = el.className.replace(/(positive|profit-negative|negative|warning)/g, '') + ' ' + cls; } };
  setText('tm-stat-initial', fmt.usd(cap, true));
  setText('tm-stat-since', `desde ${tmState.dates[startIdx]}`);
  setText('tm-stat-final', fmt.usd(finalEquity, true), finalEquity >= cap ? 'positive' : 'profit-negative');
  setText('tm-stat-pnl', `${cum >= 0 ? '+' : ''}${fmt.usd(cum, true)} en ${days} días`);
  setText('tm-stat-return', `${totalRet >= 0 ? '+' : ''}${totalRet.toFixed(2)}%`, totalRet >= 0 ? 'positive' : 'profit-negative');
  setText('tm-stat-cagr', cagr != null ? `CAGR ${cagr >= 0 ? '+' : ''}${cagr.toFixed(2)}%` : '—');
  setText('tm-stat-dd', `${ddPct.toFixed(2)}%`);
  // Chart
  if (modalState.charts.main) { modalState.charts.main.destroy(); modalState.charts.main = null; }
  modalState.charts.main = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `Equity simulada (${fmt.usd(cap, true)} → ${fmt.usd(finalEquity, true)})`,
          data: eq,
          borderColor: finalEquity >= cap ? '#3ddc97' : '#ff6b8b',
          backgroundColor: finalEquity >= cap ? 'rgba(61,220,151,0.18)' : 'rgba(255,107,139,0.18)',
          fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2.4,
          yAxisID: 'y',
        },
        {
          label: `Drawdown (max ${ddPct.toFixed(1)}%)`,
          data: ddLine,
          borderColor: 'rgba(255,107,139,0.55)',
          backgroundColor: 'rgba(255,107,139,0.08)',
          fill: true, tension: 0, pointRadius: 0, borderWidth: 1,
          yAxisID: 'y2', borderDash: [4, 3],
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 350 },
      plugins: {
        legend: { display: true, labels: { color: '#9aa3bb', font: { size: 11 } } },
        tooltip: {
          backgroundColor: 'rgba(10,11,18,0.95)',
          callbacks: { label: (it) => it.dataset.yAxisID === 'y2' ? `DD ${it.raw}%` : `${fmt.usd(it.raw, true)}` },
        },
      },
      scales: {
        x: { type: 'time', time: { unit: labels.length > 200 ? 'month' : 'week' }, ticks: { color: '#6b7390', font: { size: 10 } }, grid: { display: false } },
        y: { position: 'left', ticks: { color: '#6b7390', callback: (v) => fmt.usd(v, true) }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y2: { position: 'right', ticks: { color: '#6b7390', callback: (v) => `${v}` }, grid: { display: false }, max: 0 },
      },
    },
  });
}

// =====================================================================
// 📈 SURVIVAL CURVE (Kaplan-Meier cohort mortality)
// =====================================================================
let _survivalCache = null;
async function loadSurvivalTable() {
  if (_survivalCache) return _survivalCache;
  try {
    const res = await fetch(`data/survival.json?t=${Date.now()}`);
    if (!res.ok) return null;
    _survivalCache = await res.json();
    return _survivalCache;
  } catch { return null; }
}

function renderSurvivalPanel(b) {
  return `
    <div class="surv-hero">
      <div class="stress-hero-aurora"></div>
      <div class="stress-hero-content">
        <div class="stress-hero-eyebrow">📈 Análisis de supervivencia · Kaplan-Meier · base rate empírico</div>
        <div class="surv-hero-title">¿Cuántos bots como este sobreviven?</div>
        <div class="surv-hero-sub" id="surv-hero-sub">Cargando cohorte…</div>
      </div>
    </div>
    <div class="surv-canvas-wrap"><canvas id="surv-chart"></canvas></div>
    <div class="surv-table-wrap" id="surv-table-wrap"></div>
    <p class="muted-note">Curva escalonada Kaplan-Meier: P(T>t) = probabilidad de seguir <strong>vivo</strong> a t meses. <strong>Muerte</strong> = cualquiera de: decay_flag, drift severo (≥1.3), net negativo con ≥3 meses, o DD&gt;20% balance. Bandas = 95% CI (Greenwood log-log). El base rate empírico de la cohorte es la única defensa real contra el sesgo de selección sobre 218 bots: <strong>"este bot puede tener score 90, pero ¿cuántos bots con score 90 mueren a los 6 meses?"</strong>.</p>
  `;
}

async function drawSurvivalChart(b) {
  const surv = await loadSurvivalTable();
  if (!surv) {
    const wrap = document.querySelector('.surv-canvas-wrap');
    if (wrap) wrap.innerHTML = '<div class="empty-state">⚠️ survival.json no disponible (¿pipeline aún sin correr?).</div>';
    return;
  }
  const canvas = document.getElementById('surv-chart');
  if (!canvas) return;
  const botKey = `${b.vps}-${b.account_login}-${b.magic}`;
  const bucketId = (surv.bot_to_bucket || {})[botKey];
  const overall = surv.curves.overall;
  const cohort = bucketId ? surv.curves[bucketId] : null;
  const sym = (b.symbols || [])[0] ? (b.symbols[0].split('.')[0].toUpperCase()) : null;
  const symCurve = sym ? surv.curves[`sym_${sym}`] : null;

  const sub = document.getElementById('surv-hero-sub');
  if (sub) {
    const lookup = (curve, t) => {
      if (!curve) return null;
      let last = curve.curve[0];
      for (const pt of curve.curve) { if (pt.t <= t) last = pt; else break; }
      return last;
    };
    const m6 = lookup(cohort || overall, 6), m12 = lookup(cohort || overall, 12);
    const cohortLab = cohort ? cohort.label : overall.label;
    sub.innerHTML = `
      Tu cohorte: <strong>${cohortLab}</strong> · n=${(cohort||overall).n} (${(cohort||overall).n_dead} muertos)<br>
      Supervivencia a 6 meses: <strong>${m6 ? (m6.S * 100).toFixed(0) : '—'}%</strong> ·
      a 12 meses: <strong>${m12 ? (m12.S * 100).toFixed(0) : '—'}%</strong>
    `;
  }

  // Build datasets
  const buildPoints = (curve) => (curve?.curve || []).map(p => ({ x: p.t, y: p.S * 100 }));
  const buildBand = (curve, side) => (curve?.curve || []).map(p => ({ x: p.t, y: (side === 'lo' ? p.ci_lo : p.ci_hi) * 100 }));

  const datasets = [];
  if (cohort) {
    datasets.push({
      label: `CI 95 lo · ${cohort.label}`,
      data: buildBand(cohort, 'lo'),
      borderColor: 'rgba(61,220,151,0.0)',
      backgroundColor: 'rgba(61,220,151,0.0)',
      fill: false, pointRadius: 0, stepped: true, borderWidth: 0,
    });
    datasets.push({
      label: `CI 95 hi · ${cohort.label}`,
      data: buildBand(cohort, 'hi'),
      borderColor: 'rgba(61,220,151,0.0)',
      backgroundColor: 'rgba(61,220,151,0.18)',
      fill: '-1', pointRadius: 0, stepped: true, borderWidth: 0,
    });
    datasets.push({
      label: `${cohort.label} (tu cohorte · n=${cohort.n})`,
      data: buildPoints(cohort),
      borderColor: '#3ddc97',
      backgroundColor: 'rgba(61,220,151,0.0)',
      fill: false, pointRadius: 3, pointBackgroundColor: '#3ddc97',
      stepped: true, borderWidth: 2.6,
    });
  }
  datasets.push({
    label: `Overall (n=${overall.n})`,
    data: buildPoints(overall),
    borderColor: 'rgba(124,156,255,0.85)',
    fill: false, pointRadius: 0, stepped: true, borderWidth: 1.8, borderDash: [4, 4],
  });
  if (symCurve && symCurve !== cohort) {
    datasets.push({
      label: `${symCurve.label} (n=${symCurve.n})`,
      data: buildPoints(symCurve),
      borderColor: 'rgba(255,195,107,0.85)',
      fill: false, pointRadius: 0, stepped: true, borderWidth: 1.8, borderDash: [2, 3],
    });
  }
  if (modalState.charts.main) { modalState.charts.main.destroy(); modalState.charts.main = null; }
  modalState.charts.main = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: {
        legend: { display: true, labels: { color: '#9aa3bb', font: { size: 11 }, filter: (item) => !item.text.startsWith('CI 95') } },
        tooltip: {
          backgroundColor: 'rgba(10,11,18,0.95)',
          callbacks: { label: (it) => `${it.dataset.label}: ${it.raw.y.toFixed(1)}% vivos a ${it.raw.x.toFixed(0)}m` },
        },
      },
      scales: {
        x: { type: 'linear', title: { display: true, text: 'Meses activos', color: '#9aa3bb' }, ticks: { color: '#6b7390', stepSize: 3 }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { min: 0, max: 100, title: { display: true, text: 'P(T > t) · supervivencia (%)', color: '#9aa3bb' }, ticks: { color: '#6b7390', callback: (v) => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    },
  });

  // Bucket breakdown table
  const wrap = document.getElementById('surv-table-wrap');
  if (wrap) {
    const buckets = (surv.buckets || []).map(id => surv.curves[id]).filter(Boolean);
    const rows = buckets.map(c => {
      const lookup = (t) => { let last = c.curve[0]; for (const pt of c.curve) { if (pt.t <= t) last = pt; else break; } return last; };
      const m3 = lookup(3), m6 = lookup(6), m12 = lookup(12), m18 = lookup(18);
      const isMine = bucketId && c === cohort;
      return `<tr class="${isMine ? 'surv-row-mine' : ''}">
        <td>${isMine ? '👈 ' : ''}${c.label}</td>
        <td class="num">${c.n}</td>
        <td class="num">${c.n_dead}</td>
        <td class="num">${m3 ? (m3.S * 100).toFixed(0) + '%' : '—'}</td>
        <td class="num">${m6 ? (m6.S * 100).toFixed(0) + '%' : '—'}</td>
        <td class="num">${m12 ? (m12.S * 100).toFixed(0) + '%' : '—'}</td>
        <td class="num">${m18 ? (m18.S * 100).toFixed(0) + '%' : '—'}</td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `
      <table class="surv-table">
        <thead>
          <tr><th>Cohorte (score bucket)</th><th class="num">n</th><th class="num">muertos</th><th class="num">3m</th><th class="num">6m</th><th class="num">12m</th><th class="num">18m</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
}

// =====================================================================
// 🧬 BOT DNA CARD (Decision Cockpit imprimible)
// =====================================================================
function dnaSemaphore(value, levels) {
  // levels = [okMin, cautionMin]; below cautionMin → STOP
  if (value == null) return { icon: '—', cls: 'dna-na', label: 'sin datos' };
  if (value >= levels[0]) return { icon: '✅', cls: 'dna-ok', label: 'OK' };
  if (value >= levels[1]) return { icon: '⚠️', cls: 'dna-caution', label: 'CAUTION' };
  return { icon: '🛑', cls: 'dna-stop', label: 'STOP' };
}

function dnaSemaphoreReverse(value, levels) {
  // For metrics where lower is better (e.g. DD%, decay)
  if (value == null) return { icon: '—', cls: 'dna-na', label: 'sin datos' };
  if (value <= levels[0]) return { icon: '✅', cls: 'dna-ok', label: 'OK' };
  if (value <= levels[1]) return { icon: '⚠️', cls: 'dna-caution', label: 'CAUTION' };
  return { icon: '🛑', cls: 'dna-stop', label: 'STOP' };
}

function dnaVerdict(score, status, stops, cautions) {
  if (stops >= 1) return { label: 'REJECT', cls: 'dna-verdict-stop', desc: 'Una o más banderas STOP — no promover.' };
  if (status === 'NO') return { label: 'REJECT', cls: 'dna-verdict-stop', desc: 'No pasa gating duro de Promotion Score.' };
  if (status === 'READY' && cautions === 0) return { label: 'PROMOTE', cls: 'dna-verdict-go', desc: 'READY sin cautions — listo para capital real.' };
  if (status === 'READY') return { label: 'PROMOTE WITH CAUTION', cls: 'dna-verdict-warn', desc: 'READY pero con banderas CAUTION — supervisar de cerca.' };
  if (status === 'NEAR') return { label: 'HOLD', cls: 'dna-verdict-hold', desc: 'NEAR — esperar otro mes de tracking antes de promover.' };
  return { label: 'HOLD', cls: 'dna-verdict-hold', desc: 'No es candidato aún — seguir en demo.' };
}

function findCorrelatedPeers(b) {
  const c = state.correlations;
  if (!c || !c.matrix || !c.bots) return null;
  const myKey = `${b.vps}-${b.account_login}-${b.magic}`;
  const myIdx = c.bots.findIndex(x => x.key === myKey);
  if (myIdx < 0) return null;
  const peers = [];
  for (let j = 0; j < c.bots.length; j++) {
    if (j === myIdx) continue;
    const v = c.matrix[myIdx]?.[j];
    if (v == null) continue;
    peers.push({ peer: c.bots[j], rho: v });
  }
  peers.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
  return peers.slice(0, 3);
}

function renderDNACard(b) {
  if (!b) return '<div class="empty-state">No hay bot seleccionado.</div>';
  const symbols = (b.symbols || []).map(s => s.replace(/\.b$/, '')).join(', ') || '?';
  const months = b.months_active || 0;
  const days = b.first_trade && b.last_trade ?
    Math.max(1, Math.round((new Date(b.last_trade) - new Date(b.first_trade)) / 86400000)) : null;
  const score = b.promotion_score;
  const status = b.promotion_status || '?';
  const annualizedReturnPct = (b.net_profit && months > 0) ?
    (b.net_profit / Math.max(1, _balanceFor(b))) / (months / 12) * 100 : null;

  // 7 dimensions semaphores
  const dims = [];
  // 1. Return — annualized %
  const sR = dnaSemaphore(annualizedReturnPct, [10, 0]);
  dims.push({ name: 'Return', icon: '💰', val: annualizedReturnPct != null ? `${annualizedReturnPct.toFixed(1)}% / yr` : 'sin datos', sem: sR,
              hint: 'Net anualizado / balance · OK ≥10%, CAUTION ≥0%' });
  // 2. Risk — Calmar + DD%
  const calmar = b.calmar;
  const ddPct = b.dd_pct_of_balance;
  const sRisk = dnaSemaphore(calmar, [1.5, 0.5]);
  const ddOK = ddPct == null ? null : ddPct <= 15;
  const riskLabel = `Calmar ${calmar != null ? calmar.toFixed(2) : '—'}, DD ${ddPct != null ? ddPct.toFixed(1) + '%' : '—'}`;
  dims.push({ name: 'Risk', icon: '⚖️', val: riskLabel, sem: sRisk,
              hint: 'Calmar OK ≥1.5, CAUTION ≥0.5 · DD% ≤15% (gating)' });
  // 3. Decay
  const decayFlag = !!b.decay_flag;
  const decayRatio = b.decay_ratio;
  const sDecay = decayFlag ? { icon: '🛑', cls: 'dna-stop', label: 'STOP' }
                : decayRatio == null ? { icon: '—', cls: 'dna-na', label: '—' }
                : decayRatio >= 0.7 ? { icon: '✅', cls: 'dna-ok', label: 'OK' }
                : decayRatio >= 0.4 ? { icon: '⚠️', cls: 'dna-caution', label: 'CAUTION' }
                : { icon: '🛑', cls: 'dna-stop', label: 'STOP' };
  dims.push({ name: 'Decay', icon: '📉', val: decayFlag ? '⚠ DECAY DETECTADO' : `Ratio ${decayRatio != null ? decayRatio.toFixed(2) : '—'}`,
              sem: sDecay, hint: 'Pendiente reciente vs lifetime · OK ≥0.7, CAUTION ≥0.4' });
  // 4. Régimen
  const reg = b.regime || {};
  const robust = reg.robustness_score;
  const sReg = dnaSemaphore(robust, [0.7, 0.4]);
  dims.push({ name: 'Régimen', icon: '🌊', val: robust != null ? `Robust ${robust.toFixed(2)}` : 'sin datos',
              sem: sReg, hint: 'Robustez temporal (DoW/hour/duration) · OK ≥0.7' });
  // 5. Capacity
  const cap = b.capacity?.capacity_usd;
  const sCap = dnaSemaphore(cap, [50000, 10000]);
  dims.push({ name: 'Capacity', icon: '⚙️', val: cap != null ? `Escala a ${fmt.usd(cap)}` : 'sin datos',
              sem: sCap, hint: 'USD escalable antes de slippage · OK ≥$50K' });
  // 6. Correlation (peer redundancy)
  const peers = findCorrelatedPeers(b);
  const maxRho = peers && peers.length ? Math.abs(peers[0].rho) : null;
  const sCorr = maxRho == null ? { icon: '—', cls: 'dna-na', label: '—' }
              : maxRho < 0.5 ? { icon: '✅', cls: 'dna-ok', label: 'OK' }
              : maxRho < 0.7 ? { icon: '⚠️', cls: 'dna-caution', label: 'CAUTION' }
              : { icon: '🛑', cls: 'dna-stop', label: 'STOP' };
  const corrLabel = peers && peers.length ? `ρ máx ${peers[0].rho.toFixed(2)} con magic ${peers[0].peer.magic}` : 'sin pares';
  dims.push({ name: 'Correlación', icon: '🔗', val: corrLabel, sem: sCorr,
              hint: 'Si ρ ≥0.7 con otro bot ya en cartera → redundante' });
  // 7. Sample (CI / trades)
  const ci = b.confidence_intervals;
  const lowConf = ci ? ci.low_confidence : (b.trades < 50 || months < 4);
  const sSample = lowConf ? { icon: '⚠️', cls: 'dna-caution', label: 'CAUTION' }
                : { icon: '✅', cls: 'dna-ok', label: 'OK' };
  dims.push({ name: 'Sample', icon: '📊', val: `${b.trades || 0} trades, ${months} meses`,
              sem: sSample, hint: 'Mínimo 50 trades + 4 meses para CI estrecho' });

  // Battle-tested
  const ev = b.event_stress;
  if (ev) {
    const sBattle = ev.battle_tested ? { icon: '✅', cls: 'dna-ok', label: 'OK' }
                  : ev.n_active >= 1 ? { icon: '⚠️', cls: 'dna-caution', label: 'CAUTION' }
                  : { icon: '⚠️', cls: 'dna-caution', label: 'CAUTION' };
    dims.push({ name: 'Battle-tested', icon: '⚔️', val: `${ev.n_active}/${ev.n_total_events} eventos · ${ev.n_positive} positivos`,
                sem: sBattle, hint: '≥3 eventos macro reales sobrevividos = OK' });
  }

  const stops = dims.filter(d => d.sem.cls === 'dna-stop').length;
  const cautions = dims.filter(d => d.sem.cls === 'dna-caution').length;
  const verdict = dnaVerdict(score, status, stops, cautions);

  const dimsHtml = dims.map(d => `
    <div class="dna-row">
      <div class="dna-row-name"><span class="dna-row-icon">${d.icon}</span>${d.name}</div>
      <div class="dna-row-val">${d.val}</div>
      <div class="dna-row-sem ${d.sem.cls}" title="${d.hint}">${d.sem.icon} ${d.sem.label}</div>
    </div>
  `).join('');

  // Notes (auto-generated from cautions/stops)
  const notes = [];
  if (decayFlag) notes.push('Apagar o re-evaluar — decay activo.');
  if (maxRho != null && maxRho >= 0.7) notes.push(`Si ya hay otro bot en cartera, evita duplicar — ρ ${maxRho.toFixed(2)} con magic ${peers[0].peer.magic}.`);
  if (lowConf) notes.push('Sample chico: las métricas tienen CI ancho — re-evaluar tras 50+ trades.');
  if (ddPct != null && ddPct > 10) notes.push(`Drawdown ${ddPct.toFixed(1)}% del balance — vigilar de cerca tras promover.`);
  if (ev && !ev.battle_tested && ev.n_active === 0) notes.push('Bot demasiado nuevo: no ha vivido ningún tail event macro real — riesgo desconocido.');
  if (!notes.length) notes.push('Sin observaciones — perfil limpio.');

  return `
    <div class="dna-card" id="dna-card-printable">
      <div class="dna-card-head">
        <div class="dna-brand">Kiz Capital LLC · Investment Committee Factsheet</div>
        <div class="dna-meta">${new Date().toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })}</div>
      </div>
      <div class="dna-id">
        <h2>BOT DNA · magic ${b.magic}</h2>
        <div class="dna-id-meta">${(b.vps || '').toUpperCase()} · cuenta ${b.account_login} · ${symbols} · ${months} meses${days ? ` · ${days} días activo` : ''}</div>
      </div>
      <div class="dna-score-block">
        <div class="dna-score-num ${score >= 75 ? 'dna-ok' : score >= 60 ? 'dna-caution' : 'dna-stop'}">${score != null ? score.toFixed(0) : '—'}</div>
        <div class="dna-score-label">Promotion Score</div>
        <div class="dna-status">${statusBadge(status)}</div>
      </div>
      <div class="dna-rows">${dimsHtml}</div>
      <div class="dna-verdict-block ${verdict.cls}">
        <div class="dna-verdict-label">VEREDICTO</div>
        <div class="dna-verdict-value">${verdict.label}</div>
        <div class="dna-verdict-desc">${verdict.desc}</div>
      </div>
      <div class="dna-notes">
        <div class="dna-notes-label">Notas auto-generadas</div>
        <ul class="dna-notes-list">${notes.map(n => `<li>${n}</li>`).join('')}</ul>
      </div>
      <div class="dna-mini-charts">
        <div class="dna-mini"><h4>Equity acumulada</h4><canvas id="dna-mini-equity"></canvas></div>
        <div class="dna-mini"><h4>Drawdown</h4><canvas id="dna-mini-dd"></canvas></div>
        <div class="dna-mini"><h4>P&L mensual</h4><canvas id="dna-mini-monthly"></canvas></div>
      </div>
      <div class="dna-foot">Generado por Battle of Bots · ${state.snapshot?.generated_at ? fmt.dateTime(state.snapshot.generated_at) : ''}</div>
    </div>
  `;
}

function _balanceFor(b) {
  const acc = (state.snapshot?.accounts || []).find(a => a.login === Number(b.account_login || b.login));
  return acc ? acc.balance : 100000;
}

let dnaCharts = { equity: null, dd: null, monthly: null };

async function openDNAModal() {
  if (!modalState.bot) return;
  const overlay = document.getElementById('dna-modal-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  // Connect bot modal + drawer: shrink bot modal to the left so both fit side-by-side.
  // Force `width` directly (not max-width) so the cascade can't override us.
  const botOverlay = document.getElementById('bot-modal-overlay');
  if (botOverlay && !botOverlay.hidden) {
    botOverlay.classList.add('dna-active');
    if (window.innerWidth >= 1100) {
      botOverlay.style.setProperty('justify-content', 'flex-start', 'important');
      botOverlay.style.setProperty('padding-left', '40px', 'important');
      botOverlay.style.setProperty('padding-right', '720px', 'important');
      const botModal = botOverlay.querySelector('.bot-modal');
      if (botModal) {
        const target = window.innerWidth >= 1700 ? 900 : window.innerWidth >= 1500 ? 800 : 640;
        botModal.style.setProperty('width', target + 'px', 'important');
        botModal.style.setProperty('max-width', target + 'px', 'important');
        botModal.style.setProperty('flex', '0 0 ' + target + 'px', 'important');
      }
    }
  }
  const b = findBotInSnapshot(modalState.bot.login, modalState.bot.magic);
  if (!b) {
    document.getElementById('dna-main').innerHTML = '<div class="empty-state">Bot no encontrado en snapshot.</div>';
    return;
  }
  if (!state.correlations) { try { await loadCorrelations(); } catch {} }
  const enriched = { ...b, vps: b.vps || modalState.bot.vps, account_login: b.account_login || modalState.bot.login };
  document.getElementById('dna-main').innerHTML = renderDNACard(enriched);
  setTimeout(() => drawDNAMiniCharts(enriched), 50);
}

function closeDNAModal() {
  const overlay = document.getElementById('dna-modal-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  // Bot modal expands back to its original width — clear all forced styles
  const botOverlay = document.getElementById('bot-modal-overlay');
  if (botOverlay) {
    botOverlay.classList.remove('dna-active');
    botOverlay.style.removeProperty('justify-content');
    botOverlay.style.removeProperty('padding-left');
    botOverlay.style.removeProperty('padding-right');
    const botModal = botOverlay.querySelector('.bot-modal');
    if (botModal) {
      botModal.style.removeProperty('width');
      botModal.style.removeProperty('max-width');
      botModal.style.removeProperty('flex');
    }
  }
  if (dnaCharts.equity) { dnaCharts.equity.destroy(); dnaCharts.equity = null; }
  if (dnaCharts.dd) { dnaCharts.dd.destroy(); dnaCharts.dd = null; }
  if (dnaCharts.monthly) { dnaCharts.monthly.destroy(); dnaCharts.monthly = null; }
  const botStillOpen = botOverlay && !botOverlay.hidden;
  if (!botStillOpen) document.body.style.overflow = '';
}

async function drawDNAMiniCharts(b) {
  let daily = [];
  try {
    const res = await fetch(`data/bots/${b.vps}/${b.account_login}-${b.magic}.json?t=${Date.now()}`);
    if (res.ok) {
      const j = await res.json();
      daily = j.daily_equity_series || [];
      // Equity
      const eqCtx = document.getElementById('dna-mini-equity');
      if (eqCtx && daily.length) {
        if (dnaCharts.equity) dnaCharts.equity.destroy();
        dnaCharts.equity = new Chart(eqCtx, {
          type: 'line',
          data: { labels: daily.map(p => p.date), datasets: [{
            data: daily.map(p => p.cum_net || 0), borderColor: '#3ddc97',
            backgroundColor: 'rgba(61,220,151,0.18)', fill: true, pointRadius: 0, tension: 0.25,
          }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
            scales: { x: { display: false }, y: { ticks: { color: '#6b7390', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } } } },
        });
      }
      // DD
      const ddCtx = document.getElementById('dna-mini-dd');
      if (ddCtx && daily.length) {
        if (dnaCharts.dd) dnaCharts.dd.destroy();
        dnaCharts.dd = new Chart(ddCtx, {
          type: 'line',
          data: { labels: daily.map(p => p.date), datasets: [{
            data: daily.map(p => -(p.dd_pct || 0)), borderColor: '#ff6b8b',
            backgroundColor: 'rgba(255,107,139,0.20)', fill: 'origin', pointRadius: 0, tension: 0,
          }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
            scales: { x: { display: false }, y: { ticks: { color: '#6b7390', font: { size: 9 }, callback: (v) => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' }, max: 0 } } },
        });
      }
    }
  } catch {}
  // Monthly bars (from trades)
  if (modalState.trades && modalState.trades.length) {
    const months = monthlyAggregates(modalState.trades);
    const labels = months.map(m => m.key);
    const data = months.map(m => m.net);
    const colors = data.map(v => v >= 0 ? 'rgba(61,220,151,0.7)' : 'rgba(255,107,139,0.7)');
    const monCtx = document.getElementById('dna-mini-monthly');
    if (monCtx) {
      if (dnaCharts.monthly) dnaCharts.monthly.destroy();
      dnaCharts.monthly = new Chart(monCtx, {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 3 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: { x: { display: false }, y: { ticks: { color: '#6b7390', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } } } },
      });
    }
  }
}

function wireDNAModal() {
  const btn = document.getElementById('bot-dna-btn');
  if (btn) btn.addEventListener('click', openDNAModal);
  const close = document.getElementById('dna-modal-close');
  if (close) close.addEventListener('click', closeDNAModal);
  const scrim = document.getElementById('dna-drawer-scrim');
  if (scrim) scrim.addEventListener('click', closeDNAModal);
  const printBtn = document.getElementById('dna-print-btn');
  if (printBtn) printBtn.addEventListener('click', () => { window.print(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('dna-modal-overlay').hidden) { e.stopPropagation(); closeDNAModal(); }
  }, true);
}

// =====================================================================
// ⚔️ BOT COMPARATOR (Head-to-Head Showdown)
// =====================================================================
const COMPARE_MAX = 4;
let compareCharts = { equity: null, dd: null };

function compareKey(vps, login, magic) { return `${vps}-${login}-${magic}`; }

function isInCompareList(vps, login, magic) {
  const key = compareKey(vps, login, magic);
  return !!state.compareList.find(x => x.key === key);
}

function removeFromCompare(vps, login, magic, { silent = false } = {}) {
  const key = compareKey(vps, login, magic);
  const exists = !!state.compareList.find(x => x.key === key);
  if (!exists) return false;
  state.compareList = state.compareList.filter(x => x.key !== key);
  refreshCompareBadge();
  updateCompareAddBtnState();
  refreshCompareCheckboxes();
  refreshCompareFab();
  if (!silent) {
    showToast({
      type: 'info',
      icon: '⚔️',
      title: 'Bot quitado del comparador',
      msg: `magic <strong>${magic}</strong> ya no está en la cola. Quedan <strong>${state.compareList.length}</strong>.`,
    });
  }
  // Re-render comparator if open.
  const overlay = document.getElementById('compare-modal-overlay');
  if (overlay && !overlay.hidden) renderCompare();
  return true;
}

async function addBotToCompareByIds(vps, login, magic, { source = 'modal' } = {}) {
  if (!vps || login == null || magic == null) return false;
  const key = compareKey(vps, login, magic);

  if (state.compareList.find(x => x.key === key)) {
    return removeFromCompare(vps, login, magic);
  }

  if (state.compareList.length >= COMPARE_MAX) {
    showToast({
      type: 'warn',
      icon: '⚠️',
      title: 'Comparador lleno',
      msg: `Máximo <strong>${COMPARE_MAX}</strong> bots simultáneos. Abre el comparador y quita uno antes de añadir otro.`,
      action: { label: '⚔️ Abrir comparador', fn: () => { openCompareModal(); } },
      duration: 6000,
    });
    return false;
  }

  const snapBot = findBotInSnapshot(login, magic);
  let daily = [];
  try {
    const res = await fetch(`data/bots/${vps}/${login}-${magic}.json?t=${Date.now()}`);
    if (res.ok) { const j = await res.json(); daily = j.daily_equity_series || []; }
  } catch {}
  state.compareList.push({ key, vps, login, magic, bot: snapBot, daily });
  refreshCompareBadge();
  updateCompareAddBtnState();
  refreshCompareCheckboxes();
  refreshCompareFab();
  flashCompareBtn();

  const total = state.compareList.length;
  showToast({
    type: 'success',
    icon: '✓',
    title: '¡Añadido al comparador!',
    msg: `magic <strong>${magic}</strong> en cola${source === 'checkbox' ? ' (selección rápida)' : ''}. Hay <strong>${total}</strong> ${total === 1 ? 'bot' : 'bots'} listos para comparar.`,
    action: total >= 2 ? { label: '⚔️ Abrir comparador', fn: () => { openCompareModal(); } } : null,
    duration: 4500,
  });

  // Re-render comparator if it's open.
  const overlay = document.getElementById('compare-modal-overlay');
  if (overlay && !overlay.hidden) renderCompare();
  return true;
}

async function addBotToCompare() {
  if (!modalState.bot) return;
  const btn = document.getElementById('bot-compare-add-btn');
  const { vps, login, magic } = modalState.bot;
  const ok = await addBotToCompareByIds(vps, login, magic, { source: 'modal' });
  if (ok && btn && state.compareList.find(x => x.key === compareKey(vps, login, magic))) {
    btn.classList.remove('is-pop');
    void btn.offsetWidth;
    btn.classList.add('is-pop');
  }
}

function refreshCompareCheckboxes() {
  document.querySelectorAll('input.cmp-check[type="checkbox"]').forEach((cb) => {
    const { vps, login, magic } = cb.dataset;
    if (!vps || !login || !magic) return;
    const want = isInCompareList(vps, login, magic);
    if (cb.checked !== want) cb.checked = want;
  });
}

function refreshCompareFab() {
  const fab = document.getElementById('cmp-fab');
  const fabN = document.getElementById('cmp-fab-n');
  if (!fab || !fabN) return;
  const n = state.compareList.length;
  fabN.textContent = String(n);
  if (n >= 2) {
    if (fab.hidden) {
      fab.hidden = false;
      fab.classList.remove('cmp-fab-pop');
      void fab.offsetWidth;
      fab.classList.add('cmp-fab-pop');
    }
  } else {
    fab.hidden = true;
  }
}

function buildCompareCheckboxCell(vps, login, magic) {
  const checked = isInCompareList(vps, login, magic) ? 'checked' : '';
  return `<td class="cmp-cell"><label class="cmp-check-wrap" title="Añadir/quitar del comparador"><input type="checkbox" class="cmp-check" data-vps="${vps}" data-login="${login}" data-magic="${magic}" ${checked}/><span class="cmp-tick">⚔️</span></label></td>`;
}

function updateCompareAddBtnState() {
  const btn = document.getElementById('bot-compare-add-btn');
  if (!btn || !modalState.bot) return;
  const { vps, login, magic } = modalState.bot;
  const key = compareKey(vps, login, magic);
  const isAdded = !!state.compareList.find(x => x.key === key);
  btn.classList.toggle('is-added', isAdded);
  btn.title = isAdded
    ? 'Bot ya añadido — click para quitar del comparador'
    : 'Añadir este bot al comparador head-to-head';
  // Three states (HTML-rendered spans):
  if (!btn.dataset.statesReady) {
    btn.innerHTML = `
      <span class="btn-add-action">⚔️ Añadir a comparar</span>
      <span class="btn-added-action"><span class="btn-check-burst">✓</span> Añadido al comparador</span>
      <span class="btn-remove-action">✕ Quitar del comparador</span>
    `;
    btn.dataset.statesReady = '1';
  }
}

function refreshCompareBadge() {
  const badge = document.getElementById('compare-badge');
  if (!badge) return;
  const n = state.compareList.length;
  if (n === 0) { badge.hidden = true; badge.textContent = '0'; }
  else { badge.hidden = false; badge.textContent = String(n); }
}

function flashCompareBtn() {
  const btn = document.getElementById('compare-btn');
  if (!btn) return;
  btn.classList.remove('compare-flash');
  void btn.offsetWidth;
  btn.classList.add('compare-flash');
}

function bestColor(i) {
  return ['#3ddc97', '#7c9cff', '#ffb86b', '#c490ff'][i] || '#9aa3bb';
}

async function openCompareModal() {
  const overlay = document.getElementById('compare-modal-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!state.correlations) { try { await loadCorrelations(); } catch {} }
  renderCompare();
}

function closeCompareModal() {
  const overlay = document.getElementById('compare-modal-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  if (compareCharts.equity) { compareCharts.equity.destroy(); compareCharts.equity = null; }
  if (compareCharts.dd) { compareCharts.dd.destroy(); compareCharts.dd = null; }
  if (document.getElementById('bot-modal-overlay').hidden) document.body.style.overflow = '';
}

function compareBest(items, key, higherIsBetter = true) {
  let best = null; let bestVal = null;
  for (let i = 0; i < items.length; i++) {
    const v = items[i].bot?.[key];
    if (v == null) continue;
    if (best == null) { best = i; bestVal = v; continue; }
    if (higherIsBetter ? v > bestVal : v < bestVal) { best = i; bestVal = v; }
  }
  return best;
}

function corrBetween(aKey, bKey) {
  const c = state.correlations;
  if (!c?.matrix || !c?.bots) return null;
  const ai = c.bots.findIndex(x => x.key === aKey);
  const bi = c.bots.findIndex(x => x.key === bKey);
  if (ai < 0 || bi < 0) return null;
  return c.matrix[ai]?.[bi];
}

function renderCompare() {
  const main = document.getElementById('compare-main');
  const list = state.compareList;
  document.getElementById('compare-stat-bots').textContent = `${list.length} / ${COMPARE_MAX}`;
  const pairs = list.length * (list.length - 1) / 2;
  document.getElementById('compare-stat-pairs').textContent = String(pairs);
  let maxRho = null;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const r = corrBetween(list[i].key, list[j].key);
      if (r != null && (maxRho == null || Math.abs(r) > Math.abs(maxRho))) maxRho = r;
    }
  }
  document.getElementById('compare-stat-corrmax').textContent = maxRho != null ? maxRho.toFixed(2) : '—';

  if (list.length === 0) {
    main.innerHTML = `<div class="empty-state compare-empty">
      <h3>⚔️ Aún sin bots en el comparador</h3>
      <p>Abre cualquier bot del dashboard → click "<strong>⚔️ Añadir a comparar</strong>" en el header del modal de auditoría.</p>
      <p>Puedes añadir hasta ${COMPARE_MAX} bots para verlos lado a lado.</p>
    </div>`;
    return;
  }

  // Slots
  const slotsHtml = list.map((it, i) => {
    const b = it.bot || {};
    return `<div class="compare-slot" style="--slot-color:${bestColor(i)}">
      <div class="compare-slot-color" style="background:${bestColor(i)}"></div>
      <div class="compare-slot-id">
        <strong>magic ${it.magic}</strong>
        <small>${it.vps.toUpperCase()} · cuenta ${it.login}</small>
      </div>
      <button class="compare-slot-remove" data-key="${it.key}" title="Quitar">×</button>
    </div>`;
  }).join('');

  // Best-cell metric matrix
  const metrics = [
    { key: 'promotion_score', label: 'Promotion Score', fmt: v => v != null ? v.toFixed(1) : '—', higher: true },
    { key: 'net_profit', label: 'Net 365d', fmt: v => v != null ? fmt.usd(v, true) : '—', higher: true },
    { key: 'calmar', label: 'Calmar', fmt: v => v != null ? v.toFixed(2) : '—', higher: true },
    { key: 'sortino', label: 'Sortino', fmt: v => v != null ? v.toFixed(2) : '—', higher: true },
    { key: 'sharpe_annualized', label: 'Sharpe', fmt: v => v != null ? v.toFixed(2) : '—', higher: true },
    { key: 'profit_factor', label: 'Profit Factor', fmt: v => v != null ? v.toFixed(2) : '—', higher: true },
    { key: 'win_rate_pct', label: 'Win Rate %', fmt: v => v != null ? v.toFixed(1) + '%' : '—', higher: true },
    { key: 'months_positive_pct', label: '% Meses+', fmt: v => v != null ? v.toFixed(1) + '%' : '—', higher: true },
    { key: 'dd_pct_of_balance', label: 'Max DD %', fmt: v => v != null ? v.toFixed(2) + '%' : '—', higher: false },
    { key: 'decay_ratio', label: 'Decay Ratio', fmt: v => v != null ? v.toFixed(2) : '—', higher: true },
    { key: 'months_active', label: 'Meses activo', fmt: v => v != null ? `${v}` : '—', higher: true },
    { key: 'trades', label: 'Trades', fmt: v => v != null ? `${v}` : '—', higher: true },
  ];
  const headerCols = list.map((it, i) => `<th style="color:${bestColor(i)}">magic ${it.magic}</th>`).join('');
  const metricsRows = metrics.map(m => {
    const bestIdx = compareBest(list, m.key, m.higher);
    const cells = list.map((it, i) => {
      const v = it.bot?.[m.key];
      const cls = i === bestIdx ? 'compare-best' : '';
      return `<td class="num ${cls}">${m.fmt(v)}</td>`;
    }).join('');
    return `<tr><td class="compare-metric-label">${m.label}</td>${cells}</tr>`;
  }).join('');

  // Pairwise correlation matrix
  let corrHtml = '';
  if (list.length >= 2) {
    const headers = list.map((it, i) => `<th style="color:${bestColor(i)}">m${it.magic.toString().slice(-4)}</th>`).join('');
    const rows = list.map((it, i) => {
      const cells = list.map((it2, j) => {
        if (i === j) return `<td class="compare-corr-self">—</td>`;
        const r = corrBetween(it.key, it2.key);
        if (r == null) return `<td class="compare-corr-na">—</td>`;
        const cls = Math.abs(r) >= 0.7 ? 'compare-corr-bad' : Math.abs(r) >= 0.4 ? 'compare-corr-med' : 'compare-corr-good';
        return `<td class="${cls}">${r.toFixed(2)}</td>`;
      }).join('');
      return `<tr><th style="color:${bestColor(i)}">m${it.magic.toString().slice(-4)}</th>${cells}</tr>`;
    }).join('');
    corrHtml = `
      <div class="compare-section">
        <h3>🔗 Correlación pairwise</h3>
        <table class="compare-corr-table">
          <thead><tr><th></th>${headers}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="compare-explainer">ρ ≥0.7 = redundante (eliminarías diversificación) · 0.4–0.7 = solapado · &lt;0.4 = independiente</p>
      </div>`;
  }

  // Auto verdict
  let verdictHtml = '';
  if (list.length >= 2) {
    const bestScoreIdx = compareBest(list, 'promotion_score', true);
    const bestCalmarIdx = compareBest(list, 'calmar', true);
    const lines = [];
    lines.push(`🏆 <strong>Mejor Score:</strong> magic <span style="color:${bestColor(bestScoreIdx)}">${list[bestScoreIdx].magic}</span> (${(list[bestScoreIdx].bot?.promotion_score || 0).toFixed(1)})`);
    if (bestCalmarIdx !== bestScoreIdx) {
      lines.push(`⚖️ <strong>Mejor Calmar:</strong> magic <span style="color:${bestColor(bestCalmarIdx)}">${list[bestCalmarIdx].magic}</span> (${(list[bestCalmarIdx].bot?.calmar || 0).toFixed(2)})`);
    }
    if (maxRho != null && Math.abs(maxRho) >= 0.7) {
      lines.push(`⚠️ Pareja con ρ ${maxRho.toFixed(2)} — redundancia: si eliges una, la otra no aporta diversificación.`);
    } else if (maxRho != null) {
      lines.push(`✅ Correlación máxima ${maxRho.toFixed(2)} — los seleccionados son razonablemente independientes.`);
    }
    verdictHtml = `<div class="compare-verdict">${lines.map(l => `<div>${l}</div>`).join('')}</div>`;
  }

  main.innerHTML = `
    <div class="compare-slots">${slotsHtml}</div>
    ${verdictHtml}
    <div class="compare-charts">
      <div class="compare-chart-box">
        <h3>📈 Equity normalizada (base 100 al inicio del bot)</h3>
        <canvas id="compare-equity-chart"></canvas>
      </div>
      <div class="compare-chart-box">
        <h3>🌊 Drawdown (% bajo peak histórico)</h3>
        <canvas id="compare-dd-chart"></canvas>
      </div>
    </div>
    <div class="compare-section">
      <h3>📊 Métricas lado a lado · celda en verde = mejor</h3>
      <table class="compare-metrics-table">
        <thead><tr><th>Métrica</th>${headerCols}</tr></thead>
        <tbody>${metricsRows}</tbody>
      </table>
    </div>
    ${corrHtml}
  `;

  setTimeout(drawCompareCharts, 50);
}

function drawCompareCharts() {
  const list = state.compareList;
  if (list.length === 0) return;

  // Equity normalized to 100 at first day
  const eqCtx = document.getElementById('compare-equity-chart');
  if (eqCtx) {
    if (compareCharts.equity) compareCharts.equity.destroy();
    const datasets = list.map((it, i) => {
      const series = it.daily || [];
      if (!series.length) return null;
      const balance = _balanceFor(it.bot || { account_login: it.login });
      // normalize: 100 + cum_net / balance * 100
      const data = series.map(p => ({ x: new Date(p.date), y: 100 + ((p.cum_net || 0) / Math.max(1, balance)) * 100 }));
      return {
        label: `magic ${it.magic}`,
        data,
        borderColor: bestColor(i),
        backgroundColor: bestColor(i) + '22',
        fill: false, pointRadius: 0, tension: 0.2,
      };
    }).filter(Boolean);
    compareCharts.equity = new Chart(eqCtx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#9aa3bb', font: { size: 11 } } },
          tooltip: { callbacks: { label: (it) => `${it.dataset.label}: ${it.parsed.y.toFixed(2)}` } },
        },
        scales: {
          x: { type: 'time', time: { unit: 'month' }, ticks: { color: '#6b7390', font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: '#6b7390', font: { family: 'JetBrains Mono', size: 10 }, callback: v => `${v}` }, grid: { color: 'rgba(255,255,255,0.04)' } },
        },
      },
    });
  }

  // DD chart
  const ddCtx = document.getElementById('compare-dd-chart');
  if (ddCtx) {
    if (compareCharts.dd) compareCharts.dd.destroy();
    const datasets = list.map((it, i) => {
      const series = it.daily || [];
      if (!series.length) return null;
      const data = series.map(p => ({ x: new Date(p.date), y: -(p.dd_pct || 0) }));
      return {
        label: `magic ${it.magic}`,
        data,
        borderColor: bestColor(i),
        backgroundColor: bestColor(i) + '11',
        fill: false, pointRadius: 0, tension: 0,
      };
    }).filter(Boolean);
    compareCharts.dd = new Chart(ddCtx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#9aa3bb' } } },
        scales: {
          x: { type: 'time', time: { unit: 'month' }, ticks: { color: '#6b7390' }, grid: { display: false } },
          y: { ticks: { color: '#6b7390', callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,0.04)' }, max: 0 },
        },
      },
    });
  }
}

function wireCompareModal() {
  const btn = document.getElementById('compare-btn');
  if (btn) btn.addEventListener('click', openCompareModal);
  const close = document.getElementById('compare-modal-close');
  if (close) close.addEventListener('click', closeCompareModal);
  const overlay = document.getElementById('compare-modal-overlay');
  if (overlay) overlay.addEventListener('click', (e) => { if (e.target.id === 'compare-modal-overlay') closeCompareModal(); });
  const addBtn = document.getElementById('bot-compare-add-btn');
  if (addBtn) addBtn.addEventListener('click', addBotToCompare);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('compare-modal-overlay').hidden) closeCompareModal();
  });
  // Slot remove (delegated)
  document.body.addEventListener('click', (e) => {
    const rm = e.target.closest('.compare-slot-remove');
    if (!rm) return;
    const item = state.compareList.find(x => x.key === rm.dataset.key);
    if (!item) return;
    removeFromCompare(item.vps, item.login, item.magic, { silent: true });
  });

  // Sticky FAB → open comparator.
  const fab = document.getElementById('cmp-fab');
  if (fab) fab.addEventListener('click', () => openCompareModal());

  // Delegated checkbox handler — works on every table render (Real bots,
  // Candidates, Balanced, New, Ranking, Account modal). Stops propagation to
  // avoid triggering the row's openBotModal click.
  document.body.addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb || !cb.classList || !cb.classList.contains('cmp-check')) return;
    const { vps, login, magic } = cb.dataset;
    if (!vps || !login || !magic) return;
    const wantAdd = cb.checked;
    const isAdded = isInCompareList(vps, login, magic);
    if (wantAdd && !isAdded) {
      addBotToCompareByIds(vps, login, magic, { source: 'checkbox' }).then((ok) => {
        if (!ok) cb.checked = false;
      });
    } else if (!wantAdd && isAdded) {
      removeFromCompare(vps, login, magic, { silent: true });
    }
  });
  // Suppress row-open click when a checkbox cell is clicked.
  document.body.addEventListener('click', (e) => {
    if (e.target.closest('.cmp-cell')) e.stopPropagation();
  }, true);
}

// =====================================================================
// 🔔 Toast notifications
// =====================================================================
function _ensureToastStack() {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  return stack;
}

function showToast({ type = 'success', icon = '✓', title = '', msg = '', action = null, duration = 3800 } = {}) {
  const stack = _ensureToastStack();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const iconHtml = `<div class="toast-icon">${icon}</div>`;
  const actionHtml = action ? `<button class="toast-action">${action.label}</button>` : '';
  el.innerHTML = `
    ${iconHtml}
    <div class="toast-body">
      ${title ? `<div class="toast-title">${title}</div>` : ''}
      ${msg ? `<div class="toast-msg">${msg}</div>` : ''}
      ${actionHtml}
    </div>
    <button class="toast-close" aria-label="Cerrar">×</button>
  `;
  stack.appendChild(el);
  const close = () => {
    if (!el.parentNode) return;
    el.classList.add('toast-out');
    setTimeout(() => { try { el.remove(); } catch {} }, 300);
  };
  el.querySelector('.toast-close').addEventListener('click', close);
  if (action && action.fn) {
    el.querySelector('.toast-action').addEventListener('click', () => { try { action.fn(); } catch {} close(); });
  }
  if (duration > 0) setTimeout(close, duration);
  return el;
}

/* ==========================================================================
   Real Daily Suite (v20260704a)
   Experiencia de cuentas reales: ticker de equity en vivo (B1), heatmap
   calendario (B2), mini-cards por bot (B3), carrera semanal (B4), War Room
   (B5), panel "¿Quién ganó HOY?" + digest de ayer + consistencia + alerta de
   forma (C1-C4) y chip "top mover" en el hero (C5).
   Datos: b.real_daily (calculado por post_merge.py, solo bots en cuentas
   reales) + live_real_state (Supabase Realtime, ~3s).
   ========================================================================== */

const realSuite = {
  ticker: { chart: null, points: [], lastDraw: 0, sessionStart: null, sessionHigh: -Infinity },
  race: { timer: null, frames: [] },
  heatmapSel: 'ALL',
  warRoomOpen: false,
  warClock: null,
  topMoverLast: 0,
};

function realBotsWithDaily() {
  const s = state.snapshot;
  if (!s) return [];
  const logins = new Set(((s.real_portfolio || {}).accounts || [])
    .filter(isFundedRealAccount).map(a => a.login));
  return (s.bots || []).filter(b => logins.has(b.account_login) && b.real_daily);
}

// magic -> { float, count, symbol, login } agregado de las posiciones en vivo
function liveFloatByMagic() {
  const map = new Map();
  for (const row of liveState.byLogin.values()) {
    (Array.isArray(row.positions) ? row.positions : []).forEach(p => {
      const m = Number(p.magic) || 0;
      const e = map.get(m) || { float: 0, count: 0, symbol: p.symbol, login: row.login };
      e.float += Number(p.profit) || 0;
      e.count++;
      map.set(m, e);
    });
  }
  return map;
}

function liveTotals() {
  let bal = 0, eq = 0, fl = 0;
  const snapReals = ((state.snapshot && state.snapshot.real_portfolio && state.snapshot.real_portfolio.accounts) || [])
    .filter(isFundedRealAccount);
  if (snapReals.length) {
    for (const a of snapReals) {
      const r = liveState.byLogin.get(a.login);
      bal += Number(r ? r.balance : a.balance) || 0;
      eq += Number(r ? r.equity : a.equity) || 0;
      fl += Number(r ? r.profit : a.profit) || 0;
    }
  } else {
    for (const r of liveState.byLogin.values()) {
      bal += Number(r.balance) || 0;
      eq += Number(r.equity) || 0;
      fl += Number(r.profit) || 0;
    }
  }
  return { bal, eq, fl };
}

function botKey(b) {
  // The same EA (magic) commonly runs on more than one real account —
  // magic alone is NOT a unique row identity across the real fleet.
  return `${b.vps}_${b.account_login}_${b.magic}`;
}

function botLabel(b) {
  const sym = (b.symbols || [])[0] || '';
  return `${sym.replace('.b', '')} · ${String(b.magic).slice(-5)} #${b.account_login}`;
}

function svgSpark(nets, w = 110, h = 26) {
  if (!nets || nets.length < 2) return '<span class="spark-empty">—</span>';
  let cum = 0;
  const ys = nets.map(n => (cum += n));
  const min = Math.min(0, ...ys), max = Math.max(0, ...ys);
  const span = (max - min) || 1;
  const pts = ys.map((y, i) =>
    `${(i / (ys.length - 1) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((y - min) / span) * (h - 4)).toFixed(1)}`
  ).join(' ');
  const up = ys[ys.length - 1] >= 0;
  return `<svg class="mini-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${up ? '#3ddc84' : '#ff6b8b'}" stroke-width="1.6"/>
  </svg>`;
}

const BADGE_META = {
  constante: { label: '🟢 Constante', cls: 'badge-constante', tip: '≥60% de los días activos (últimos 30) en verde' },
  racha:     { label: '🔥 Racha',     cls: 'badge-racha',     tip: '3+ días activos consecutivos en positivo' },
  volatil:   { label: '🌪 Volátil',   cls: 'badge-volatil',   tip: '<45% de días en verde en los últimos 30 días activos' },
  neutro:    { label: '⚪ Neutro',    cls: 'badge-neutro',    tip: 'Sin patrón dominante todavía' },
};

// --- C1 + C2 + C3 + C4: panel diario -------------------------------------

function renderRealDailyPanel() {
  const panel = document.getElementById('real-daily-panel');
  const tbody = document.getElementById('real-daily-tbody');
  if (!panel || !tbody) return;
  const bots = realBotsWithDaily();
  if (!bots.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const floats = liveFloatByMagic();
  const rows = bots.slice().sort((a, b) =>
    (b.real_daily.today_net - a.real_daily.today_net) ||
    (b.real_daily.week_net - a.real_daily.week_net));

  const medal = (i, net) => net > 0 ? (['🥇', '🥈', '🥉'][i] || '') : '';
  tbody.innerHTML = rows.map((b, i) => {
    const d = b.real_daily;
    const lf = floats.get(Number(b.magic));
    const badge = BADGE_META[d.badge] || BADGE_META.neutro;
    const consTip = d.pos_rate_30 != null
      ? `${d.pos_days_30}/${d.active_days_30} días verdes (30d) · expectancy diaria ${fmt.usd(d.expectancy_daily_30 || 0, true)}`
      : 'Sin días activos suficientes';
    return `
      <tr class="${d.out_of_form ? 'row-out-of-form' : ''}" data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}">
        <td class="medal-cell">${medal(i, d.today_net)}</td>
        <td><code>${b.magic}</code> <span class="daily-login">#${b.account_login}</span></td>
        <td>${(b.symbols || []).map(sy => `<span class="symbol-tag">${sy}</span>`).join('')}</td>
        <td class="num daily-today ${d.today_trades ? signedClass(d.today_net) : ''}">${d.today_trades ? fmt.usd(d.today_net, true) : '—'}</td>
        <td class="num">${d.today_trades ? `${d.today_wins}/${d.today_trades}` : '—'}</td>
        <td class="num live-float-cell ${lf ? signedClass(lf.float) : ''}" data-live-float="${b.magic}">${lf ? fmt.usd(lf.float, true) : '—'}</td>
        <td class="num ${signedClass(d.yesterday_net)}">${d.yesterday_trades ? fmt.usd(d.yesterday_net, true) : '—'}</td>
        <td class="num ${signedClass(d.week_net)}">${fmt.usd(d.week_net, true)}</td>
        <td class="num">${d.streak_days >= 2 ? `🔥${d.streak_days}` : (d.streak_days === 1 ? '1' : '—')}</td>
        <td><span class="daily-badge ${badge.cls}" title="${badge.tip} · ${consTip}">${badge.label}</span>
            ${d.pos_rate_30 != null ? `<span class="cons-bar" title="${consTip}"><span style="width:${Math.round(d.pos_rate_30 * 100)}%"></span></span>` : ''}</td>
      </tr>`;
  }).join('');

  // C2 · Digest de ayer
  const dig = document.getElementById('real-daily-digest');
  if (dig) {
    const withY = bots.filter(b => b.real_daily.yesterday_trades > 0);
    if (!withY.length) {
      dig.innerHTML = '<span class="digest-muted">Ayer: sin operaciones cerradas</span>';
    } else {
      const best = withY.reduce((a, b) => b.real_daily.yesterday_net > a.real_daily.yesterday_net ? b : a);
      const worst = withY.reduce((a, b) => b.real_daily.yesterday_net < a.real_daily.yesterday_net ? b : a);
      const tot = withY.reduce((acc, b) => acc + b.real_daily.yesterday_net, 0);
      const totTr = withY.reduce((acc, b) => acc + b.real_daily.yesterday_trades, 0);
      dig.innerHTML = `Ayer: <strong class="${signedClass(tot)}">${fmt.usd(tot, true)}</strong> en ${totTr} trades ·
        mejor <code>${botLabel(best)}</code> <span class="${signedClass(best.real_daily.yesterday_net)}">${fmt.usd(best.real_daily.yesterday_net, true)}</span>${
        worst !== best ? ` · peor <code>${botLabel(worst)}</code> <span class="${signedClass(worst.real_daily.yesterday_net)}">${fmt.usd(worst.real_daily.yesterday_net, true)}</span>` : ''}`;
    }
  }

  // C4 · Alerta de forma
  const banner = document.getElementById('real-form-banner');
  if (banner) {
    const off = bots.filter(b => b.real_daily.out_of_form || (b.drift && b.drift.flag) || b.decay_flag);
    if (!off.length) {
      banner.hidden = true;
    } else {
      banner.hidden = false;
      banner.innerHTML = `⚠️ <strong>Cambio de forma:</strong> ` + off.map(b => {
        const why = b.real_daily.form_reason
          || (b.drift && b.drift.flag ? 'drift detectado (Page-Hinkley)' : 'decay en pendiente reciente');
        return `<code>${botLabel(b)}</code> <span class="form-reason">(${why})</span>`;
      }).join(' · ');
    }
  }
}

// --- B3: mini-cards -------------------------------------------------------

function renderRealBotCards() {
  const wrap = document.getElementById('real-bot-cards');
  if (!wrap) return;
  const bots = realBotsWithDaily();
  if (!bots.length) { wrap.innerHTML = ''; return; }
  const rows = bots.slice().sort((a, b) => b.real_daily.today_net - a.real_daily.today_net);
  const medals = ['🥇', '🥈', '🥉'];
  wrap.innerHTML = rows.map((b, i) => {
    const d = b.real_daily;
    const rate = Math.max(0, Math.min(1, d.pos_rate_30 ?? 0));
    const deg = Math.round(rate * 360);
    const last7 = (d.series_90d || []).slice(-7).map(x => x[1]);
    return `
      <div class="real-bot-card ${d.out_of_form ? 'card-out-of-form' : ''}" data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}" title="Click: auditoría completa del bot">
        <div class="rbc-head">
          <span class="rbc-medal">${d.today_net > 0 ? (medals[i] || '') : ''}</span>
          <span class="rbc-name">${botLabel(b)}</span>
          <span class="rbc-login">#${b.account_login}</span>
        </div>
        <div class="rbc-body">
          <div class="rbc-ring" style="--deg:${deg}deg" title="${Math.round(rate * 100)}% de días verdes (30d activos)">
            <span>${d.pos_rate_30 != null ? Math.round(rate * 100) + '%' : '—'}</span>
          </div>
          <div class="rbc-main">
            <div class="rbc-today ${signedClass(d.today_net)}">${fmt.usd(d.today_net, true)}</div>
            <div class="rbc-sub">hoy · <span class="live-float-inline" data-live-float-inline="${b.magic}">flot. —</span></div>
            <div class="rbc-spark">${svgSpark(last7)}</div>
          </div>
        </div>
        <div class="rbc-foot">
          <span title="Racha de días activos en verde">${d.streak_days >= 2 ? `🔥 ${d.streak_days} días` : (d.streak_days === 1 ? '1 día verde' : 'sin racha')}</span>
          <span class="${signedClass(d.week_net)}" title="Net cerrado últimos 7 días">7d ${fmt.usd(d.week_net, true)}</span>
        </div>
      </div>`;
  }).join('');

  // Click → modal de auditoría existente (misma UX que las tablas)
  wrap.querySelectorAll('.real-bot-card').forEach(card => {
    card.addEventListener('click', () => {
      const { vps, login, magic } = card.dataset;
      try { openBotModal(vps, Number(login), Number(magic)); } catch (e) { console.error(e); }
    });
  });
}

// --- B2: heatmap calendario ----------------------------------------------

function renderRealHeatmap() {
  const panel = document.getElementById('real-heatmap-panel');
  const grid = document.getElementById('heatmap-grid');
  const pillsWrap = document.getElementById('heatmap-pills');
  if (!panel || !grid || !pillsWrap) return;
  const bots = realBotsWithDaily();
  if (!bots.length) { panel.hidden = true; return; }
  panel.hidden = false;

  // Pills: TODOS + one per bot (keyed by vps/login/magic — a magic can repeat
  // across real accounts, so it alone is not a unique selector).
  const options = [{ id: 'ALL', label: 'Portafolio real' }]
    .concat(bots.map(b => ({ id: botKey(b), label: botLabel(b) })));
  if (!options.some(o => o.id === realSuite.heatmapSel)) realSuite.heatmapSel = 'ALL';
  pillsWrap.innerHTML = options.map(o =>
    `<button type="button" class="pill hm-pill ${o.id === realSuite.heatmapSel ? 'active' : ''}" data-hm="${o.id}">${o.label}</button>`
  ).join('');
  pillsWrap.querySelectorAll('.hm-pill').forEach(p => p.addEventListener('click', () => {
    realSuite.heatmapSel = p.dataset.hm;
    renderRealHeatmap();
  }));

  // date -> net for the selection
  const byDate = new Map();
  const src = realSuite.heatmapSel === 'ALL' ? bots : bots.filter(b => botKey(b) === realSuite.heatmapSel);
  src.forEach(b => (b.real_daily.series_90d || []).forEach(([date, net]) => {
    byDate.set(date, (byDate.get(date) || 0) + net);
  }));

  // Scale: symmetric quantiles over |net|
  const abs = [...byDate.values()].map(v => Math.abs(v)).filter(v => v > 0).sort((a, b) => a - b);
  const q = p => abs.length ? abs[Math.min(abs.length - 1, Math.floor(p * abs.length))] : 1;
  const t1 = q(0.33), t2 = q(0.66);
  const cls = v => {
    if (v == null) return 'hm-empty';
    if (v === 0) return 'hm-0';
    const a = Math.abs(v);
    const lvl = a <= t1 ? 1 : a <= t2 ? 2 : 3;
    return (v > 0 ? 'hm-p' : 'hm-n') + lvl;
  };

  // 13 semanas en columnas, semana empieza lunes
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 90);
  while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() - 1);
  const cells = [];
  const monthRow = [];
  let lastMonth = -1;
  for (let wk = new Date(start); wk <= end; wk.setUTCDate(wk.getUTCDate() + 7)) {
    const m = wk.getUTCMonth();
    monthRow.push(m !== lastMonth ? wk.toLocaleDateString('es-ES', { month: 'short', timeZone: 'UTC' }) : '');
    lastMonth = m;
    const col = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(wk); day.setUTCDate(day.getUTCDate() + d);
      if (day > end) { col.push('<span class="hm-cell hm-void"></span>'); continue; }
      const iso = day.toISOString().slice(0, 10);
      const v = byDate.has(iso) ? byDate.get(iso) : null;
      const tip = `${iso} · ${v == null ? 'sin trades' : fmt.usd(v, true)}`;
      col.push(`<span class="hm-cell ${cls(v)}" title="${tip}"></span>`);
    }
    cells.push(`<div class="hm-col">${col.join('')}</div>`);
  }
  grid.innerHTML = `<div class="hm-months">${monthRow.map(m => `<span>${m}</span>`).join('')}</div><div class="hm-weeks">${cells.join('')}</div>`;
}

// --- B4: carrera semanal --------------------------------------------------

function buildRaceFrames() {
  const bots = realBotsWithDaily();
  const cut = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const dates = [...new Set(bots.flatMap(b => (b.real_daily.series_90d || [])
    .map(x => x[0]).filter(d => d >= cut)))].sort();
  if (!dates.length) return [];
  return dates.map(upTo => ({
    date: upTo,
    rows: bots.map(b => ({
      key: botKey(b),
      label: botLabel(b),
      net: (b.real_daily.series_90d || [])
        .filter(([d]) => d >= cut && d <= upTo)
        .reduce((acc, [, n]) => acc + n, 0),
    })).sort((a, b) => b.net - a.net),
  }));
}

function paintRaceFrame(frame) {
  const track = document.getElementById('race-track');
  const dateEl = document.getElementById('race-date');
  if (!track || !frame) return;
  const maxAbs = Math.max(1, ...frame.rows.map(r => Math.abs(r.net)));
  const H = 34;
  track.style.height = `${frame.rows.length * H}px`;
  frame.rows.forEach((r, rank) => {
    let row = track.querySelector(`[data-race="${r.key}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'race-row';
      row.dataset.race = r.key;
      row.innerHTML = `<span class="race-label"></span><span class="race-bar"><span class="race-fill"></span></span><span class="race-net"></span>`;
      track.appendChild(row);
    }
    row.style.transform = `translateY(${rank * H}px)`;
    row.querySelector('.race-label').textContent = `${rank + 1}. ${r.label}`;
    const fill = row.querySelector('.race-fill');
    fill.style.width = `${Math.round(Math.abs(r.net) / maxAbs * 100)}%`;
    fill.classList.toggle('neg', r.net < 0);
    const netEl = row.querySelector('.race-net');
    netEl.textContent = fmt.usd(r.net, true);
    netEl.className = `race-net ${signedClass(r.net)}`;
  });
  if (dateEl) dateEl.textContent = new Date(frame.date + 'T00:00:00Z')
    .toLocaleDateString('es-ES', { weekday: 'long', day: '2-digit', month: 'short', timeZone: 'UTC' });
}

function renderRealRace() {
  const panel = document.getElementById('real-race-panel');
  if (!panel) return;
  const frames = buildRaceFrames();
  realSuite.race.frames = frames;
  if (frames.length < 2) { panel.hidden = true; return; }
  panel.hidden = false;
  paintRaceFrame(frames[frames.length - 1]);
  const btn = document.getElementById('race-replay-btn');
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      if (realSuite.race.timer) { clearInterval(realSuite.race.timer); realSuite.race.timer = null; }
      const fr = realSuite.race.frames;
      let i = 0;
      paintRaceFrame(fr[0]);
      realSuite.race.timer = setInterval(() => {
        i++;
        if (i >= fr.length) { clearInterval(realSuite.race.timer); realSuite.race.timer = null; return; }
        paintRaceFrame(fr[i]);
      }, 900);
    });
  }
}

// --- B1: ticker en vivo ---------------------------------------------------

function ensureTickerChart() {
  if (realSuite.ticker.chart || typeof Chart === 'undefined') return;
  const canvas = document.getElementById('live-ticker-canvas');
  if (!canvas) return;
  realSuite.ticker.chart = new Chart(canvas, {
    type: 'line',
    data: { labels: [], datasets: [{
      data: [], borderColor: '#3ddc84', borderWidth: 1.6, pointRadius: 0,
      fill: true, backgroundColor: 'rgba(61,220,132,0.08)', tension: 0.25,
    }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { intersect: false, mode: 'index' } },
      scales: {
        x: { ticks: { color: '#8b90a7', maxTicksLimit: 8, maxRotation: 0 }, grid: { display: false } },
        y: { ticks: { color: '#8b90a7', callback: v => '$' + Number(v).toLocaleString('en-US') },
             grid: { color: 'rgba(139,144,167,0.12)' } },
      },
    },
  });
}

function tickerPush() {
  const panel = document.getElementById('live-ticker-panel');
  if (!panel) return;
  const { eq, fl } = liveTotals();
  if (!eq) return;
  panel.hidden = false;
  const t = realSuite.ticker;
  const now = Date.now();
  if (!t.sessionStart) {
    t.sessionStart = { ts: now, eq };
    const sess = document.getElementById('live-ticker-session');
    if (sess) sess.textContent = `· sesión desde ${new Date().toLocaleTimeString('es-ES')}`;
  }
  const last = t.points[t.points.length - 1];
  if (!last || now - last.t >= 2500) {
    t.points.push({ t: now, eq });
    if (t.points.length > 2400) t.points.shift();  // ~2h a 3s
  } else {
    last.eq = eq;
  }

  const valEl = document.getElementById('live-ticker-value');
  const deltaEl = document.getElementById('live-ticker-delta');
  if (valEl) {
    const prevText = valEl.textContent;
    valEl.textContent = fmt.usd(eq);
    const delta = eq - t.sessionStart.eq;
    if (deltaEl) {
      deltaEl.textContent = `${fmt.usd(delta, true)} sesión · flotante ${fmt.usd(fl, true)}`;
      deltaEl.className = `live-ticker-delta ${signedClass(delta)}`;
    }
    if (prevText !== valEl.textContent) {
      panel.classList.remove('tick-up', 'tick-down');
      void panel.offsetWidth;  // reinicia la animación
      panel.classList.add(eq >= (t.prevEq ?? eq) ? 'tick-up' : 'tick-down');
    }
    t.prevEq = eq;
  }
  if (eq > t.sessionHigh) {
    t.sessionHigh = eq;
    panel.classList.add('session-high');
    setTimeout(() => panel.classList.remove('session-high'), 1500);
  }

  if (now - t.lastDraw > 2500) {
    t.lastDraw = now;
    ensureTickerChart();
    const c = t.chart;
    if (c) {
      c.data.labels = t.points.map(p => new Date(p.t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      c.data.datasets[0].data = t.points.map(p => p.eq);
      const up = t.points.length > 1 && t.points[t.points.length - 1].eq >= t.points[0].eq;
      c.data.datasets[0].borderColor = up ? '#3ddc84' : '#ff6b8b';
      c.data.datasets[0].backgroundColor = up ? 'rgba(61,220,132,0.08)' : 'rgba(255,107,139,0.08)';
      c.update('none');
    }
  }
}

// --- C5: top mover + celdas de flotante en vivo ----------------------------

function updateLiveFloatCells() {
  const floats = liveFloatByMagic();
  document.querySelectorAll('[data-live-float]').forEach(td => {
    const lf = floats.get(Number(td.dataset.liveFloat));
    td.textContent = lf ? fmt.usd(lf.float, true) : '—';
    td.className = `num live-float-cell ${lf ? signedClass(lf.float) : ''}`;
  });
  document.querySelectorAll('[data-live-float-inline]').forEach(el => {
    const lf = floats.get(Number(el.dataset.liveFloatInline));
    el.textContent = lf ? `flot. ${fmt.usd(lf.float, true)}` : 'flot. —';
    el.className = `live-float-inline ${lf ? signedClass(lf.float) : ''}`;
  });
}

function updateTopMoverChip() {
  const chip = document.getElementById('top-mover-chip');
  const label = document.getElementById('top-mover-label');
  if (!chip || !label) return;
  const floats = liveFloatByMagic();
  let top = null;
  for (const [magic, e] of floats) {
    if (!top || Math.abs(e.float) > Math.abs(top.e.float)) top = { magic, e };
  }
  if (!top || !top.e.count) { chip.hidden = true; return; }
  chip.hidden = false;
  const sym = (top.e.symbol || '').replace('.b', '');
  label.innerHTML = `${sym} · <code>${String(top.magic).slice(-5)}</code> <span class="${signedClass(top.e.float)}">${fmt.usd(top.e.float, true)}</span>`;
  chip.classList.toggle('mover-pos', top.e.float >= 0);
  chip.classList.toggle('mover-neg', top.e.float < 0);
  if (!chip.dataset.wired) {
    chip.dataset.wired = '1';
    chip.addEventListener('click', () => {
      const sec = document.getElementById('real-accounts');
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

// --- B5: War Room -----------------------------------------------------------

// --- War Room · Ingreso de la semana (equity total en vivo) ------------------
// Ventana: domingo 17:00 America/New_York (apertura forex = 14:00 Las Vegas)
// → viernes 17:00 NY (cierre = 14:00 Las Vegas). La curva grafica el EQUITY
// TOTAL ABSOLUTO (todas las cuentas reales, flotante incluido): arranca en el
// valor exacto de la apertura del domingo (línea punteada de referencia) y
// fluctúa con las ganancias. Histórico durable desde public.live_real_history
// vía RPC real_weekly_history (buckets 15 min); en vivo 1 punto cada ~3s.
// Al cierre del viernes queda congelada como foto todo el fin de semana; el
// domingo a la apertura la ventana rota sola → se borra y arranca de nuevo.
const warWeekly = {
  chart: null,
  weekOpen: 0,
  weekClose: 0,
  openEquity: null, // equity total en el primer punto de la semana (apertura)
  hist: [],         // puntos durables (RPC) como {x, y: equity total}
  livePts: [],      // puntos de la sesión (stream ~3s), se descartan al refetch
  lastFetch: 0,
  fetching: false,
  _testNow: null,   // override de "ahora" para pruebas en consola
};

function warNow() { return warWeekly._testNow || Date.now(); }

// Wall-clock de America/New_York → epoch UTC (DST-safe, método iterativo).
function nyWallToUtc(y, mo, d, h, mi) {
  let guess = Date.UTC(y, mo, d, h, mi);
  const want = Date.UTC(y, mo, d, h, mi);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false,
  });
  for (let i = 0; i < 3; i++) {
    const parts = dtf.formatToParts(new Date(guess));
    const get = (t) => Number(parts.find(p => p.type === t).value);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    if (wall === want) break;
    guess += want - wall;
  }
  return guess;
}

// Último domingo 17:00 NY ≤ ahora → { open, close } (close = +5 días wall-clock).
function currentWeekWindow(nowMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'numeric',
    day: 'numeric', weekday: 'short',
  });
  for (let k = 0; k < 9; k++) {
    const parts = dtf.formatToParts(new Date(nowMs - k * 86400e3));
    const get = (t) => parts.find(p => p.type === t).value;
    if (get('weekday') !== 'Sun') continue;
    const y = Number(get('year')), mo = Number(get('month')) - 1, d = Number(get('day'));
    const open = nyWallToUtc(y, mo, d, 17, 0);
    if (open <= nowMs) return { open, close: nyWallToUtc(y, mo, d + 5, 17, 0) };
  }
  return null;
}

const WAR_LV_FMT = new Intl.DateTimeFormat('es-US', {
  timeZone: 'America/Los_Angeles', weekday: 'short', day: 'numeric',
  month: 'short', hour: 'numeric', minute: '2-digit', hour12: false,
});
const WAR_LV_TICK = new Intl.DateTimeFormat('es-US', {
  timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', hour12: false,
});

// Recalcula la ventana; en cambio de semana (domingo 17:00 NY) resetea todo.
function warWeeklyEnsureWindow() {
  const w = currentWeekWindow(warNow());
  if (!w) return false;
  if (w.open !== warWeekly.weekOpen) {
    warWeekly.weekOpen = w.open;
    warWeekly.weekClose = w.close;
    warWeekly.openEquity = null;
    warWeekly.hist = [];
    warWeekly.livePts = [];
    warWeekly.lastFetch = 0;
    if (warWeekly.chart) { warWeekly.chart.destroy(); warWeekly.chart = null; }
  }
  return true;
}

// Relleno del arranque de semana con la historia de 30 min (data/history.jsonl,
// ya cargada en state.history para los sparklines — 14 días de retención para
// cuentas reales, ver scripts/fetch_ledger.py HISTORY_REAL_DAYS). La tabla
// live_real_history (F1) es más reciente que algunos domingos de apertura, así
// que sin esto la curva "arrancaría" tarde. Agrupa por ts exacto (un ciclo de
// snapshot escribe todas las cuentas con el mismo ts), forward-fill por login,
// y solo emite el total cuando ya se vio a TODAS las cuentas reales de la
// semana al menos una vez (mismo patrón que el forward-fill de F1).
function warWeeklyHistoryPrefix(cutoffMs) {
  const rows = (state.history || [])
    .filter(h => h.is_real && state.realLogins && state.realLogins.has(h.login))
    .map(h => ({ t: new Date(h.ts).getTime(), login: h.login, equity: Number(h.equity) || 0 }))
    .filter(h => Number.isFinite(h.t) && h.t >= warWeekly.weekOpen && h.t < cutoffMs);
  if (!rows.length) return [];

  const byTs = new Map();
  const distinctLogins = new Set();
  for (const r of rows) {
    distinctLogins.add(r.login);
    if (!byTs.has(r.t)) byTs.set(r.t, []);
    byTs.get(r.t).push(r);
  }
  const last = new Map();
  const out = [];
  for (const t of [...byTs.keys()].sort((a, b) => a - b)) {
    byTs.get(t).forEach(r => last.set(r.login, r.equity));
    if (last.size >= distinctLogins.size) {
      let sum = 0;
      last.forEach(v => { sum += v; });
      out.push({ x: t, y: sum });
    }
  }
  return out;
}

async function warWeeklyFetch() {
  if (!window.kizSupabase || warWeekly.fetching || !warWeekly.weekOpen) return;
  warWeekly.fetching = true;
  try {
    const { data, error } = await window.kizSupabase.rpc('real_weekly_history', {
      week_open: new Date(warWeekly.weekOpen).toISOString(),
    });
    if (error) { console.warn('[kiz] real_weekly_history failed', error.message || error); return; }
    const rows = Array.isArray(data) ? data : [];
    warWeekly.lastFetch = Date.now();

    const rpcHist = rows.map(r => ({ x: new Date(r.bucket).getTime(), y: Number(r.total_equity) }));
    const cutoff = rpcHist.length ? rpcHist[0].x : warWeekly.weekClose;
    const prefix = warWeeklyHistoryPrefix(cutoff);
    const combined = prefix.concat(rpcHist);

    if (!combined.length) return; // sin datos aún esta semana — el live siembra la apertura
    warWeekly.openEquity = combined[0].y;
    warWeekly.hist = combined;
    warWeekly.livePts = []; // la RPC + el prefijo son la fuente durable; la sesión se reconstruye
  } finally {
    warWeekly.fetching = false;
  }
}

function warWeeklySeries() {
  return warWeekly.hist.concat(warWeekly.livePts);
}

function warWeeklyRender() {
  const panel = document.getElementById('war-weekly');
  const canvas = document.getElementById('war-weekly-canvas');
  if (!panel || !canvas || !warWeekly.weekOpen) return;
  panel.hidden = false;

  const now = warNow();
  const frozen = now > warWeekly.weekClose;
  const series = warWeeklySeries();
  const openEq = warWeekly.openEquity;
  // Ingreso de la semana = equity actual − equity en la apertura del domingo.
  const pnl = (series.length && openEq != null) ? series[series.length - 1].y - openEq : 0;
  const up = pnl >= 0;
  const color = up ? '#3ddc97' : '#ff6b8b';

  const valueEl = document.getElementById('war-weekly-value');
  if (valueEl) {
    valueEl.textContent = fmt.usd(pnl, true);
    valueEl.classList.remove('positive', 'negative');
    valueEl.classList.add(up ? 'positive' : 'negative');
  }
  const rangeEl = document.getElementById('war-weekly-range');
  if (rangeEl) {
    const desde = openEq != null ? `desde ${fmt.usd(openEq)} · ` : '';
    rangeEl.textContent =
      `${desde}${WAR_LV_FMT.format(warWeekly.weekOpen)} → ${WAR_LV_FMT.format(warWeekly.weekClose)} · Las Vegas`;
  }
  const chipEl = document.getElementById('war-weekly-chip');
  if (chipEl) chipEl.hidden = !frozen;

  // Ticks fijos: un tick por día de la semana (apertura + cada 24h + cierre).
  const dayTicks = [];
  for (let t = warWeekly.weekOpen; t <= warWeekly.weekClose; t += 86400e3) dayTicks.push(t);

  if (!warWeekly.chart) {
    warWeekly.chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Equity total',
            data: series,
            borderColor: color,
            backgroundColor: up ? 'rgba(61,220,151,0.12)' : 'rgba(255,107,139,0.12)',
            fill: { target: { value: openEq != null ? openEq : 0 } },
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
          },
          {
            // Referencia: el valor exacto de la apertura del domingo.
            label: 'apertura',
            data: openEq == null ? [] :
              [{ x: warWeekly.weekOpen, y: openEq }, { x: warWeekly.weekClose, y: openEq }],
            borderColor: 'rgba(154,163,187,0.35)',
            borderDash: [5, 5],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (c) => c.datasetIndex === 0,
            callbacks: {
              title: (items) => items.length ? WAR_LV_FMT.format(items[0].parsed.x) + ' (LV)' : '',
              label: (c) => {
                const delta = warWeekly.openEquity != null ? c.parsed.y - warWeekly.openEquity : null;
                return `Equity: ${fmt.usd(c.parsed.y)}${delta != null ? ` (${fmt.usd(delta, true)} vs apertura)` : ''}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: warWeekly.weekOpen,
            max: warWeekly.weekClose,
            grid: { color: 'rgba(255,255,255,0.05)' },
            afterBuildTicks: (axis) => { axis.ticks = dayTicks.map(v => ({ value: v })); },
            ticks: { color: '#9aa3bb', callback: (v) => WAR_LV_TICK.format(v) },
          },
          y: {
            grace: '5%',
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#9aa3bb', callback: (v) => fmt.usd(v) },
          },
        },
      },
    });
  } else {
    const ds = warWeekly.chart.data.datasets[0];
    ds.data = series;
    ds.borderColor = color;
    ds.backgroundColor = up ? 'rgba(61,220,151,0.12)' : 'rgba(255,107,139,0.12)';
    ds.fill = { target: { value: openEq != null ? openEq : 0 } };
    warWeekly.chart.data.datasets[1].data = openEq == null ? [] :
      [{ x: warWeekly.weekOpen, y: openEq }, { x: warWeekly.weekClose, y: openEq }];
    warWeekly.chart.options.scales.x.min = warWeekly.weekOpen;
    warWeekly.chart.options.scales.x.max = warWeekly.weekClose;
    warWeekly.chart.update('none');
  }
}

// Al abrir el War Room: ventana + histórico + primer render.
function warWeeklyOpen() {
  if (!warWeeklyEnsureWindow()) return;
  warWeeklyFetch().then(warWeeklyRender);
  warWeeklyRender();
}

// Cada push del stream (~3s, solo con el War Room abierto).
function warWeeklyLiveTick() {
  if (!realSuite.warRoomOpen) return;
  if (!warWeeklyEnsureWindow()) return;
  const now = warNow();
  if (now <= warWeekly.weekClose) {
    const { eq } = liveTotals();
    if (eq > 0) {
      // Semana recién abierta sin histórico todavía: el live siembra la apertura.
      if (warWeekly.openEquity == null) warWeekly.openEquity = eq;
      const last = warWeekly.livePts[warWeekly.livePts.length - 1];
      if (!last || now - last.x >= 2500) {
        warWeekly.livePts.push({ x: now, y: eq });
        if (warWeekly.livePts.length > 6000) warWeekly.livePts.splice(0, 1000);
      }
    }
    // Refetch periódico para consolidar con la fuente durable (RPC).
    if (Date.now() - warWeekly.lastFetch > 5 * 60e3) warWeeklyFetch().then(warWeeklyRender);
  }
  warWeeklyRender();
}

function renderWarRoom() {
  if (!realSuite.warRoomOpen) return;
  const grid = document.getElementById('war-room-grid');
  if (!grid) return;
  const snapReals = ((state.snapshot && state.snapshot.real_portfolio && state.snapshot.real_portfolio.accounts) || [])
    .filter(isFundedRealAccount);
  const { eq, fl } = liveTotals();
  const eqEl = document.getElementById('war-room-equity');
  const flEl = document.getElementById('war-room-float');
  if (eqEl) {
    const prev = eqEl.dataset.v ? Number(eqEl.dataset.v) : eq;
    eqEl.textContent = fmt.usd(eq);
    eqEl.dataset.v = eq;
    if (eq !== prev) {
      eqEl.classList.remove('wr-up', 'wr-down');
      void eqEl.offsetWidth;
      eqEl.classList.add(eq >= prev ? 'wr-up' : 'wr-down');
    }
  }
  if (flEl) { flEl.textContent = `flotante ${fmt.usd(fl, true)}`; flEl.className = `war-room-total-float ${signedClass(fl)}`; }

  snapReals.forEach(a => {
    const r = liveState.byLogin.get(a.login);
    const eqA = Number(r ? r.equity : a.equity) || 0;
    const flA = Number(r ? r.profit : a.profit) || 0;
    const nPos = r && Array.isArray(r.positions) ? r.positions.length : 0;
    let tile = grid.querySelector(`[data-wr="${a.login}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'war-room-tile';
      tile.dataset.wr = a.login;
      tile.innerHTML = `<div class="wr-login"></div><div class="wr-eq"></div><div class="wr-fl"></div><div class="wr-risk"></div><div class="wr-pos"></div>`;
      grid.appendChild(tile);
    }
    tile.querySelector('.wr-login').textContent = `#${a.login} · ${vpsPrettyName(a.vps)}`;
    const eqTileEl = tile.querySelector('.wr-eq');
    const prev = eqTileEl.dataset.v ? Number(eqTileEl.dataset.v) : eqA;
    eqTileEl.textContent = fmt.usd(eqA);
    eqTileEl.dataset.v = eqA;
    if (eqA !== prev) {
      tile.classList.remove('wr-tile-up', 'wr-tile-down');
      void tile.offsetWidth;
      tile.classList.add(eqA >= prev ? 'wr-tile-up' : 'wr-tile-down');
    }
    const flTileEl = tile.querySelector('.wr-fl');
    flTileEl.textContent = fmt.usd(flA, true);
    flTileEl.className = `wr-fl ${signedClass(flA)}`;
    const riskEl = tile.querySelector('.wr-risk');
    if (riskEl) {
      const risk = computeRealRisk(a.login, r || a);
      const pnlTxt = risk.dayPnl == null ? '—' : fmt.usd(risk.dayPnl, true);
      const mTxt = risk.marginLevel == null ? 'sin exposición' : `ML ${Math.round(risk.marginLevel)}%`;
      riskEl.innerHTML = `<span class="${risk.dayPnl != null ? signedClass(risk.dayPnl) : ''}">hoy ${pnlTxt}</span> · <span class="${ddClass(risk.ddPct)}">DD -${risk.ddPct.toFixed(2)}%</span> · <span class="${marginClass(risk.marginLevel)}">${mTxt}</span>`;
    }
    tile.querySelector('.wr-pos').textContent = nPos ? `${nPos} posición${nPos > 1 ? 'es' : ''} abierta${nPos > 1 ? 's' : ''}` : 'sin posiciones';
  });

  const mover = document.getElementById('war-room-mover');
  if (mover) {
    const floats = liveFloatByMagic();
    let top = null;
    for (const [magic, e] of floats) {
      if (!top || Math.abs(e.float) > Math.abs(top.e.float)) top = { magic, e };
    }
    mover.textContent = top && top.e.count
      ? `🚀 Top mover: ${(top.e.symbol || '').replace('.b', '')} · ${top.magic} → ${fmt.usd(top.e.float, true)}`
      : '—';
  }
}

function toggleWarRoom(open) {
  const el = document.getElementById('war-room');
  if (!el) return;
  realSuite.warRoomOpen = open;
  el.hidden = !open;
  document.body.classList.toggle('war-room-active', open);
  if (open) {
    renderWarRoom();
    warWeeklyOpen();
    const clock = document.getElementById('war-room-clock');
    const tick = () => { if (clock) clock.textContent = new Date().toLocaleTimeString('es-ES'); };
    tick();
    realSuite.warClock = setInterval(tick, 1000);
    try { el.requestFullscreen && el.requestFullscreen().catch(() => {}); } catch {}
  } else {
    if (realSuite.warClock) { clearInterval(realSuite.warClock); realSuite.warClock = null; }
    try { document.fullscreenElement && document.exitFullscreen(); } catch {}
  }
}

function wireWarRoom() {
  const btn = document.getElementById('war-room-btn');
  const close = document.getElementById('war-room-close');
  if (btn && !btn.dataset.wired) { btn.dataset.wired = '1'; btn.addEventListener('click', () => toggleWarRoom(true)); }
  if (close && !close.dataset.wired) { close.dataset.wired = '1'; close.addEventListener('click', () => toggleWarRoom(false)); }
  if (!document.body.dataset.wrEsc) {
    document.body.dataset.wrEsc = '1';
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && realSuite.warRoomOpen) toggleWarRoom(false); });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && realSuite.warRoomOpen) toggleWarRoom(false);
    });
  }
}

// --- entry points -----------------------------------------------------------

// Llamado tras cada applySnapshot (datos de 30 min)
function renderRealDailySuite() {
  renderRealDailyPanel();
  renderRealBotCards();
  renderRealHeatmap();
  renderRealRace();
  renderWeeklySuite();
  wireWarRoom();
  updateLiveFloatCells();
  updateTopMoverChip();
  tickerPush();
}

// Llamado en cada push del live stream (~3s)
function kizRealLiveHooks() {
  tickerPush();
  updateLiveFloatCells();
  updateTopMoverChip();
  renderWarRoom();
  warWeeklyLiveTick();
  weeklySuiteLiveTick();
}

/* ==========================================================================
   Weekly Suite (v20260711a)
   Analítica semanal de las cuentas reales: scorecard ejecutivo (W5),
   comparador week-over-week (W2), reloj de trading día×hora (W1), waterfall
   de contribución (W3) y pulso de riesgo intra-semana (W4).
   Fuente: trades[] de los per-bot files de los bots en cuentas reales
   (100% client-side, sin backend nuevo) + la ventana semanal del War Room
   (domingo 17:00 NY → viernes 17:00 NY, currentWeekWindow) + el equity
   intra-semana durable de real_weekly_history (via warWeeklyFetch).
   ========================================================================== */

const weeklySuite = {
  key: null,        // generated_at del snapshot con el que se cachearon los trades
  trades: null,     // trades cerrados de bots reales, cada uno con _key/_label
  loading: false,
  weeks: [],        // ventanas semanales desc ([0] = semana actual)
  stats: [],        // wkStats por ventana (mismo índice que weeks)
  clockWeeks: 1,    // toggle del reloj: 1 | 4 | 12 semanas
  charts: {},       // instancias Chart.js por canvas id
  wfBase: 0,        // cum de net cerrado antes del paso "Flotante" (live update)
  lastLiveTick: 0,
};

const WK_DOW_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const WK_DOW_ES = { Sun: 'Dom', Mon: 'Lun', Tue: 'Mar', Wed: 'Mié', Thu: 'Jue', Fri: 'Vie', Sat: 'Sáb' };
const WK_CELL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: false,
});
const WK_DAY_FMT = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'America/New_York', day: '2-digit', month: 'short',
});

function wkChart(id, cfg) {
  const canvas = document.getElementById(id);
  if (!canvas || typeof Chart === 'undefined') return null;
  if (weeklySuite.charts[id]) weeklySuite.charts[id].destroy();
  weeklySuite.charts[id] = new Chart(canvas, cfg);
  return weeklySuite.charts[id];
}

function wkFmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  if (sec < 90) return `${Math.round(sec)}s`;
  const m = sec / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${Math.floor(h)}h ${Math.round(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
}

// Descarga (una vez por snapshot) los trades cerrados de todos los bots que
// corren en cuentas reales fundadas. data-source.js reescribe data/ a signed URLs.
async function wkLoadRealTrades() {
  const s = state.snapshot;
  if (!s) return null;
  const key = s.generated_at || 'nokey';
  if (weeklySuite.trades && weeklySuite.key === key) return weeklySuite.trades;
  if (weeklySuite.loading) return weeklySuite.trades;
  const logins = new Set(((s.real_portfolio || {}).accounts || [])
    .filter(isFundedRealAccount).map(a => a.login));
  const bots = (s.bots || []).filter(b => logins.has(b.account_login));
  if (!bots.length) return null;
  weeklySuite.loading = true;
  try {
    const results = await Promise.all(bots.map(async (b) => {
      try {
        const res = await fetch(`data/bots/${b.vps}/${b.account_login}-${b.magic}.json?t=${Date.now()}`);
        if (!res.ok) return [];
        const j = await res.json();
        return (j.trades || []).map(t => ({ ...t, _key: botKey(b), _label: botLabel(b), _login: b.account_login }));
      } catch { return []; }
    }));
    weeklySuite.trades = results.flat();
    weeklySuite.key = key;
  } finally { weeklySuite.loading = false; }
  return weeklySuite.trades;
}

// Últimas n ventanas semanales (DST-safe, reutiliza currentWeekWindow). Desc.
function wkWeekWindows(n) {
  const wins = [];
  let w = currentWeekWindow(Date.now());
  for (let i = 0; i < n && w; i++) {
    wins.push(w);
    w = currentWeekWindow(w.open - 36e5); // 1h antes de la apertura → semana previa
  }
  return wins;
}

function wkStats(trades) {
  const st = { net: 0, trades: trades.length, wins: 0, grossW: 0, grossL: 0,
    best: null, worst: null, durSum: 0, byBot: new Map() };
  for (const t of trades) {
    const n = Number(t.net) || 0;
    st.net += n;
    if (n > 0) { st.wins++; st.grossW += n; } else { st.grossL += -n; }
    if (!st.best || n > st.best.net) st.best = { net: n, t };
    if (!st.worst || n < st.worst.net) st.worst = { net: n, t };
    st.durSum += Number(t.duration_sec) || 0;
    const e = st.byBot.get(t._key) || { net: 0, trades: 0, label: t._label };
    e.net += n; e.trades++;
    st.byBot.set(t._key, e);
  }
  st.winRate = st.trades ? (st.wins / st.trades) * 100 : null;
  st.pf = st.grossL > 0 ? st.grossW / st.grossL : (st.grossW > 0 ? null : 0); // null = ∞
  st.expectancy = st.trades ? st.net / st.trades : null;
  st.avgDur = st.trades ? st.durSum / st.trades : null;
  return st;
}

// Mini bar-spark de 12 semanas (verde/rojo por signo, semana actual resaltada).
function wkBarSpark(vals, w = 96, h = 24) {
  const arr = (vals || []).map(v => Number(v) || 0);
  if (arr.length < 2) return '';
  const max = Math.max(1e-9, ...arr.map(Math.abs));
  const bw = w / arr.length;
  const mid = h / 2;
  const bars = arr.map((v, i) => {
    const bh = Math.max(1, (Math.abs(v) / max) * (mid - 1));
    const y = v >= 0 ? mid - bh : mid;
    const cur = i === arr.length - 1;
    return `<rect x="${(i * bw + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="${v >= 0 ? '#3ddc97' : '#ff6b8b'}" opacity="${cur ? 1 : 0.5}"/>`;
  }).join('');
  return `<svg class="wk-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><line x1="0" y1="${mid}" x2="${w}" y2="${mid}" stroke="rgba(255,255,255,0.12)"/>${bars}</svg>`;
}

function wkWeekLabel(w) {
  return `${WK_DAY_FMT.format(w.open)} → ${WK_DAY_FMT.format(w.close)}`;
}

// --- entry point (tras cada applySnapshot) ---------------------------------

async function renderWeeklySuite() {
  const panelIds = ['weekly-scorecard-panel', 'weekly-compare-panel',
    'weekly-clock-panel', 'weekly-waterfall-panel', 'weekly-risk-panel'];
  try {
    const trades = await wkLoadRealTrades();
    if (!trades || !trades.length) {
      panelIds.forEach(id => { const el = document.getElementById(id); if (el) el.hidden = true; });
      return;
    }
    weeklySuite.weeks = wkWeekWindows(12);
    weeklySuite.stats = weeklySuite.weeks.map((w, i) => {
      const end = i === 0 ? w.open + 7 * 86400e3 : weeklySuite.weeks[i - 1].open;
      return wkStats(trades.filter(t => {
        const ms = (Number(t.close_time) || 0) * 1000;
        return ms >= w.open && ms < end;
      }));
    });
    renderWeeklyScorecard();
    renderWeekCompare();
    renderWeeklyClock();
    renderWeeklyWaterfall();
    renderWeeklyRiskPulse();
  } catch (e) { console.error('weekly suite failed', e); }
}

// --- W5 · Scorecard --------------------------------------------------------

function renderWeeklyScorecard() {
  const panel = document.getElementById('weekly-scorecard-panel');
  const grid = document.getElementById('wk-kpi-grid');
  if (!panel || !grid) return;
  const cur = weeklySuite.stats[0];
  const prev = weeklySuite.stats[1];
  panel.hidden = false;

  const rangeEl = document.getElementById('wk-scorecard-range');
  if (rangeEl) rangeEl.textContent = wkWeekLabel(weeklySuite.weeks[0]) + ' · NY';

  const health = !cur.trades
    ? { icon: '⚪', label: 'sin trades cerrados aún', cls: 'wkh-neutral' }
    : cur.net > 0 && (cur.pf == null || cur.pf >= 1.3)
      ? { icon: '🟢', label: 'semana sana', cls: 'wkh-good' }
      : cur.net > 0
        ? { icon: '🟡', label: 'positiva pero justa', cls: 'wkh-warn' }
        : { icon: '🔴', label: 'semana en rojo', cls: 'wkh-bad' };
  const healthEl = document.getElementById('wk-health');
  if (healthEl) {
    healthEl.textContent = `${health.icon} ${health.label}`;
    healthEl.className = `wk-health ${health.cls}`;
  }

  const asc = weeklySuite.stats.slice().reverse(); // oldest → current
  const delta = (curV, prevV, fmtFn) => {
    if (curV == null || prevV == null) return '';
    const d = curV - prevV;
    return `<span class="wk-kpi-delta ${signedClass(d)}">${d >= 0 ? '▲' : '▼'} ${fmtFn(Math.abs(d))} vs sem. ant.</span>`;
  };
  const tile = (label, value, extra = '', spark = '', tip = '') =>
    `<div class="wk-kpi" ${tip ? `title="${tip}"` : ''}>
      <span class="wk-kpi-label">${label}</span>
      <span class="wk-kpi-value">${value}</span>
      ${extra}${spark}
    </div>`;

  grid.innerHTML = [
    tile('Net cerrado', `<span class="${signedClass(cur.net)}">${fmt.usd(cur.net, true)}</span>`,
      delta(cur.net, prev && prev.net, v => fmt.usd(v)), wkBarSpark(asc.map(s => s.net)),
      'Suma del net (profit+swap+comisión) de los trades cerrados esta semana'),
    tile('Win rate', cur.winRate == null ? '—' : fmt.pct(cur.winRate),
      delta(cur.winRate, prev && prev.winRate, v => v.toFixed(1) + ' pp'),
      wkBarSpark(asc.map(s => s.winRate == null ? 0 : s.winRate - 50)),
      'Spark: win rate semanal vs 50%'),
    tile('Profit factor', fmt.pf(cur.pf),
      (cur.pf != null && prev && prev.pf != null) ? delta(cur.pf, prev.pf, v => v.toFixed(2)) : ''),
    tile('Expectancy', cur.expectancy == null ? '—' : fmt.usd(cur.expectancy, true),
      delta(cur.expectancy, prev && prev.expectancy, v => fmt.usd(v)),
      wkBarSpark(asc.map(s => s.expectancy || 0)), 'Net promedio por trade'),
    tile('Trades', fmt.int(cur.trades),
      delta(cur.trades, prev && prev.trades, v => fmt.int(v)),
      wkBarSpark(asc.map(s => s.trades))),
    tile('Duración media', wkFmtDur(cur.avgDur)),
    tile('Mejor trade', cur.best ? `<span class="positive">${fmt.usd(cur.best.net, true)}</span>` : '—', '', '',
      cur.best ? `${cur.best.t.symbol} · magic ${cur.best.t.magic} · #${cur.best.t._login}` : ''),
    tile('Peor trade', cur.worst ? `<span class="${signedClass(cur.worst.net)}">${fmt.usd(cur.worst.net, true)}</span>` : '—', '', '',
      cur.worst ? `${cur.worst.t.symbol} · magic ${cur.worst.t.magic} · #${cur.worst.t._login}` : ''),
  ].join('');

  const mvpRow = document.getElementById('wk-mvp-row');
  if (mvpRow) {
    const byBot = [...cur.byBot.values()].sort((a, b) => b.net - a.net);
    if (!byBot.length) { mvpRow.innerHTML = ''; }
    else {
      const mvp = byBot[0];
      const worst = byBot[byBot.length - 1];
      mvpRow.innerHTML =
        `<span class="wk-mvp">🏆 MVP: <code>${mvp.label}</code> <span class="${signedClass(mvp.net)}">${fmt.usd(mvp.net, true)}</span> (${mvp.trades} trades)</span>` +
        (worst !== mvp && worst.net < 0
          ? `<span class="wk-mvp">🪨 Lastre: <code>${worst.label}</code> <span class="negative">${fmt.usd(worst.net, true)}</span> (${worst.trades} trades)</span>`
          : '');
    }
  }
}

// --- W2 · Comparador week-over-week ---------------------------------------

function renderWeekCompare() {
  const panel = document.getElementById('weekly-compare-panel');
  if (!panel) return;
  const weeks = weeklySuite.weeks;
  const stats = weeklySuite.stats;
  if (weeks.length < 2) { panel.hidden = true; return; }
  panel.hidden = false;

  const asc = stats.slice().reverse();
  const weeksAsc = weeks.slice().reverse();
  const labels = weeksAsc.map(w => WK_DAY_FMT.format(w.open));
  const nets = asc.map(s => s.net);

  // Promedio de las semanas CERRADAS con actividad (excluye la actual).
  const closed = asc.slice(0, -1).filter(s => s.trades > 0);
  const avg = closed.length ? closed.reduce((a, s) => a + s.net, 0) / closed.length : null;

  // Proyección run-rate de la semana actual (fracción transcurrida de la
  // ventana de trading dom 17:00 → vie 17:00 NY).
  const now = Date.now();
  const w0 = weeks[0];
  const frac = Math.min(1, Math.max(0, (now - w0.open) / (w0.close - w0.open)));
  const curNet = nets[nets.length - 1];
  const proj = (frac > 0.08 && frac < 1) ? curNet / frac : null;
  const projData = labels.map(() => null);
  if (proj != null && Math.abs(proj - curNet) > 0.005) {
    projData[labels.length - 1] = curNet >= 0 ? [curNet, proj] : [proj, curNet];
  }

  wkChart('wk-compare-canvas', {
    data: {
      labels,
      datasets: [
        {
          type: 'bar', label: 'Net cerrado', data: nets, order: 2,
          backgroundColor: nets.map((v, i) => i === nets.length - 1
            ? (v >= 0 ? 'rgba(61,220,151,0.9)' : 'rgba(255,107,139,0.9)')
            : (v >= 0 ? 'rgba(61,220,151,0.45)' : 'rgba(255,107,139,0.45)')),
          borderColor: nets.map((v, i) => i === nets.length - 1 ? '#ffc36b' : 'transparent'),
          borderWidth: 1.5, borderRadius: 4,
        },
        {
          type: 'bar', label: 'Proyección run-rate', data: projData, order: 3,
          backgroundColor: (curNet >= 0 ? 'rgba(61,220,151,0.18)' : 'rgba(255,107,139,0.18)'),
          borderColor: 'rgba(255,195,107,0.6)', borderWidth: 1, borderRadius: 4,
          grouped: false,
        },
        {
          type: 'line', label: 'Promedio semanas cerradas', order: 1,
          data: labels.map(() => avg), borderColor: 'rgba(154,163,187,0.55)',
          borderDash: [5, 5], borderWidth: 1.2, pointRadius: 0, fill: false,
          hidden: avg == null,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      onClick: (evt, elements) => {
        if (!elements || !elements.length) return;
        wkShowWeekDetail(labels.length - 1 - elements[0].index); // idx en stats (desc)
      },
      plugins: {
        legend: { display: true, labels: { color: '#9aa3bb', boxWidth: 14, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            title: (items) => items.length ? `Semana del ${items[0].label}` : '',
            label: (c) => {
              if (c.dataset.type === 'line') return `Promedio: ${fmt.usd(c.parsed.y, true)}`;
              if (c.datasetIndex === 1) return `Proyección run-rate: ${fmt.usd(proj, true)}`;
              const st = asc[c.dataIndex];
              return [`Net: ${fmt.usd(st.net, true)}`, `${st.trades} trades · WR ${st.winRate == null ? '—' : fmt.pct(st.winRate)} · PF ${fmt.pf(st.pf)}`];
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#9aa3bb', maxRotation: 0, font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: '#9aa3bb', callback: v => fmt.usd(v) }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });
}

function wkShowWeekDetail(statIdx) {
  const el = document.getElementById('wk-week-detail');
  if (!el || statIdx < 0 || statIdx >= weeklySuite.stats.length) return;
  const st = weeklySuite.stats[statIdx];
  const w = weeklySuite.weeks[statIdx];
  if (!st.trades) {
    el.innerHTML = `<strong>Semana ${wkWeekLabel(w)}:</strong> sin trades cerrados.`;
    el.hidden = false;
    return;
  }
  const byBot = [...st.byBot.values()].sort((a, b) => b.net - a.net);
  const top = byBot[0];
  el.innerHTML = `<strong>Semana ${wkWeekLabel(w)}${statIdx === 0 ? ' (actual)' : ''}:</strong>
    <span class="${signedClass(st.net)}">${fmt.usd(st.net, true)}</span> ·
    ${st.trades} trades · WR ${st.winRate == null ? '—' : fmt.pct(st.winRate)} ·
    PF ${fmt.pf(st.pf)} · expectancy ${st.expectancy == null ? '—' : fmt.usd(st.expectancy, true)} ·
    mejor bot <code>${top.label}</code> <span class="${signedClass(top.net)}">${fmt.usd(top.net, true)}</span>`;
  el.hidden = false;
}

// --- W1 · Reloj de trading (heatmap día × hora, hora NY) --------------------

function renderWeeklyClock() {
  const panel = document.getElementById('weekly-clock-panel');
  const grid = document.getElementById('wk-clock-grid');
  const pills = document.getElementById('wk-clock-pills');
  if (!panel || !grid) return;
  const trades = weeklySuite.trades || [];
  const weeks = weeklySuite.weeks;
  if (!weeks.length) { panel.hidden = true; return; }
  panel.hidden = false;

  if (pills && !pills.dataset.wired) {
    pills.dataset.wired = '1';
    pills.querySelectorAll('.wk-pill').forEach(p => p.addEventListener('click', () => {
      weeklySuite.clockWeeks = Number(p.dataset.ckwin) || 1;
      pills.querySelectorAll('.wk-pill').forEach(x => x.classList.toggle('active', x === p));
      renderWeeklyClock();
    }));
  }

  const n = Math.min(weeklySuite.clockWeeks, weeks.length);
  const from = weeks[n - 1].open;
  const to = weeks[0].open + 7 * 86400e3;
  const agg = new Map(); // "dow_h" -> {net, count}
  for (const t of trades) {
    const ms = (Number(t.close_time) || 0) * 1000;
    if (ms < from || ms >= to) continue;
    const parts = WK_CELL_FMT.formatToParts(new Date(ms));
    const wd = parts.find(p => p.type === 'weekday').value;
    const h = Number(parts.find(p => p.type === 'hour').value) % 24;
    const k = `${wd}_${h}`;
    const e = agg.get(k) || { net: 0, count: 0 };
    e.net += Number(t.net) || 0;
    e.count++;
    agg.set(k, e);
  }

  // Escala por cuantiles simétricos sobre |net| (mismo criterio que el calendario).
  const abs = [...agg.values()].map(e => Math.abs(e.net)).filter(v => v > 0).sort((a, b) => a - b);
  const q = p => abs.length ? abs[Math.min(abs.length - 1, Math.floor(p * abs.length))] : 1;
  const t1 = q(0.33), t2 = q(0.66);
  const cls = (e) => {
    if (!e) return 'hm-empty';
    if (e.net === 0) return 'hm-0';
    const a = Math.abs(e.net);
    const lvl = a <= t1 ? 1 : a <= t2 ? 2 : 3;
    return (e.net > 0 ? 'hm-p' : 'hm-n') + lvl;
  };

  const header = ['<span class="wkc-lbl"></span>']
    .concat(Array.from({ length: 24 }, (_, h) =>
      `<span class="wkc-h">${h % 3 === 0 ? h : ''}</span>`));
  const rows = WK_DOW_ORDER.map(dow => {
    const cells = [`<span class="wkc-lbl">${WK_DOW_ES[dow]}</span>`];
    for (let h = 0; h < 24; h++) {
      const e = agg.get(`${dow}_${h}`);
      const tip = `${WK_DOW_ES[dow]} ${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00 NY · ${e ? `${fmt.usd(e.net, true)} · ${e.count} trade${e.count > 1 ? 's' : ''}` : 'sin trades'}`;
      cells.push(`<span class="wkc ${cls(e)}" title="${tip}"></span>`);
    }
    return cells.join('');
  });
  grid.innerHTML = header.join('') + rows.join('');
}

// --- W3 · Waterfall de contribución ----------------------------------------

function wkCurrentFloat() {
  if (liveState.byLogin.size) return liveTotals().fl;
  const rp = (state.snapshot && state.snapshot.real_portfolio) || {};
  return Number(rp.total_unrealised_pnl) || 0;
}

function renderWeeklyWaterfall() {
  const panel = document.getElementById('weekly-waterfall-panel');
  if (!panel) return;
  const cur = weeklySuite.stats[0];
  if (!cur) { panel.hidden = true; return; }
  const fl = wkCurrentFloat();
  if (!cur.trades && Math.abs(fl) < 0.005) { panel.hidden = true; return; }
  panel.hidden = false;

  // Bots ordenados por contribución desc; cola >10 agrupada en "Otros".
  let byBot = [...cur.byBot.values()].sort((a, b) => b.net - a.net);
  if (byBot.length > 10) {
    const tail = byBot.slice(10);
    byBot = byBot.slice(0, 10);
    byBot.push({
      label: `Otros (${tail.length} bots)`,
      net: tail.reduce((a, e) => a + e.net, 0),
      trades: tail.reduce((a, e) => a + e.trades, 0),
    });
  }

  const labels = [];
  const data = [];
  const colors = [];
  let cum = 0;
  for (const e of byBot) {
    labels.push(e.label);
    data.push(e.net >= 0 ? [cum, cum + e.net] : [cum + e.net, cum]);
    colors.push(e.net >= 0 ? 'rgba(61,220,151,0.75)' : 'rgba(255,107,139,0.75)');
    cum += e.net;
  }
  weeklySuite.wfBase = cum;
  labels.push('Flotante ahora');
  data.push(fl >= 0 ? [cum, cum + fl] : [cum + fl, cum]);
  colors.push(fl >= 0 ? 'rgba(61,220,151,0.35)' : 'rgba(255,107,139,0.35)');
  const total = cum + fl;
  labels.push('Resultado semana');
  data.push(total >= 0 ? [0, total] : [total, 0]);
  colors.push('rgba(124,156,255,0.8)');

  const totalEl = document.getElementById('wk-waterfall-total');
  if (totalEl) totalEl.innerHTML =
    `cerrado <span class="${signedClass(cum)}">${fmt.usd(cum, true)}</span> + flotante <span class="${signedClass(fl)}">${fmt.usd(fl, true)}</span> = <strong class="${signedClass(total)}">${fmt.usd(total, true)}</strong>`;

  const botsMeta = byBot; // para tooltips
  wkChart('wk-waterfall-canvas', {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 4, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const i = c.dataIndex;
              if (i < botsMeta.length) return `${fmt.usd(botsMeta[i].net, true)} · ${botsMeta[i].trades} trades`;
              if (i === labels.length - 2) return `Flotante: ${fmt.usd(wkCurrentFloat(), true)}`;
              return `Resultado de la semana: ${fmt.usd(weeklySuite.wfBase + wkCurrentFloat(), true)}`;
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#9aa3bb', maxRotation: 45, minRotation: 30, font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#9aa3bb', callback: v => fmt.usd(v) }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });
}

// --- W4 · Pulso de riesgo intra-semana -------------------------------------

async function renderWeeklyRiskPulse() {
  const panel = document.getElementById('weekly-risk-panel');
  if (!panel) return;
  try {
    if (!warWeeklyEnsureWindow()) { panel.hidden = true; return; }
    if (!warWeekly.hist.length && !warWeekly.fetching) await warWeeklyFetch();
  } catch (e) { console.warn('risk pulse fetch failed', e); }
  const series = warWeeklySeries();
  if (series.length < 3) { panel.hidden = true; return; }
  panel.hidden = false;

  let peak = -Infinity;
  let maxDD = { v: 0, x: null, pct: 0 };
  const dd = series.map(p => {
    peak = Math.max(peak, p.y);
    const v = p.y - peak; // ≤ 0
    if (v < maxDD.v) maxDD = { v, x: p.x, pct: peak ? (v / peak) * 100 : 0 };
    return { x: p.x, y: v };
  });

  const chips = document.getElementById('wk-risk-chips');
  if (chips) {
    const net = weeklySuite.stats[0] ? weeklySuite.stats[0].net : 0;
    const ratio = maxDD.v < -0.005 ? net / Math.abs(maxDD.v) : null;
    let mg = 0;
    liveState.byLogin.forEach(r => { mg += Number(r.margin) || 0; });
    const eqNow = liveTotals().eq;
    const rp = (state.snapshot && state.snapshot.real_portfolio) || {};
    if (!liveState.byLogin.size) mg = Number(rp.total_open_margin) || 0;
    const mgPct = eqNow > 0 ? (mg / eqNow) * 100 : null;
    chips.innerHTML = [
      `<span class="wk-chip wk-chip-dd">Max DD semana: <strong class="negative">${fmt.usd(maxDD.v, true)}</strong> (${Math.abs(maxDD.pct).toFixed(2)}%)${maxDD.x ? ` · ${WAR_LV_FMT.format(maxDD.x)} LV` : ''}</span>`,
      ratio != null
        ? `<span class="wk-chip" title="Net cerrado de la semana dividido por el max drawdown intra-semana — cuánto ingreso costó cada $1 de dolor">Costo del ingreso: <strong class="${signedClass(ratio)}">${ratio.toFixed(2)}</strong> $net / $DD</span>`
        : '',
      mgPct != null
        ? `<span class="wk-chip" id="wk-chip-margin">Margen usado ahora: <strong>${fmt.usd(mg)}</strong> (${mgPct.toFixed(1)}% del equity)</span>`
        : '',
    ].filter(Boolean).join('');
  }

  const dayTicks = [];
  for (let t = warWeekly.weekOpen; t <= warWeekly.weekClose; t += 86400e3) dayTicks.push(t);

  wkChart('wk-risk-canvas', {
    type: 'line',
    data: {
      datasets: [{
        label: 'Drawdown vs pico de la semana',
        data: dd,
        borderColor: '#ff6b8b',
        backgroundColor: 'rgba(255,107,139,0.16)',
        fill: { target: { value: 0 } },
        borderWidth: 1.8,
        tension: 0.15,
        pointRadius: (ctx) => (dd[ctx.dataIndex] && dd[ctx.dataIndex].x === maxDD.x && maxDD.v < 0) ? 4 : 0,
        pointBackgroundColor: '#ffc36b',
        pointBorderColor: '#ffc36b',
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items.length ? WAR_LV_FMT.format(items[0].parsed.x) + ' (LV)' : '',
            label: (c) => `DD: ${fmt.usd(c.parsed.y, true)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear', min: warWeekly.weekOpen, max: warWeekly.weekClose,
          grid: { color: 'rgba(255,255,255,0.05)' },
          afterBuildTicks: (axis) => { axis.ticks = dayTicks.map(v => ({ value: v })); },
          ticks: { color: '#9aa3bb', callback: (v) => WAR_LV_TICK.format(v) },
        },
        y: {
          max: 0, grace: '5%',
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#9aa3bb', callback: (v) => fmt.usd(v) },
        },
      },
    },
  });
}

// --- live tick (throttled ~15s): flotante del waterfall + chip de margen ----

function weeklySuiteLiveTick() {
  const now = Date.now();
  if (now - weeklySuite.lastLiveTick < 15000) return;
  weeklySuite.lastLiveTick = now;
  try {
    const chart = weeklySuite.charts['wk-waterfall-canvas'];
    const panel = document.getElementById('weekly-waterfall-panel');
    if (chart && panel && !panel.hidden) {
      const fl = wkCurrentFloat();
      const cum = weeklySuite.wfBase;
      const data = chart.data.datasets[0].data;
      const colors = chart.data.datasets[0].backgroundColor;
      const iFl = data.length - 2;
      data[iFl] = fl >= 0 ? [cum, cum + fl] : [cum + fl, cum];
      colors[iFl] = fl >= 0 ? 'rgba(61,220,151,0.35)' : 'rgba(255,107,139,0.35)';
      const total = cum + fl;
      data[data.length - 1] = total >= 0 ? [0, total] : [total, 0];
      chart.update('none');
      const totalEl = document.getElementById('wk-waterfall-total');
      if (totalEl) totalEl.innerHTML =
        `cerrado <span class="${signedClass(cum)}">${fmt.usd(cum, true)}</span> + flotante <span class="${signedClass(fl)}">${fmt.usd(fl, true)}</span> = <strong class="${signedClass(total)}">${fmt.usd(total, true)}</strong>`;
    }
    const mgChip = document.getElementById('wk-chip-margin');
    if (mgChip && liveState.byLogin.size) {
      let mg = 0;
      liveState.byLogin.forEach(r => { mg += Number(r.margin) || 0; });
      const eqNow = liveTotals().eq;
      if (eqNow > 0) mgChip.innerHTML = `Margen usado ahora: <strong>${fmt.usd(mg)}</strong> (${((mg / eqNow) * 100).toFixed(1)}% del equity)`;
    }
  } catch (e) { /* nunca romper el live loop */ }
}
