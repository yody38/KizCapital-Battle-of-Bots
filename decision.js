// decision.js — Panel "Próximas mejores acciones" (Decision Center, fase 3).
// Archivo NUEVO a propósito: la UI nueva vive fuera del monolito app.js.
// Lee data/decision_center.json (via data-source.js) y pinta acciones
// consultivas con su evidencia (WHY). Nada aquí ejecuta nada: human veto siempre.
(function () {
  'use strict';

  const KIND_META = {
    PROMOTE_REVIEW: { icon: '🚀', label: 'Promoción', cls: 'dc-promote' },
    INVESTIGATE: { icon: '🔍', label: 'Investigar', cls: 'dc-investigate' },
    OBSERVE: { icon: '👁️', label: 'Observar', cls: 'dc-observe' },
    BASKET: { icon: '🧺', label: 'Cesta', cls: 'dc-basket' },
    SYSTEM: { icon: '🛠️', label: 'Sistema', cls: 'dc-system' },
  };

  const CSS = `
    #decision-center { margin: 18px 0; }
    #decision-center .dc-head { display:flex; align-items:baseline; gap:10px; margin-bottom:10px; }
    #decision-center .dc-title { font-size:1.05rem; font-weight:700; }
    #decision-center .dc-sub { font-size:.78rem; opacity:.65; }
    .dc-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:10px; }
    .dc-card { border:1px solid rgba(128,128,128,.25); border-radius:10px; padding:10px 12px;
               background:rgba(128,128,128,.06); }
    .dc-card-top { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
    .dc-chip { font-size:.7rem; font-weight:700; padding:2px 8px; border-radius:999px;
               border:1px solid currentColor; }
    .dc-promote { color:#2fbf71; } .dc-investigate { color:#e05252; }
    .dc-observe { color:#d9a441; } .dc-basket { color:#7a8ff0; } .dc-system { color:#9aa0a6; }
    .dc-claim { font-weight:600; font-size:.88rem; margin-bottom:6px; }
    .dc-why { margin:0; padding-left:16px; font-size:.76rem; opacity:.85; }
    .dc-why li { margin:2px 0; }
    .dc-caveat { font-size:.72rem; opacity:.6; font-style:italic; margin-top:6px; }
    .dc-empty { font-size:.85rem; opacity:.7; padding:8px 0; }
    .dc-veto { font-size:.72rem; opacity:.55; margin-top:8px; }
  `;

  function fmtEvidence(e) {
    let s = `${e.signal}: ${e.value === null || e.value === undefined ? '—' : e.value}`;
    if (e.threshold) s += ` (umbral ${e.threshold})`;
    if (e.detail) s += ` — ${e.detail}`;
    if (e.source) s += ` · ${e.source}`;
    return s;
  }

  function esc(x) {
    return String(x).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render(dc) {
    const host = document.getElementById('decision-center');
    if (!host) return;
    const actions = (dc && dc.actions) || [];
    const hon = (dc && dc.honesty) || {};
    const cards = actions.map((a) => {
      const meta = KIND_META[a.action] || { icon: '•', label: a.action, cls: 'dc-system' };
      const why = (a.because || []).map((e) => `<li>${esc(fmtEvidence(e))}</li>`).join('');
      const cav = (a.caveats || []).map((c) => `<div class="dc-caveat">⚠ ${esc(c)}</div>`).join('');
      return `<div class="dc-card">
        <div class="dc-card-top"><span>${meta.icon}</span>
          <span class="dc-chip ${meta.cls}">${meta.label}</span>
          <span style="opacity:.5;font-size:.7rem;">P${a.priority}</span></div>
        <div class="dc-claim">${esc(a.claim)}</div>
        <ul class="dc-why">${why}</ul>${cav}</div>`;
    }).join('');
    host.innerHTML = `
      <div class="dc-head"><span class="dc-title">🎯 Próximas mejores acciones</span>
        <span class="dc-sub">consultivo · evidencia del lab + flota${hon.holdout_2026 ? ' · holdout 2026 excluido como estimador' : ''}</span></div>
      ${cards || '<div class="dc-empty">Sin acciones pendientes — el sistema no ve nada que requiera tu decisión ahora.</div>'}
      <div class="dc-veto">Toda acción requiere veto humano: el sistema propone, jamás ejecuta.</div>`;
    host.hidden = false;
  }

  async function load() {
    try {
      const r = await fetch('data/decision_center.json');
      if (!r.ok) return;
      render(await r.json());
    } catch (_) { /* sin panel este ciclo — el dashboard sigue */ }
  }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // data-source.js necesita sesión para firmar URLs: esperar a kiz-session-ready
  // si aún no hay email; refresco suave cada 5 min (el backend rota cada 15).
  function start() { load(); setInterval(load, 5 * 60 * 1000); }
  if (window.kizUserEmail) start();
  else window.addEventListener('kiz-session-ready', start, { once: true });
})();
