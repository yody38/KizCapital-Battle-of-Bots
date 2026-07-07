// Kiz Capital · Battle of Bots — Service Worker (F4)
// Precachea la app shell (carga instantánea + modo offline con últimos datos)
// y da fallback offline a los JSON de datos firmados de Supabase Storage
// (network-first). NUNCA toca /rest/v1, /auth/v1 ni Realtime (live directo).
// VERSION debe ir en sync con el pin ?v= de index.html — bump en cada deploy
// que cambie app.js/styles.css/data-source.js para no servir código viejo.

const VERSION = '20260707c';
const SHELL_CACHE = `kiz-shell-${VERSION}`;
const DATA_CACHE = 'kiz-data-v1';
const FONT_CACHE = 'kiz-fonts-v1';

// Nota: solo '/' (no '/index.html') — Vercel cleanUrls redirige index.html → /.
const SHELL = [
  '/',
  `/app.js?v=${VERSION}`,
  `/styles.css?v=${VERSION}`,
  `/data-source.js?v=${VERSION}`,
  '/supabase-client.js?v=20260513d',
  '/auth-guard.js?v=20260513d',
  '/vendor/chart.umd.min.js',
  '/vendor/chartjs-adapter-date-fns.bundle.min.js',
  '/vendor/supabase.min.js',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('kiz-shell-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Storage firmado: la URL cambia de token cada ~10 min — se normaliza la key
// (sin query) para que el caché sobreviva a la rotación de firmas.
function isSignedStorage(url) {
  return url.hostname.endsWith('.supabase.co') && url.pathname.includes('/storage/v1/object/sign/');
}
function isSupabaseApi(url) {
  return url.hostname.endsWith('.supabase.co') && !isSignedStorage(url);
}

// Network-first con fallback a caché: los datos SIEMPRE se sirven frescos de
// red (el instant-paint ya lo resuelve app.js con localStorage); el caché del
// SW solo entra cuando no hay red — modo offline con lo último visto. Servir
// caché primero aquí dejaría el dashboard un ciclo (30 min) atrás.
async function networkFirstData(request, url) {
  const cache = await caches.open(DATA_CACHE);
  const key = url.origin + url.pathname; // sin token
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) cache.put(key, resp.clone());
    return resp;
  } catch {
    const cached = await cache.match(key);
    return cached || new Response('{"error":"offline"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const resp = await fetch(request);
  if (resp && resp.ok) cache.put(request, resp.clone());
  return resp;
}

async function networkFirst(request, fallbackKey) {
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(fallbackKey || request, resp.clone());
    }
    return resp;
  } catch {
    const cached = await caches.match(fallbackKey || request);
    if (cached) return cached;
    throw new Error('offline sin caché');
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Supabase API (auth, rest, realtime): SIEMPRE directo a red, jamás caché.
  if (isSupabaseApi(url)) return;

  // JSONs de datos (signed URLs de Storage): red primero, caché si offline.
  if (isSignedStorage(url)) {
    e.respondWith(networkFirstData(req, url));
    return;
  }

  // Google Fonts: cache-first (inmutables).
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  if (url.origin !== location.origin) return;

  // Navegación e index: network-first (código fresco), caché si offline.
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(networkFirst(req, '/'));
    return;
  }

  // config.js: runtime config — network-first.
  if (url.pathname === '/config.js') {
    e.respondWith(networkFirst(req));
    return;
  }

  // Assets versionados (?v=) y vendor: cache-first.
  e.respondWith(cacheFirst(req, SHELL_CACHE));
});
