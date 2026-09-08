// search.js — Búsqueda global de bots (magic, cuenta, símbolo, VPS, estado…)
// Archivo nuevo a propósito: cero cambios en app.js. Consume sus globales
// (state, openBotModal, vpsBadge, statusBadge, fmt) igual que views.js.
(function () {
  'use strict';

  const MAX_VISIBLE = 30;
  let indexCache = null;
  let indexedSnapshot = null;

  const CSS = `
    #global-search { margin:14px 0 4px; }
    .gs-input-wrap { position:relative; display:flex; align-items:center; }
    .gs-input-wrap .gs-icon { position:absolute; left:12px; opacity:.55; pointer-events:none; }
    #gs-input { width:100%; padding:10px 70px 10px 34px; border-radius:10px;
      border:1px solid rgba(128,128,128,.35); background:rgba(128,128,128,.06);
      color:inherit; font-size:.85rem; }
    #gs-input:focus { outline:none; border-color:#7a8ff0; }
    .gs-kbd { position:absolute; right:10px; font-size:.68rem; opacity:.5;
      border:1px solid rgba(128,128,128,.4); border-radius:5px; padding:1px 6px; pointer-events:none; }
    #gs-count { font-size:.72rem; opacity:.6; margin:6px 2px; }
    #gs-results { margin-top:6px; border-radius:10px; overflow:hidden;
      border:1px solid rgba(128,128,128,.2); }
    #gs-results[hidden] { display:none; }
    #gs-results table { width:100%; border-collapse:collapse; font-size:.8rem; }
    #gs-results th { text-align:left; padding:6px 10px; opacity:.6; font-weight:600;
      border-bottom:1px solid rgba(128,128,128,.2); }
    #gs-results td { padding:6px 10px; border-bottom:1px solid rgba(128,128,128,.1); }
    #gs-results tr.bot-row { cursor:pointer; }
    #gs-results tr.bot-row:hover { background:rgba(122,143,240,.1); }
    .gs-real-badge { font-size:.65rem; font-weight:700; color:#e8c547;
      border:1px solid rgba(232,197,71,.5); border-radius:5px; padding:1px 5px; margin-left:4px; }
    .gs-empty { padding:16px; text-align:center; opacity:.6; font-size:.82rem; }
  `;

  function buildSearchIndex() {
    const snap = state.snapshot;
    if (!snap) return [];
    if (indexCache && indexedSnapshot === snap) return indexCache;
    const accountsByLogin = {};
    for (const a of snap.accounts || []) accountsByLogin[`${a.vps}-${a.login}`] = a;
    const rows = (snap.bots || []).filter(b => b.magic && b.magic !== 0).map(b => {
      const account = accountsByLogin[`${b.vps}-${b.account_login}`];
      const symbols = b.symbols || [];
      const parts = [
        b.magic, b.account_login, b.vps,
        ...symbols, ...symbols.map(s => s.split('.')[0]),
        b.lifecycle?.stage, b.promotion_status, b.evidence_tier,
        b.gm_id, b.double_signature, b.lifecycle?.historical_reason,
        b.is_real ? 'real' : 'demo',
        b.drift?.flag ? 'drift' : '',
        b.dormant ? 'dormant' : '',
        b.dead ? 'dead' : '',
        b.tribunal?.rank != null ? 'podium' : '',
        account?.name, account?.server,
      ];
      const haystack = parts.filter(Boolean).join(' ').toLowerCase();
      return { bot: b, haystack };
    });
    indexCache = rows;
    indexedSnapshot = snap;
    return rows;
  }

  function matchBots(query) {
    const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return { matches: [], total: 0 };
    const rows = buildSearchIndex();
    const scored = [];
    for (const row of rows) {
      if (!tokens.every(t => row.haystack.includes(t))) continue;
      const b = row.bot;
      let score = 0;
      for (const t of tokens) {
        if (t === String(b.magic)) score = Math.max(score, 3);
        else if (t === String(b.account_login) || t === String(b.gm_id || '')) score = Math.max(score, 2);
        else if (String(b.magic).startsWith(t)) score = Math.max(score, 1);
      }
      scored.push({ bot: b, score });
    }
    scored.sort((a, c) => c.score - a.score || (c.bot.net_profit || 0) - (a.bot.net_profit || 0));
    return { matches: scored.slice(0, MAX_VISIBLE).map(s => s.bot), total: scored.length };
  }

  function renderResults(query) {
    const panel = document.getElementById('gs-results');
    const countEl = document.getElementById('gs-count');
    const tbody = document.getElementById('gs-tbody');
    if (!panel || !tbody) return;

    if (!query) {
      panel.hidden = true;
      countEl.textContent = '';
      return;
    }
    if (!state.snapshot) {
      panel.hidden = false;
      countEl.textContent = '';
      tbody.innerHTML = '<tr><td colspan="7" class="gs-empty">Cargando flota…</td></tr>';
      return;
    }

    const { matches, total } = matchBots(query);
    panel.hidden = false;

    if (!matches.length) {
      countEl.textContent = '';
      tbody.innerHTML = `<tr><td colspan="7" class="gs-empty">Sin resultados para «${query}» — prueba magic, login, símbolo, VPS, stage…</td></tr>`;
      return;
    }

    countEl.textContent = total > MAX_VISIBLE
      ? `Mostrando ${MAX_VISIBLE} de ${total} — refina la búsqueda`
      : `${total} bot${total === 1 ? '' : 's'}`;

    tbody.innerHTML = matches.map(b => `
      <tr class="bot-row" data-vps="${b.vps}" data-login="${b.account_login}" data-magic="${b.magic}">
        <td>${vpsBadge(b.vps)}${b.is_real ? '<span class="gs-real-badge">REAL</span>' : ''}</td>
        <td>${statusBadge(b.promotion_status)}</td>
        <td class="mono">${b.magic}</td>
        <td class="mono">${b.account_login}</td>
        <td>${(b.symbols || []).join(',')}</td>
        <td>${b.lifecycle?.stage || '—'}</td>
        <td class="num">${fmt.usd(b.net_profit, true)}</td>
      </tr>`).join('');
  }

  function render() {
    const anchor = document.getElementById('preset-views') || document.getElementById('query-bar-section');
    if (!anchor || document.getElementById('global-search')) return;
    const host = document.createElement('section');
    host.id = 'global-search';
    host.innerHTML = `
      <div class="gs-input-wrap">
        <span class="gs-icon">🔍</span>
        <input type="text" id="gs-input" spellcheck="false"
          placeholder="Buscar bot: magic, cuenta, símbolo, VPS, estado… (⌘K)" />
        <span class="gs-kbd">⌘K</span>
      </div>
      <div id="gs-count"></div>
      <div id="gs-results" hidden>
        <table>
          <thead>
            <tr><th>VPS</th><th>Estado</th><th>Magic</th><th>Cuenta</th><th>Símbolo</th><th>Stage</th><th class="num">Net</th></tr>
          </thead>
          <tbody id="gs-tbody"></tbody>
        </table>
      </div>
    `;
    anchor.parentNode.insertBefore(host, anchor);
  }

  function wire() {
    const input = document.getElementById('gs-input');
    const results = document.getElementById('gs-results');
    if (!input) return;

    let debounceTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => renderResults(input.value.trim()), 150);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (input.value) {
          input.value = '';
          renderResults('');
        } else {
          input.blur();
        }
      }
    });

    if (results) {
      results.addEventListener('click', (e) => {
        const row = e.target.closest('.bot-row');
        if (!row) return;
        openBotModal(row.dataset.vps, row.dataset.login, row.dataset.magic);
      });
    }

    document.addEventListener('keydown', (e) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isCmdK) {
        e.preventDefault();
        input.focus();
        input.select();
        return;
      }
      if (e.key === '/') {
        const active = document.activeElement;
        const tag = active?.tagName;
        const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active?.isContentEditable;
        if (!isTyping) {
          e.preventDefault();
          input.focus();
        }
      }
    });
  }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  function boot() { render(); wire(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
