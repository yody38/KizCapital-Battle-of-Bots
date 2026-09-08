// cc/ui/layout.js — el chasis: sidebar + contenido en escritorio, barra
// inferior de 5 destinos en movil (los que el owner mira desde el telefono:
// Salud, Dinero real, Atencion, Bots y Cartera).

import { esc } from './fmt.js';

const NAV = [
  { route: '#/home', name: 'home', icon: '◎', label: 'Home' },
  { route: '#/real', name: 'real', icon: '◆', label: 'Dinero real', real: true },
  { route: '#/fleet', name: 'fleet', icon: '▤', label: 'Flota' },
  { route: '#/promotion', name: 'promotion', icon: '▲', label: 'Promocion' },
  { route: '#/portfolio', name: 'portfolio', icon: '◈', label: 'Cartera y riesgo' },
  { route: '#/health', name: 'health', icon: '✚', label: 'Salud' },
];

const MOBILE = ['health', 'real', 'home', 'fleet', 'portfolio'];

export function mountLayout(root, { email } = {}) {
  root.innerHTML = `
    <div class="cc-shell">
      <aside class="cc-sidebar">
        <div class="cc-brand">
          <span class="cc-brand__mark">KIZ</span>
          <span class="cc-brand__sub">Command Center</span>
        </div>
        <nav class="cc-nav" id="cc-nav">
          ${NAV.map((n) => `
            <a class="cc-nav__link${n.real ? ' cc-nav__link--real' : ''}" data-route="${n.name}" href="${n.route}">
              <span class="cc-nav__icon" aria-hidden="true">${n.icon}</span>
              <span class="cc-nav__label">${esc(n.label)}</span>
            </a>`).join('')}
        </nav>
        <div class="cc-sidebar__foot">
          <a href="/index.html">↩ Dashboard clasico</a>
          <span id="cc-user">${email ? esc(email) : 'sin sesion'}</span>
        </div>
      </aside>
      <div class="cc-main">
        <header class="cc-topbar">
          <span class="cc-topbar__title" id="cc-title">—</span>
          <span class="cc-topbar__spacer"></span>
          <span id="cc-topbar-extra" class="cc-row"></span>
        </header>
        <main class="cc-view" id="cc-view" tabindex="-1"></main>
      </div>
    </div>
    <nav class="cc-bottomnav" id="cc-bottomnav">
      ${MOBILE.map((name) => {
        const n = NAV.find((x) => x.name === name);
        return `<a class="cc-bottomnav__link${n.real ? ' cc-bottomnav__link--real' : ''}" data-route="${n.name}" href="${n.route}">
          <span class="cc-bottomnav__icon" aria-hidden="true">${n.icon}</span>
          <span>${esc(n.label)}</span>
        </a>`;
      }).join('')}
    </nav>`;

  let view = root.querySelector('#cc-view');
  const titleEl = root.querySelector('#cc-title');
  const extraEl = root.querySelector('#cc-topbar-extra');

  return {
    get view() { return view; },
    /**
     * Sustituye el contenedor por un nodo NUEVO antes de montar cada vista.
     * Vaciar el innerHTML no bastaba: las vistas que delegan clics sobre el
     * contenedor dejaban su listener vivo y seguia disparando en la vista
     * siguiente (una fila de otra pantalla podia navegar sola). Con un nodo
     * nuevo, los listeners de la vista anterior mueren con el.
     */
    resetView() {
      const fresh = document.createElement('main');
      fresh.className = 'cc-view';
      fresh.id = 'cc-view';
      fresh.tabIndex = -1;
      view.replaceWith(fresh);
      view = fresh;
      return fresh;
    },
    setTitle(text) { titleEl.textContent = text; document.title = `${text} · KIZ Command Center`; },
    setExtra(html) { extraEl.innerHTML = html || ''; },
    setActive(name) {
      // Bot 360 y Account 360 se alcanzan desde Flota / Dinero real: se marca
      // ese origen para que la navegacion no parezca perder el sitio.
      const eff = name === 'bot' ? 'fleet' : name === 'account' ? 'real' : name;
      for (const a of root.querySelectorAll('[data-route]')) {
        a.classList.toggle('is-active', a.dataset.route === eff);
      }
    },
    focus() { try { view.focus({ preventScroll: true }); } catch { /* navegador viejo */ } },
  };
}

export { NAV };
