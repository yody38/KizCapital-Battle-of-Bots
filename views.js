// views.js — Vistas preset sobre la misma población (fase 5 del Decision Center).
// Cada vista es UNA pregunta distinta respondida con el Query DSL ya existente:
// cero fetches extra, cero lógica nueva de ranking — solo presets declarativos.
// Archivo nuevo a propósito: la UI nueva no engorda el monolito app.js.
(function () {
  'use strict';

  // Cada preset = query DSL. La población demo es la misma; cambia la pregunta.
  const PRESET_VIEWS = [
    { id: 'weekly', icon: '📅', label: 'Top semanal', q: 'stage != "REAL" SORT BY net_7d DESC LIMIT 20' },
    { id: 'monthly', icon: '🗓️', label: 'Top mensual', q: 'stage != "REAL" SORT BY net_30d DESC LIMIT 20' },
    { id: 'consistency', icon: '📊', label: 'Consistencia', q: 'months_active >= 3 AND stage != "REAL" SORT BY consistency DESC LIMIT 20' },
    { id: 'stability', icon: '📐', label: 'Estabilidad', q: 'trades >= 30 AND stage != "REAL" SORT BY stability DESC LIMIT 20' },
    { id: 'sharpe', icon: '⚡', label: 'Sharpe', q: 'trades >= 30 AND stage != "REAL" SORT BY sharpe DESC LIMIT 20' },
    { id: 'recovery', icon: '🔄', label: 'Recovery', q: 'trades >= 30 AND stage != "REAL" SORT BY recovery DESC LIMIT 20' },
    { id: 'lowdd', icon: '🛡️', label: 'Menor DD', q: 'trades >= 30 AND net > 0 AND stage != "REAL" SORT BY dd_pct ASC LIMIT 20' },
    { id: 'science', icon: '🔬', label: 'Score científico', q: 'evidence_tier != "UNKNOWN" SORT BY scientific_score DESC LIMIT 20' },
    { id: 'promotion', icon: '🎯', label: 'Score promoción', q: 'stage = "CANDIDATE" OR stage = "OBSERVATION" SORT BY score_shrunk DESC LIMIT 20' },
    { id: 'improving', icon: '📈', label: 'Mejorando', q: 'trades >= 30 AND stage != "REAL" SORT BY improvement DESC LIMIT 20' },
  ];

  const CSS = `
    #preset-views { display:flex; flex-wrap:wrap; gap:6px; margin:14px 0 4px; align-items:center; }
    #preset-views .pv-label { font-size:.75rem; opacity:.6; margin-right:4px; }
    .pv-chip { font-size:.76rem; padding:4px 10px; border-radius:999px; cursor:pointer;
               border:1px solid rgba(128,128,128,.35); background:rgba(128,128,128,.08);
               color:inherit; }
    .pv-chip:hover { border-color:rgba(128,128,128,.7); }
    .pv-chip.active { border-color:#7a8ff0; color:#7a8ff0; font-weight:700; }
  `;

  function applyPreset(view, chip) {
    const section = document.getElementById('query-bar-section');
    const input = document.getElementById('query-input');
    if (!section || !input) return;
    section.hidden = false;
    input.value = view.q;
    // El listener de app.js (debounce 250ms) ejecuta applyQuery — misma ruta
    // que teclear a mano: una sola fuente de verdad para el ranking.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelectorAll('.pv-chip').forEach((c) => c.classList.remove('active'));
    if (chip) chip.classList.add('active');
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function render() {
    const anchor = document.getElementById('query-bar-section');
    if (!anchor || document.getElementById('preset-views')) return;
    const host = document.createElement('div');
    host.id = 'preset-views';
    const lbl = document.createElement('span');
    lbl.className = 'pv-label';
    lbl.textContent = 'Vistas:';
    host.appendChild(lbl);
    for (const v of PRESET_VIEWS) {
      const chip = document.createElement('button');
      chip.className = 'pv-chip';
      chip.type = 'button';
      chip.textContent = `${v.icon} ${v.label}`;
      chip.title = v.q;
      chip.addEventListener('click', () => applyPreset(v, chip));
      host.appendChild(chip);
    }
    anchor.parentNode.insertBefore(host, anchor);
  }

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }
})();
