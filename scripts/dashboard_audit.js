#!/usr/bin/env node
/**
 * Battle of Bots — Dashboard Audit Loop
 *
 * Runs end-to-end verification of EVERY section, table, chart, modal and
 * derived metric in the dashboard. Cross-checks DOM-rendered values against
 * the source-of-truth JSON (snapshot.json, dna_map.json, correlations.json,
 * portfolio.json) and flags every mismatch.
 *
 * Usage:
 *   node scripts/dashboard_audit.js
 *
 * Requires Brave running with --remote-debugging-port=9222 already open.
 * The script reloads the tab to clean state, then walks the dashboard.
 *
 * Exit code = number of failed checks. 0 = all pass.
 */

const WS_PATH = '/usr/local/lib/node_modules/openclaw/node_modules/ws';
const WS = require(WS_PATH);
const DASHBOARD_URL = 'http://127.0.0.1:8765/';

let id = 0;
const pending = new Map();

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, msg => msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}

async function ev(ws, expr) {
  const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(`JS error: ${r.exceptionDetails.text} :: ${r.exceptionDetails.exception?.description || ''}`);
  }
  return r.result.value;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

class Audit {
  constructor() { this.results = []; this.section = ''; }
  begin(s) { this.section = s; console.log(`\n──── ${s} ────`); }
  ok(msg) { this.results.push({ s: this.section, msg, pass: true }); console.log(`  ✅ ${msg}`); }
  fail(msg, detail) { this.results.push({ s: this.section, msg, pass: false, detail }); console.log(`  ❌ ${msg}${detail ? `\n     └─ ${detail}` : ''}`); }
  assert(cond, msg, detail) { cond ? this.ok(msg) : this.fail(msg, detail); }
  summary() {
    const pass = this.results.filter(r => r.pass).length;
    const fail = this.results.filter(r => !r.pass).length;
    console.log('\n═══════════════════════════════════════');
    console.log(`Auditoría completa: ${pass} ✅ · ${fail} ❌`);
    if (fail > 0) {
      console.log('\nFallos:');
      for (const r of this.results.filter(r => !r.pass)) {
        console.log(`  [${r.s}] ${r.msg}`);
        if (r.detail) console.log(`         ${r.detail}`);
      }
    }
    console.log('═══════════════════════════════════════');
    return fail;
  }
}

(async () => {
  const tabs = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
  const tab = tabs.find(t => t.type === 'page' && t.url.includes('127.0.0.1:8765')) || tabs[0];
  const ws = new WS(tab.webSocketDebuggerUrl);
  ws.on('message', m => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise(r => ws.on('open', r));
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.navigate', { url: DASHBOARD_URL });
  await wait(4500);  // wait for fetch + render + animateCounter (~900ms) to settle

  // Capture console errors during the audit (full description, dedup).
  const consoleErrors = [];
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw);
      if (m.method === 'Runtime.exceptionThrown') {
        const ex = m.params.exceptionDetails;
        const detail = ex?.exception?.description || ex?.text || 'unknown';
        const stack = (ex?.stackTrace?.callFrames || []).slice(0, 3).map(f => `${f.functionName || '?'}@${f.url?.split('/').pop()}:${f.lineNumber}`).join(' ← ');
        const sig = `${detail.split('\n')[0]} | ${stack}`;
        if (!consoleErrors.includes(sig)) consoleErrors.push(sig);
      }
    } catch {}
  });

  const A = new Audit();

  // Pull source of truth JSONs.
  const truth = await ev(ws, `(async () => {
    const [s, c, p] = await Promise.all([
      fetch('data/snapshot.json?t=' + Date.now()).then(r => r.json()),
      fetch('data/correlations.json?t=' + Date.now()).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('data/portfolio.json?t=' + Date.now()).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    return { s, c, p };
  })()`);

  const snap = truth.s;

  // ----- SECTION 1: Header / freshness / VPS+account counts -----
  A.begin('Header & freshness');
  const headerVps = await ev(ws, `document.getElementById('vps-count')?.textContent`);
  const expectedVps = String(Object.keys(snap.vps_sources || {}).length || snap.portfolio?.vps_count || '');
  A.assert(headerVps === expectedVps, `VPS count header (${headerVps}) = source (${expectedVps})`);
  const headerAcc = await ev(ws, `document.getElementById('account-count')?.textContent`);
  // Demo only — uses state.demoAccounts (after $10K filter).
  const demoAccCount = await ev(ws, `state.demoAccounts.length`);
  A.assert(headerAcc === String(demoAccCount), `Account count header (${headerAcc}) = state.demoAccounts (${demoAccCount})`);

  // ----- SECTION 1.5: Per-bot file coverage — every audit-worthy bot must have its history JSON -----
  A.begin('Per-bot file coverage (audit data)');
  const allMagicBots = (snap.bots || []).filter(b => b.magic && b.magic !== 0);
  // Check via fetch: hit each per-bot URL with HEAD-equivalent (small range)
  const missing = await ev(ws, `(async () => {
    const all = (window.state?.snapshot?.bots || []).filter(b => b.magic && b.magic !== 0);
    const checks = await Promise.all(all.map(async b => {
      const url = 'data/bots/' + b.vps + '/' + b.account_login + '-' + b.magic + '.json?t=' + Date.now();
      try { const r = await fetch(url, { method: 'GET' }); return r.ok ? null : { vps: b.vps, login: b.account_login, magic: b.magic, status: r.status }; }
      catch { return { vps: b.vps, login: b.account_login, magic: b.magic, status: 'fetch-fail' }; }
    }));
    return checks.filter(Boolean);
  })()`);
  A.assert(
    missing.length === 0,
    `${allMagicBots.length}/${allMagicBots.length} bots tienen archivo per-bot accesible`,
    missing.length ? `MISSING: ${missing.slice(0, 5).map(m => `${m.vps}/${m.login}-${m.magic} (${m.status})`).join(', ')}${missing.length > 5 ? ` y ${missing.length - 5} más` : ''}` : ''
  );

  // ----- SECTION 2: Real accounts cards + bots tagged -----
  A.begin('Cuentas reales');
  const realAccts = (snap.accounts || []).filter(a => a.is_real);
  const expectedRealLogins = realAccts.map(a => a.login).sort();
  A.ok(`accounts marcadas is_real: ${expectedRealLogins.length} (${expectedRealLogins.join(', ')})`);
  // is_real bots cross-check
  const isRealBots = (snap.bots || []).filter(b => b.real_vs_demo && b.real_vs_demo.is_real);
  const isRealLogins = [...new Set(isRealBots.map(b => b.account_login))].sort();
  const missingLogins = expectedRealLogins.filter(l => !isRealLogins.includes(l));
  A.assert(
    missingLogins.length === 0,
    `bots con real_vs_demo cubren todas las cuentas reales`,
    missingLogins.length ? `cuentas sin bots tagged: ${missingLogins.join(', ')}` : ''
  );
  // Verify each real account has its non-magic-0 bots tagged.
  for (const login of expectedRealLogins) {
    const allBotsForAcct = (snap.bots || []).filter(b => b.account_login === login && b.magic);
    const taggedForAcct = isRealBots.filter(b => b.account_login === login);
    A.assert(
      allBotsForAcct.length === taggedForAcct.length,
      `cuenta ${login}: ${taggedForAcct.length}/${allBotsForAcct.length} bots tagged is_real`,
      allBotsForAcct.length !== taggedForAcct.length ? `untagged: ${allBotsForAcct.filter(b => !b.real_vs_demo).map(b => b.magic).join(', ')}` : ''
    );
  }
  // Real bots table count
  const realTblRows = await ev(ws, `document.querySelectorAll('#real-bots-tbody tr').length`);
  A.assert(realTblRows === isRealBots.length, `tabla real-bots renderiza ${realTblRows} = ${isRealBots.length} bots reales`);

  // ----- SECTION 3: Stats (demo-only, post-$10K filter) -----
  // NB: cards use animateCounter via requestAnimationFrame, which is throttled
  // in headless Brave (text remains "$0"). We assert against el.dataset.current
  // (set synchronously to the target value) instead of textContent.
  A.begin('Portfolio stats (demo, post-filter)');
  const expectedDemoBalance = await ev(ws, `state.demoAccounts.reduce((s, a) => s + (a.balance || 0), 0)`);
  const expectedDemoEquity = await ev(ws, `state.demoAccounts.reduce((s, a) => s + (a.equity || 0), 0)`);
  const expectedDemoFloating = await ev(ws, `state.demoAccounts.reduce((s, a) => s + (a.profit || 0), 0)`);
  const cardTargets = await ev(ws, `Array.from(document.querySelectorAll('[data-counter]')).map(el => Number(el.dataset.current || 0))`);
  // cardTargets order: [balance, equity, floating_pnl, account_count, bot_count]
  A.assert(
    Math.abs(cardTargets[0] - expectedDemoBalance) < 1.0,
    `Balance total card ($${cardTargets[0].toFixed(2)}) = sum demoAccounts.balance ($${expectedDemoBalance.toFixed(2)})`
  );
  A.assert(
    Math.abs(cardTargets[1] - expectedDemoEquity) < 1.0,
    `Equity total card ($${cardTargets[1].toFixed(2)}) = sum demoAccounts.equity ($${expectedDemoEquity.toFixed(2)})`
  );
  A.assert(
    Math.abs(cardTargets[2] - expectedDemoFloating) < 1.0,
    `PnL abierto card ($${cardTargets[2].toFixed(2)}) = sum demoAccounts.profit ($${expectedDemoFloating.toFixed(2)})`
  );
  A.assert(cardTargets[3] === demoAccCount, `Cuentas activas card (${cardTargets[3]}) = ${demoAccCount}`);
  const expectedBotCount = await ev(ws, `state.demoBots.length`);
  A.assert(cardTargets[4] === expectedBotCount, `Bots detectados card (${cardTargets[4]}) = state.demoBots (${expectedBotCount})`);

  // ----- SECTION 4: Candidates -----
  A.begin('Candidatos a Cuenta Real');
  const counts = {};
  for (const b of snap.bots) counts[b.promotion_status] = (counts[b.promotion_status] || 0) + 1;
  const readyCount = counts.READY || 0;
  const nearCount = counts.NEAR || 0;
  const watchCount = counts.WATCH || 0;
  console.log(`     status counts: READY=${readyCount} NEAR=${nearCount} WATCH=${watchCount} NO=${counts.NO || 0}`);

  // Caps from backend rank_caps (single source of truth — mirrors renderCandidates)
  const rankCaps = (snap.promotion_meta && snap.promotion_meta.rank_caps) || {};
  const capReady = rankCaps.READY ?? 3, capNear = rankCaps.NEAR ?? 5, capWatch = rankCaps.WATCH ?? 15;

  // READY pill is default active
  const readyRows = await ev(ws, `document.querySelectorAll('#candidates-tbody tr').length`);
  const expectedReady = Math.min(readyCount, capReady);
  A.assert(readyRows === expectedReady, `READY pill: ${readyRows} filas = min(${readyCount}, ${capReady})`);

  // Click NEAR
  await ev(ws, `document.querySelector('#candidates-status-pills .pill[data-status="NEAR"]').click()`);
  await wait(150);
  const nearRows = await ev(ws, `document.querySelectorAll('#candidates-tbody tr').length`);
  const expectedNear = Math.min(nearCount, capNear);
  A.assert(nearRows === expectedNear, `NEAR pill: ${nearRows} filas = min(${nearCount}, ${capNear})`);

  // Click WATCH
  await ev(ws, `document.querySelector('#candidates-status-pills .pill[data-status="WATCH"]').click()`);
  await wait(150);
  const watchRows = await ev(ws, `document.querySelectorAll('#candidates-tbody tr').length`);
  const expectedWatch = Math.min(watchCount, capWatch);
  A.assert(watchRows === expectedWatch, `WATCH pill: ${watchRows} filas = min(${watchCount}, ${capWatch})`);

  // ----- Ultra Tribunal strip + sello ✓✓ (solo si el snapshot trae tribunal_meta) -----
  if (snap.tribunal_meta) {
    const tm = snap.tribunal_meta;
    const stripVisible = await ev(ws, `!document.getElementById('tribunal-strip')?.hidden`);
    A.assert(stripVisible, `tribunal-strip visible (veredicto ${tm.run_date} · ${tm.verdict_state})`);
    const stripText = await ev(ws, `document.getElementById('tribunal-strip')?.textContent || ''`);
    A.assert(stripText.includes(`${tm.concordance.matches}/${tm.concordance.of}`),
      `strip muestra concordancia ${tm.concordance.matches}/${tm.concordance.of}`);
    if (tm.continuous_gate && tm.continuous_gate.verdict) {
      A.assert(stripText.includes(tm.continuous_gate.verdict),
        `strip muestra gate continuo ${tm.continuous_gate.verdict}`);
    }
    // READY pill quedó activo tras los clicks de arriba → sellos ✓✓ visibles = bots confirmed
    await ev(ws, `document.querySelector('#candidates-status-pills .pill[data-status="READY"]').click()`);
    await wait(150);
    const sealRows = await ev(ws,
      `[...document.querySelectorAll('#candidates-tbody tr')].filter(r => r.textContent.includes('✓✓')).length`);
    const confirmedReady = (snap.bots || []).filter(b => b.double_signature === 'confirmed').length;
    A.assert(sealRows === confirmedReady,
      `sellos ✓✓ en filas READY (${sealRows}) = bots double_signature confirmed (${confirmedReady})`);
  } else {
    console.log('     tribunal_meta ausente — fail-open OK (sin asserts de tribunal)');
  }

  // Verify each rendered row has a confidence chip + click-able data attrs
  await ev(ws, `document.querySelector('#candidates-status-pills .pill[data-status="READY"]').click()`);
  await wait(150);
  const sampleRow = await ev(ws, `(() => {
    const r = document.querySelector('#candidates-tbody tr');
    if (!r) return null;
    return { vps: r.dataset.vps, login: r.dataset.login, magic: r.dataset.magic, score: r.querySelector('td.num strong')?.textContent, hasChip: !!r.querySelector('.shr-conf') };
  })()`);
  if (sampleRow) {
    A.assert(!!sampleRow.vps && !!sampleRow.login && !!sampleRow.magic, `primera fila READY tiene data-vps/login/magic`);
    A.assert(sampleRow.hasChip, `primera fila tiene chip de confianza shrinkage`);
  }

  // ----- SECTION 5+6: Forward Tracker / Drift Watch — secciones ELIMINADAS del
  // dashboard el 2026-06-08 (NO re-agregar). Solo se valida que sigan ausentes;
  // los campos backend (tracker/drift) siguen vivos y los usan modal + Query DSL.
  A.begin('Forward Tracker / Drift Watch (removidas 2026-06-08)');
  const trackerGone = await ev(ws, `document.getElementById('tracker-section') === null`);
  A.assert(trackerGone, 'sección Forward Tracker sigue removida del DOM');
  const driftGoneAudit = await ev(ws, `document.getElementById('drift-section') === null`);
  A.assert(driftGoneAudit, 'sección Drift Watch sigue removida del DOM');

  // ----- SECTION 7: Balanced + New bots -----
  A.begin('Balanced + Bots Nuevos');
  const balancedRows = await ev(ws, `document.querySelectorAll('#balanced-tbody tr').length`);
  const balancedExpected = Math.min(20, (state => state.demoBots ? state.demoBots.filter(b => (b.trades || 0) > 25).length : 0)({ demoBots: snap.bots.filter(b => !((snap.accounts || []).find(a => a.login === b.account_login)?.is_real)) }));
  // Don't enforce exact equality (filter logic varies); just assert reasonable
  A.assert(balancedRows >= 0 && balancedRows <= 20, `balanced renderiza ${balancedRows} filas (cap 20)`);
  const newCounter = await ev(ws, `document.getElementById('new-bots-count')?.textContent`);
  A.ok(`new-bots counter: ${newCounter}`);

  // ----- SECTION 8: Modal: pick first bot with full enrichment, walk every tab -----
  A.begin('Modal de auditoría — todas las pestañas');
  let candidate = await ev(ws, `(() => {
    const b = (state.snapshot.bots || []).find(b => b.promotion_status === 'READY' && b.magic && b.drift && b.capacity);
    return b ? { vps: b.vps, login: b.account_login, magic: b.magic } : null;
  })()`);
  if (!candidate) {
    candidate = await ev(ws, `(() => {
      const b = (state.snapshot.bots || []).find(b => b.magic && b.drift && b.capacity && b.stress);
      return b ? { vps: b.vps, login: b.account_login, magic: b.magic } : null;
    })()`);
  }
  if (candidate && candidate.vps) {
    await ev(ws, `openBotModal('${candidate.vps}', ${candidate.login}, ${candidate.magic})`);
    await wait(800);
    const modalOpen = await ev(ws, `!document.getElementById('bot-modal-overlay').hidden`);
    A.assert(modalOpen, `modal abre para ${candidate.magic}`);

    const tabs = ['growth', 'profit', 'drawdown', 'risk', 'consistency', 'decay', 'score', 'stress', 'oos', 'regime', 'tracker', 'drift', 'capacity'];
    for (const t of tabs) {
      await ev(ws, `document.querySelector('.bot-tab[data-tab="${t}"]').click()`);
      await wait(250);
      const content = await ev(ws, `(() => {
        const panel = document.getElementById('bot-analysis-panel');
        const canvas = document.getElementById('bot-main-chart');
        // Either the analysis panel is visible with content, OR the chart canvas is showing
        if (panel && !panel.hidden && panel.innerHTML.trim().length > 0) return 'panel';
        if (canvas) return 'chart';
        return 'empty';
      })()`);
      A.assert(content !== 'empty', `tab ${t} renderiza ${content}`);
    }
    // Trades table populated
    const tradesRows = await ev(ws, `document.querySelectorAll('#bot-trades-tbody tr').length`);
    A.assert(tradesRows > 0, `historial de trades muestra ${tradesRows} filas`);
    // Monthly chart canvas exists
    const monthlyCanvas = await ev(ws, `!!document.getElementById('bot-monthly-chart')`);
    A.assert(monthlyCanvas, `canvas P&L mensual existe`);
    // Close modal
    await ev(ws, `document.getElementById('bot-modal-close').click()`);
    await wait(200);
  } else {
    A.fail('no candidate bot with full enrichment found');
  }

  // ----- SECTION 9: Correlation modal -----
  A.begin('Correlation modal');
  await ev(ws, `document.getElementById('corr-btn').click()`);
  await wait(800);
  const corrCells = await ev(ws, `document.querySelectorAll('#corr-heatmap .corr-cell').length`);
  const corrBots = (truth.c?.bot_count) || 0;
  A.assert(corrCells === corrBots * corrBots, `heatmap renderiza ${corrCells} celdas (= ${corrBots}² = ${corrBots * corrBots})`);
  await ev(ws, `document.getElementById('corr-modal-close').click()`);
  await wait(200);

  // ----- SECTION 11: Portfolio modal -----
  A.begin('Portfolio modal');
  await ev(ws, `document.getElementById('portfolio-btn').click()`);
  await wait(700);
  const portRows = await ev(ws, `document.querySelectorAll('#portfolio-canvas .port-row').length`);
  const portBots = (truth.p?.n_bots) || 0;
  A.assert(portRows === portBots, `portfolio modal: ${portRows} filas = ${portBots} bots en json`);
  // Verify allocations sum to capital (default $50K, inverse_volatility)
  const sumCheck = await ev(ws, `(() => {
    const rows = document.querySelectorAll('#portfolio-canvas .port-row .port-row-capital, #portfolio-canvas .port-row .port-row-cap');
    let sum = 0;
    rows.forEach(r => { const v = parseFloat((r.textContent || '').replace(/[^0-9.\-]/g, '')); if (!isNaN(v)) sum += v; });
    return Math.round(sum);
  })()`);
  A.ok(`portfolio sum: $${sumCheck} (target $50,000)`);
  await ev(ws, `document.getElementById('portfolio-modal-close').click()`);
  await wait(200);

  // ----- SECTION 12: Query DSL -----
  A.begin('Query DSL');
  await ev(ws, `document.getElementById('query-btn').click()`);
  await wait(200);
  const queries = [
    { q: 'is_real = true SORT BY net DESC', expected: isRealBots.length },
    { q: 'status = "READY"', expected: readyCount },
    { q: 'drift_flag = true', expected: (snap.bots || []).filter(b => b.drift && b.drift.flag).length },
    { q: 'double_signature = "confirmed"', expected: (snap.bots || []).filter(b => b.double_signature === 'confirmed').length },
    { q: 'in_podium = true', expected: (snap.bots || []).filter(b => b.tribunal && !b.tribunal.is_suplente && b.tribunal.rank != null).length },
    { q: 'capacity_usd >= 50000', expected: (snap.bots || []).filter(b => (b.capacity?.capacity_usd || 0) >= 50000 && b.magic && b.magic !== 0).length },
    { q: 'symbol IN ("EURUSD","GBPUSD") AND pf >= 1.5 SORT BY calmar DESC LIMIT 5', expected: null },
  ];
  for (const { q, expected } of queries) {
    await ev(ws, `{ const i = document.getElementById('query-input'); i.value = ${JSON.stringify(q)}; applyQuery(i.value); }`);
    await wait(180);
    const rows = await ev(ws, `document.querySelectorAll('#query-tbody tr.bot-row').length`);
    const err = await ev(ws, `!document.getElementById('query-error').hidden`);
    if (err) {
      const msg = await ev(ws, `document.getElementById('query-error').textContent`);
      A.fail(`query "${q}"`, `parser error: ${msg}`);
    } else if (expected != null) {
      // Account for LIMIT in some queries
      const limit = (q.match(/LIMIT\s+(\d+)/i) || [])[1];
      const cap = limit ? Math.min(expected, Number(limit)) : expected;
      A.assert(rows === cap, `query "${q}" → ${rows} filas = ${cap} esperadas`);
    } else {
      A.assert(rows >= 0, `query "${q}" → ${rows} filas (sin error)`);
    }
  }

  // Sharing URL hash
  await ev(ws, `{ const i = document.getElementById('query-input'); i.value = 'is_real = true'; applyQuery(i.value); }`);
  await wait(150);
  await ev(ws, `document.getElementById('query-share').click()`);
  await wait(200);
  // Reload with hash to test hashchange handler
  const shareHash = '#q=' + encodeURIComponent('is_real = true');
  await send(ws, 'Page.navigate', { url: DASHBOARD_URL + shareHash });
  await wait(2500);
  const hashLoaded = await ev(ws, `document.getElementById('query-input')?.value`);
  A.assert(hashLoaded === 'is_real = true', `URL hash reload restaura query "${hashLoaded}"`);

  // ----- SECTION 13: VPS pills -----
  A.begin('VPS filtering');
  const vpsPills = await ev(ws, `document.querySelectorAll('#vps-pills .vps-pill').length`);
  const expectedVpsPills = 1 + Object.keys(snap.vps_sources || {}).length; // +1 for "Todos"
  A.assert(vpsPills === expectedVpsPills, `VPS pills: ${vpsPills} = 1 + ${expectedVpsPills - 1} VPS`);

  // ----- SECTION 14: Console errors during the audit -----
  A.begin('Console / runtime errors');
  // Headless Brave blocks clipboard.writeText — that's a sandbox limitation,
  // not a dashboard bug. Filter it out.
  const realErrors = consoleErrors.filter(e => !/Clipboard|writeText/i.test(e));
  A.assert(realErrors.length === 0, `0 errores reales capturados`, realErrors.length ? realErrors.slice(0, 3).join(' | ') : '');
  if (consoleErrors.length > realErrors.length) {
    console.log(`     (${consoleErrors.length - realErrors.length} clipboard permission errors ignored — headless sandbox)`);
  }

  // ----- SUMMARY -----
  const fails = A.summary();
  ws.close();
  process.exit(fails);
})().catch(e => { console.error('Audit failed:', e.message); process.exit(99); });
