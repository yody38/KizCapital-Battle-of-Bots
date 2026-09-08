// cc/app.js — arranque del KIZ Command Center.
//
// Secuencia: sesion lista -> snapshot del ciclo -> chasis -> router. El
// snapshot se pide UNA vez y lo comparten todas las vistas, asi que cambiar de
// ruta no vuelve a bajar megas.
//
// Este shell convive con el dashboard legacy sin tocarlo: index.html, app.js,
// styles.css y sw.js siguen exactamente igual.

import * as router from './router.js';
import * as session from './session.js';
import * as snapshotStore from './data/snapshot.js';
import * as live from './data/live.js';
import { mountLayout } from './ui/layout.js';
import { emptyState } from './ui/kpi.js';

const VIEWS = {
  home: () => import('./views/home.js'),
  fleet: () => import('./views/fleet.js'),
  bot: () => import('./views/bot.js'),
  account: () => import('./views/account.js'),
  real: () => import('./views/real.js'),
  promotion: () => import('./views/promotion.js'),
  portfolio: () => import('./views/portfolio.js'),
  health: () => import('./views/health.js'),
};

let layout = null;
let currentView = null;
let currentName = null;
let mountToken = 0;
// [FIX 2026-09-08] Cola de montaje. En el arranque hay TRES llamadas a
// mountRoute compitiendo: router.start(), el callback de subscribe cuando
// llega el snapshot, y el montaje final tras `await loading`. Como mountRoute
// es async y espera un import dinamico, las tres se entrelazaban y habia un
// orden en el que TODAS abortaban por el testigo de version: la pantalla se
// quedaba en blanco, de forma intermitente. Se vio en #/real, que es
// justamente la vista del dinero. Serializando, la ultima llamada siempre
// gana y siempre pinta.
let mountChain = Promise.resolve();
let booted = false;

const ctx = {
  snapshot: () => snapshotStore.peek().data,
  meta: () => snapshotStore.peek().meta,
  live,
  router,
  navigate: router.navigate,
  build: router.build,
  get layout() { return layout; },
};

async function boot() {
  const root = document.getElementById('cc-root');
  if (!root) return;

  root.innerHTML = '<div style="padding:32px;color:#9aa3bb">Verificando la sesion…</div>';
  const email = await session.ready();

  layout = mountLayout(root, { email });
  layout.view.innerHTML = '<div style="padding:16px;color:#9aa3bb">Cargando el ciclo…</div>';

  // El snapshot arranca en paralelo con el router: la primera vista pinta su
  // esqueleto y se rellena en cuanto llega el dato.
  const loading = snapshotStore.getSnapshot();
  snapshotStore.initPush();
  // Hasta que el arranque no termina, el snapshot que llega no dispara un
  // remontaje: de eso ya se encarga el montaje final de abajo.
  snapshotStore.subscribe(() => { if (booted && currentName) mountRoute(router.route(), true); });

  router.onChange((r) => mountRoute(r));
  router.start();

  await loading;
  await mountRoute(router.route(), true);
  booted = true;
}

function mountRoute(r, force = false) {
  if (!r || !layout) return Promise.resolve();
  const key = r.name + '|' + JSON.stringify(r.params) + '|' + JSON.stringify(r.query);
  if (!force && key === currentName) return Promise.resolve();
  currentName = key;
  // El testigo se toma AQUI, no dentro del async: asi una navegacion posterior
  // invalida a las anteriores aunque todavia esten en la cola.
  const my = ++mountToken;
  mountChain = mountChain.then(() => doMountRoute(r, my)).catch((err) => {
    console.error('[cc] mountRoute lanzo', err);
  });
  return mountChain;
}

async function doMountRoute(r, my) {
  if (my !== mountToken) return;   // ya se navego a otra ruta
  if (currentView && typeof currentView.unmount === 'function') {
    try { currentView.unmount(); } catch (err) { console.error('[cc] unmount lanzo', err); }
  }
  currentView = null;
  layout.setActive(r.name);
  // Nodo nuevo, no innerHTML = '': mata los listeners delegados de la vista
  // anterior (si no, un clic en la pantalla siguiente podia dispararlos).
  layout.resetView();

  const loader = VIEWS[r.name] || VIEWS.home;
  let mod;
  try {
    mod = await loader();
  } catch (err) {
    layout.view.innerHTML = emptyState('No se pudo cargar la vista',
      `El modulo de "${r.name}" fallo al importarse: ${(err && err.message) || err}`, true);
    return;
  }
  if (my !== mountToken) return;   // se navego mientras se importaba

  try {
    mod.mount(layout.view, r, ctx);
    currentView = mod;
    layout.focus();
  } catch (err) {
    console.error('[cc] mount lanzo', err);
    layout.view.innerHTML = emptyState('La vista fallo al pintarse',
      (err && err.message) || String(err), true);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

// Expuesto solo para la pagina de desarrollo cc/dev/fixture.html.
window.__ccShell = { ctx, router, snapshotStore, live, mountRoute, boot };
