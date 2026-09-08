// cc/ui/accordion.js — divulgacion progresiva.
// Primera seccion abierta, el resto plegado: el Bot 360 tiene 10 bloques y
// abrirlos todos de golpe es exactamente el muro de datos que se quiere evitar.

import { esc } from './fmt.js';

/**
 * @param {Array<{key:string,title:string,badge?:string,html:string,open?:boolean}>} sections
 */
export function accordion(sections) {
  return `<div class="cc-stack">${sections.map((s, i) => `
    <section class="cc-acc${s.open ?? i === 0 ? ' is-open' : ''}" data-acc="${esc(s.key)}">
      <button class="cc-acc__head" type="button" aria-expanded="${s.open ?? i === 0}">
        <span class="cc-acc__key">${esc(s.key)}</span>
        <span class="cc-acc__title">${esc(s.title)}</span>
        ${s.badge || ''}
        <span class="cc-acc__caret" aria-hidden="true">›</span>
      </button>
      <div class="cc-acc__body"${(s.open ?? i === 0) ? '' : ' hidden'}>${s.html}</div>
    </section>`).join('')}</div>`;
}

/** Delega los clics de cabecera dentro de `root`. Devuelve la funcion de baja. */
export function wireAccordion(root, onToggle) {
  const handler = (ev) => {
    const head = ev.target.closest('.cc-acc__head');
    if (!head || !root.contains(head)) return;
    const sec = head.parentElement;
    const body = sec.querySelector('.cc-acc__body');
    const open = !sec.classList.contains('is-open');
    sec.classList.toggle('is-open', open);
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    if (open && typeof onToggle === 'function') onToggle(sec.dataset.acc, sec);
  };
  root.addEventListener('click', handler);
  return () => root.removeEventListener('click', handler);
}

/** Abre una seccion por su clave (para los deep links ?section=D). */
export function openSection(root, key) {
  if (!key) return;
  const sec = root.querySelector(`[data-acc="${CSS.escape(String(key))}"]`);
  if (!sec) return;
  sec.classList.add('is-open');
  const body = sec.querySelector('.cc-acc__body');
  if (body) body.hidden = false;
  const head = sec.querySelector('.cc-acc__head');
  if (head) head.setAttribute('aria-expanded', 'true');
  sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
