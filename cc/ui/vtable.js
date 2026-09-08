// cc/ui/vtable.js — tabla virtualizada sin dependencias.
//
// Como aguanta 10.000 filas sin bloquear:
//  · altura de fila FIJA -> la posicion de cualquier fila es aritmetica, no hay
//    que medir nada;
//  · un unico div espaciador de rows*rowHeight px da la barra de scroll real;
//  · solo se pintan las filas visibles + 20 de sobre-render (overscan) arriba y
//    abajo, asi que un scroll rapido no deja huecos en blanco;
//  · los nodos de fila se REUTILIZAN (pool): al desplazarse no se crea ni se
//    destruye DOM, solo se reposiciona con transform y se reescribe el texto de
//    las celdas. Cero innerHTML masivo;
//  · el handler de scroll solo marca "sucio" y el trabajo va en un
//    requestAnimationFrame, asi que N eventos de scroll = 1 repintado por frame.

const OVERSCAN = 20;

/**
 * @param {HTMLElement} host
 * @param {{
 *   columns: Array<{key:string,label:string,width:number,align?:string,
 *                   render?:(row:any)=>string, text?:(row:any)=>string,
 *                   sortValue?:(row:any)=>any, sortable?:boolean, title?:string}>,
 *   rowHeight?: number,
 *   height?: number|string,
 *   onRowClick?: (row:any, index:number)=>void,
 *   rowClass?: (row:any)=>string,
 *   emptyHtml?: string,
 *   footer?: boolean,
 * }} opts
 */
export function createVTable(host, opts) {
  const columns = (opts.columns || []).slice();
  const rowHeight = opts.rowHeight || 34;
  const totalWidth = columns.reduce((s, c) => s + (c.width || 120), 0);

  let rows = [];
  let view = [];              // filas ya ordenadas (lo que se pinta)
  let sortKey = null;
  let sortDir = 'desc';
  let dirty = false;
  let rafId = 0;
  let lastFirst = -1;
  let lastCount = -1;
  const pool = [];            // {el, cells:[]}

  host.innerHTML = '';
  host.classList.add('cc-vtable');

  const scrollX = el('div', 'cc-vtable__scroll-x');
  const inner = el('div', 'cc-vtable__inner');
  inner.style.width = totalWidth + 'px';

  const head = el('div', 'cc-vtable__head');
  const hcells = columns.map((c, i) => {
    const h = el('div', 'cc-vtable__hcell' + (c.align === 'num' ? ' cc-vtable__hcell--num' : ''));
    h.style.width = (c.width || 120) + 'px';
    h.textContent = c.label;
    if (c.title) h.title = c.title;
    if (c.sortable !== false) {
      h.addEventListener('click', () => toggleSort(c.key));
    } else {
      h.style.cursor = 'default';
    }
    head.appendChild(h);
    return h;
  });

  const viewport = el('div', 'cc-vtable__viewport');
  const vh = opts.height == null ? 560 : opts.height;
  viewport.style.height = typeof vh === 'number' ? vh + 'px' : vh;

  const spacer = el('div', 'cc-vtable__spacer');
  viewport.appendChild(spacer);

  const emptyBox = el('div', 'cc-empty');
  emptyBox.hidden = true;

  inner.appendChild(head);
  inner.appendChild(viewport);
  scrollX.appendChild(inner);
  host.appendChild(scrollX);
  host.appendChild(emptyBox);

  const foot = opts.footer === false ? null : el('div', 'cc-vtable__foot');
  if (foot) host.appendChild(foot);

  viewport.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  viewport.addEventListener('click', (ev) => {
    if (typeof opts.onRowClick !== 'function') return;
    const rowEl = ev.target.closest('.cc-vtable__row');
    if (!rowEl || !viewport.contains(rowEl)) return;
    const idx = Number(rowEl.dataset.index);
    if (!Number.isFinite(idx) || !view[idx]) return;
    opts.onRowClick(view[idx], idx);
  });

  function el(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function schedule() {
    dirty = true;
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; if (dirty) paint(); });
  }

  function sortValueOf(col, row) {
    if (col && typeof col.sortValue === 'function') return col.sortValue(row);
    return row ? row[col.key] : null;
  }

  function applySort() {
    view = rows.slice();
    if (!sortKey) return;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return;
    const dir = sortDir === 'desc' ? -1 : 1;
    view.sort((a, b) => {
      const va = sortValueOf(col, a);
      const vb = sortValueOf(col, b);
      // null SIEMPRE al final, en los dos sentidos: un dato ausente no puede
      // ganarle a uno real solo por ordenar al reves.
      const na = va == null || va === '';
      const nb = vb == null || vb === '';
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'string' || typeof vb === 'string') {
        return dir * String(va).localeCompare(String(vb));
      }
      return dir * (Number(va) - Number(vb));
    });
  }

  function toggleSort(key) {
    if (sortKey === key) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    else { sortKey = key; sortDir = 'desc'; }
    hcells.forEach((h, i) => {
      const on = columns[i].key === sortKey;
      h.classList.toggle('is-sorted', on);
      h.textContent = columns[i].label + (on ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '');
    });
    applySort();
    lastFirst = -1;           // fuerza repintado completo
    viewport.scrollTop = 0;
    paint();
  }

  function ensurePool(n) {
    while (pool.length < n) {
      const rowEl = el('div', 'cc-vtable__row');
      rowEl.style.height = rowHeight + 'px';
      const cells = columns.map((c) => {
        const cell = el('div', 'cc-vtable__cell' + (c.align === 'num' ? ' cc-vtable__cell--num' : ''));
        cell.style.width = (c.width || 120) + 'px';
        rowEl.appendChild(cell);
        return cell;
      });
      spacer.appendChild(rowEl);
      pool.push({ el: rowEl, cells });
    }
  }

  function paint() {
    dirty = false;
    const total = view.length;
    spacer.style.height = (total * rowHeight) + 'px';
    emptyBox.hidden = total > 0;
    if (!total) {
      emptyBox.innerHTML = opts.emptyHtml || '<strong>Sin filas</strong>No hay bots que cumplan estos filtros.';
      for (const p of pool) p.el.hidden = true;
      if (foot) foot.textContent = '0 filas';
      return;
    }

    const vpH = viewport.clientHeight || 1;
    const first = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - OVERSCAN);
    const visible = Math.ceil(vpH / rowHeight) + OVERSCAN * 2;
    const count = Math.min(visible, total - first);

    ensurePool(count);

    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (i >= count) { p.el.hidden = true; continue; }
      const idx = first + i;
      const row = view[idx];
      p.el.hidden = false;
      p.el.style.transform = `translateY(${idx * rowHeight}px)`;
      p.el.dataset.index = String(idx);
      const extra = typeof opts.rowClass === 'function' ? (opts.rowClass(row) || '') : '';
      p.el.className = 'cc-vtable__row' + (extra ? ' ' + extra : '');
      for (let c = 0; c < columns.length; c++) {
        const col = columns[c];
        const cell = p.cells[c];
        if (typeof col.render === 'function') {
          const html = col.render(row, idx);
          if (cell.__html !== html) { cell.innerHTML = html; cell.__html = html; }
        } else {
          const text = typeof col.text === 'function' ? col.text(row, idx) : String(row[col.key] ?? '');
          if (cell.textContent !== text) cell.textContent = text;
          cell.__html = undefined;
        }
      }
    }

    lastFirst = first;
    lastCount = count;
    if (foot) {
      foot.textContent = `${total.toLocaleString('es-ES')} filas · pintadas ${count}`
        + (sortKey ? ` · orden ${sortKey} ${sortDir}` : '');
    }
  }

  return {
    setRows(next) {
      rows = Array.isArray(next) ? next : [];
      applySort();
      viewport.scrollTop = 0;
      lastFirst = -1;
      paint();
    },
    sortBy(key, dir = 'desc') {
      sortKey = key; sortDir = dir;
      hcells.forEach((h, i) => {
        const on = columns[i].key === sortKey;
        h.classList.toggle('is-sorted', on);
        h.textContent = columns[i].label + (on ? (sortDir === 'desc' ? ' ↓' : ' ↑') : '');
      });
      applySort();
      lastFirst = -1;
      paint();
    },
    rowsShown() { return view.length; },
    visibleCount() { return lastCount; },
    poolSize() { return pool.length; },
    scrollTo(px) { viewport.scrollTop = px; paint(); },
    repaint: paint,
    destroy() {
      window.removeEventListener('resize', schedule);
      if (rafId) cancelAnimationFrame(rafId);
      host.innerHTML = '';
      pool.length = 0;
    },
  };
}
