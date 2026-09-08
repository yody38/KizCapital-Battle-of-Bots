// cc/views/health.js — Salud del sistema.
//
// Una sola pantalla con las 6 VPS, el pipeline, los watchdogs y la frescura.
// Cuando una VPS esta atrasada, ausente o entrega un snapshot ilegible se
// levanta un panel explicito arriba: eso es exactamente lo que hay que ver a
// las 6 de la manana, no un punto de color en una esquina.
//
// La severidad NO se reinventa aqui: se lee `result` / `fails_data` /
// `fails_infra` de watchdog_status.json, que ya viene clasificada por
// scripts/integrity_watchdog.py.

import { esc, int, num, dateTime, vpsName } from '../ui/fmt.js';
import { metric, metricGrid, emptyState } from '../ui/kpi.js';
import { badge, severityBadge } from '../ui/badge.js';
import { freshnessBadge } from '../ui/freshness-badge.js';
import { fetchJson } from '../data/fetch.js';
import { humanAge, snapshotState } from '../data/freshness.js';
import { realPortfolio } from '../data/model.js';

let elRef = null;
let ctxRef = null;
let token = 0;

export function mount(el, params, ctx) {
  elRef = el; ctxRef = ctx;
  const my = ++token;
  ctx.layout.setTitle('Salud del sistema');
  ctx.layout.setExtra(freshnessBadge(ctx.meta()));
  el.innerHTML = '<div class="cc-skeleton" style="height:220px"></div>';

  Promise.all([
    fetchJson('watchdog_status.json'),
    fetchJson('mcp_health.json'),
    fetchJson('pipeline_timing.json'),
    fetchJson('upload_health.json'),
    fetchJson('integrity_report.json'),
  ]).then(([wd, mcp, timing, upload, integrity]) => {
    if (my !== token) return;
    render({ wd, mcp, timing, upload, integrity });
  });
}

export function unmount() { token++; elRef = null; ctxRef = null; }

function render(f) {
  const snap = ctxRef.snapshot();
  const meta = ctxRef.meta();
  if (!snap) {
    elRef.innerHTML = emptyState('Sin ciclo',
      'data/snapshot.json no se pudo leer, asi que no se puede evaluar la salud del pipeline.', true);
    return;
  }
  const vf = snap.vps_freshness || {};
  const problems = Object.entries(vf).filter(([, v]) => v && (v.present === false || v.stale || v.corrupt || v.error || v.carried_forward));
  const rp = realPortfolio(snap);

  elRef.innerHTML = `
    ${problems.length ? problemPanel(problems) : `<div class="cc-banner cc-banner--ok">
      Las ${esc(Object.keys(vf).length)} VPS entregaron su snapshot a tiempo en este ciclo.</div>`}
    ${rp.disconnected.length ? `<div class="cc-banner cc-banner--crit">
      <div><strong>${esc(rp.disconnected.length)} cuenta(s) real(es) desconectada(s)</strong>
      <span class="cc-small"> · ${esc(rp.disconnected.map((a) => `#${a.login} en ${vpsName(a.vps)}`).join(', '))}.
      Sus cifras se heredan del ultimo ciclo con dato y siguen en la cesta.</span></div></div>` : ''}

    ${cycleBlock(snap, meta)}
    ${vpsBlock(vf, snap)}
    ${watchdogBlock(f.wd)}
    ${mcpBlock(f.mcp)}
    ${timingBlock(f.timing)}
    ${uploadBlock(f.upload)}
    ${integrityBlock(f.integrity)}
    ${healthMetricsBlock(snap)}`;

  elRef.addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-acct]');
    if (go) location.hash = go.dataset.acct;
  });
}

function problemPanel(problems) {
  return `<section class="cc-banner cc-banner--crit">
    <div style="width:100%">
      <strong>${problems.length} VPS con problema en este ciclo</strong>
      <table class="cc-table" style="margin-top:8px">
        <thead><tr><th>VPS</th><th>Sintoma</th><th class="num">Retraso</th><th>Ultimo dato</th><th class="num">Bots</th></tr></thead>
        <tbody>${problems.map(([id, v]) => `<tr>
          <td><strong>${esc(vpsName(id))}</strong></td>
          <td>${esc(symptom(v))}</td>
          <td class="num">${v.lag_sec == null ? '—' : esc(humanAge(v.lag_sec))}</td>
          <td>${esc(v.generated_at ? dateTime(v.generated_at) : '—')}</td>
          <td class="num">${v.bot_count == null ? '—' : esc(int(v.bot_count))}</td>
        </tr>`).join('')}</tbody>
      </table>
      <p class="cc-xs" style="margin:8px 0 0">Sus curvas estan CONGELADAS: los bots de esas VPS no se comparan
        contra los del resto en igualdad de condiciones hasta que vuelvan a publicar.</p>
    </div>
  </section>`;
}

function symptom(v) {
  if (v.present === false) return 'no respondio (sin snapshot_<vps>.json en el merge)';
  if (v.corrupt || v.error) return `snapshot ilegible: ${v.error || 'JSON corrupto'}`;
  if (v.stale) return 'atrasada mas de 90 min (3 ciclos perdidos)';
  if (v.carried_forward) return 'servida con datos heredados del ultimo ciclo bueno';
  return 'estado desconocido';
}

function cycleBlock(snap, meta) {
  const st = snapshotState(snap.generated_at);
  return `<section class="cc-card">
    <div class="cc-card__head">
      <span class="cc-card__title">Ciclo</span>
      ${severityBadge(st.state === 'fresh' ? 'ok' : st.state === 'aging' ? 'warn' : 'fail')}
      <span class="cc-card__spacer"></span>
      ${freshnessBadge(meta)}
    </div>
    ${metricGrid([
      metric('Generado', dateTime(snap.generated_at)),
      metric('Edad', humanAge(st.age_sec), st.state === 'fresh' ? 'cc-pos' : st.state === 'aging' ? 'cc-warn' : 'cc-neg'),
      metric('Fuente mas vieja', dateTime(snap.oldest_source_generated_at || snap.generated_at)),
      metric('Ciclo parcial', String(!!snap.partial_data), snap.partial_data ? 'cc-warn' : 'cc-pos'),
      metric('Bots', int((snap.bots || []).length)),
      metric('Cuentas', int((snap.accounts || []).length)),
      metric('Reconciliado', dateTime(snap.reconciled_at)),
      metric('Ventana', `${esc(snap.window_days ?? '—')} d`),
    ])}
    <p class="cc-xs cc-faint">Umbrales unicos (cc/data/freshness.js): fresco &lt; 25 min · envejeciendo 25-45 min ·
      rancio &gt; 45 min, que es el <code>SNAPSHOT_MAX_AGE_SEC</code> de mirror.sh.</p>
  </section>`;
}

function vpsBlock(vf, snap) {
  const ids = Object.keys(vf);
  if (!ids.length) {
    return `<section class="cc-stack"><div class="cc-section-title"><h2>VPS</h2></div>
      ${emptyState('Sin vps_freshness', 'El ciclo no publico el detalle por VPS.')}</section>`;
  }
  const sources = snap.vps_sources || {};
  return `<section class="cc-stack">
    <div class="cc-section-title"><h2>VPS</h2>
      <span class="cc-faint cc-small">${ids.length} maquinas · numeracion canonica del owner</span></div>
    <div class="cc-scroll-x"><table class="cc-table">
      <thead><tr><th>VPS</th><th>Estado</th><th class="num">Retraso</th><th>Generado</th>
        <th class="num">Bots</th><th class="num">Cuentas</th><th>Notas</th></tr></thead>
      <tbody>${ids.map((id) => {
        const v = vf[id] || {};
        const sev = v.present === false || v.corrupt || v.error ? 'fail'
          : v.stale || v.carried_forward ? 'warn' : 'ok';
        const src = sources[id] || {};
        return `<tr>
          <td><strong>${esc(vpsName(id))}</strong></td>
          <td>${severityBadge(sev)}</td>
          <td class="num">${v.lag_sec == null ? '—' : esc(humanAge(v.lag_sec))}</td>
          <td>${esc(v.generated_at ? dateTime(v.generated_at) : '—')}</td>
          <td class="num">${v.bot_count == null ? esc(int(src.bot_count)) : esc(int(v.bot_count))}</td>
          <td class="num">${esc(int(src.account_count))}</td>
          <td class="cc-xs cc-faint">${v.carried_forward ? 'datos heredados' : v.error ? esc(v.error) : ''}</td>
        </tr>`;
      }).join('')}</tbody></table></div>
  </section>`;
}

function watchdogBlock(wd) {
  if (!wd || !wd.data) {
    return card('Watchdog de integridad',
      emptyState('Sin data/watchdog_status.json',
        wd && wd.meta && wd.meta.error ? `No se pudo leer (${wd.meta.error}).` : 'Todavia no se ha publicado ningun resultado.'),
      wd && wd.meta);
  }
  const d = wd.data;
  const fails = d.fails || [];
  const fdata = d.fails_data || [];
  const finfra = d.fails_infra || [];
  return card('Watchdog de integridad', `
    <div class="cc-row">
      ${severityBadge(d.result)}
      ${badge(`${fdata.length} de datos`, fdata.length ? 'crit' : 'pos')}
      ${badge(`${finfra.length} de infra`, finfra.length ? 'warn' : 'pos')}
      <span class="cc-faint cc-small">${esc(dateTime(d.ts))} · ${esc(int(d.duration_ms))} ms</span>
    </div>
    ${fails.length ? `<ul class="cc-small">${fails.map((x) => `<li class="${fdata.includes(x) ? 'cc-neg' : 'cc-warn'}">${esc(x)}</li>`).join('')}</ul>`
      : '<p class="cc-small cc-pos" style="margin:0">Sin fallos en la ultima pasada.</p>'}
    ${(d.warns || []).length ? `<details><summary class="cc-xs cc-muted" style="cursor:pointer">${d.warns.length} avisos</summary>
      <ul class="cc-xs cc-faint">${d.warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
    ${d.steps ? `<details><summary class="cc-xs cc-muted" style="cursor:pointer">Detalle tecnico</summary>
      <div class="cc-raw">${esc(JSON.stringify(d.steps, null, 2))}</div></details>` : ''}
    <p class="cc-xs cc-faint">La severidad viene ya clasificada del backend (<code>fails_data</code> vs
      <code>fails_infra</code>): el shell no vuelve a decidirla, para que las dos UIs no puedan discrepar.</p>`,
    wd.meta);
}

function mcpBlock(mcp) {
  if (!mcp || !mcp.data) {
    return card('MCP servers', emptyState('Sin data/mcp_health.json', 'El ping de salud no publico resultados.'), mcp && mcp.meta);
  }
  const d = mcp.data;
  const servers = Array.isArray(d.servers) ? d.servers
    : (d.results && Array.isArray(d.results) ? d.results : null);
  if (!servers) {
    return card('MCP servers', `<div class="cc-raw">${esc(JSON.stringify(d, null, 2))}</div>`, mcp.meta);
  }
  const ok = servers.filter((s) => s.ok || s.status === 'ok').length;
  return card('MCP servers', `
    <div class="cc-row">${badge(`${ok}/${servers.length} vivos`, ok === servers.length ? 'pos' : 'warn')}</div>
    <div class="cc-scroll-x"><table class="cc-table">
      <thead><tr><th>Servidor</th><th>Estado</th><th class="num">Latencia</th><th>Detalle</th></tr></thead>
      <tbody>${servers.map((s) => `<tr>
        <td>${esc(s.name || s.id || s.vps || '—')}</td>
        <td>${severityBadge((s.ok || s.status === 'ok') ? 'ok' : 'fail')}</td>
        <td class="num">${s.latency_ms == null ? '—' : esc(int(s.latency_ms)) + ' ms'}</td>
        <td class="cc-xs cc-faint">${esc(s.error || s.detail || '')}</td>
      </tr>`).join('')}</tbody></table></div>`, mcp.meta);
}

function timingBlock(t) {
  if (!t || !t.data) {
    return card('Tiempos del pipeline', emptyState('Sin data/pipeline_timing.json', 'El ciclo no publico tiempos.'), t && t.meta);
  }
  const d = t.data;
  const stages = d.stages || d.steps || null;
  return card('Tiempos del pipeline', `
    ${metricGrid([
      metric('Ultimo ciclo', dateTime(d.generated_at || d.ts)),
      metric('Duracion total', d.total_sec == null ? '—' : `${num(d.total_sec, 1)} s`),
      metric('p50', d.p50_sec == null ? '—' : `${num(d.p50_sec, 1)} s`),
      metric('p95', d.p95_sec == null ? '—' : `${num(d.p95_sec, 1)} s`),
    ])}
    ${stages ? `<div class="cc-raw">${esc(JSON.stringify(stages, null, 2))}</div>` : ''}`, t.meta);
}

function uploadBlock(u) {
  if (!u || !u.data) {
    return card('Subida a Storage', emptyState('Sin data/upload_health.json', 'El paso de subida no publico su resultado.'), u && u.meta);
  }
  const d = u.data;
  return card('Subida a Storage', `
    ${metricGrid([
      metric('Archivos', int(d.uploaded ?? d.files ?? d.total)),
      metric('Fallos', int(d.failed ?? 0), (d.failed ?? 0) ? 'cc-neg' : 'cc-pos'),
      metric('Cuando', dateTime(d.ts || d.generated_at)),
      metric('Bytes', d.bytes == null ? '—' : int(d.bytes)),
    ])}`, u.meta);
}

function integrityBlock(i) {
  if (!i || !i.data) {
    return card('Verificacion de integridad', emptyState('Sin data/integrity_report.json', 'El verificador no publico su informe.'), i && i.meta);
  }
  const d = i.data;
  const checks = d.checks || d.results || null;
  return card('Verificacion de integridad', `
    <div class="cc-row">${severityBadge(d.status || d.result)}
      <span class="cc-faint cc-small">${esc(dateTime(d.generated_at || d.ts))}</span></div>
    ${Array.isArray(checks) ? `<div class="cc-scroll-x"><table class="cc-table">
      <thead><tr><th>Comprobacion</th><th>Estado</th><th>Detalle</th></tr></thead>
      <tbody>${checks.map((c) => `<tr>
        <td>${esc(c.name || c.check || '—')}</td>
        <td>${severityBadge(c.ok === false ? 'fail' : c.status || (c.ok ? 'ok' : 'unknown'))}</td>
        <td class="cc-xs cc-faint">${esc(c.detail || c.message || '')}</td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="cc-raw">${esc(JSON.stringify(d, null, 2))}</div>`}`, i.meta);
}

function healthMetricsBlock(snap) {
  const hm = snap.health_metrics;
  if (!hm) return '';
  return card('Metricas de disponibilidad', metricGrid([
    metric('Uptime 30d', hm.uptime_pct_30d == null ? '—' : `${num(hm.uptime_pct_30d, 2)}%`,
      (hm.uptime_pct_30d ?? 100) >= 97 ? 'cc-pos' : (hm.uptime_pct_30d ?? 0) >= 90 ? 'cc-warn' : 'cc-neg'),
    metric('Muestras 30d', int(hm.heartbeat_samples_30d)),
    metric('Retraso medio 7d', hm.mean_lag_sec_7d == null ? '—' : humanAge(hm.mean_lag_sec_7d)),
    metric('Retraso maximo 7d', hm.max_lag_sec_7d == null ? '—' : humanAge(hm.max_lag_sec_7d)),
    metric('Recuperaciones 7d', int(hm.recovery_count_7d)),
  ]), null);
}

function card(title, body, meta) {
  return `<section class="cc-card">
    <div class="cc-card__head">
      <span class="cc-card__title">${esc(title)}</span>
      <span class="cc-card__spacer"></span>
      ${meta ? freshnessBadge(meta) : ''}
    </div>
    ${body}
  </section>`;
}
