// Kiz Capital · Battle of Bots — proxy de borde para los JSON del dashboard.
//
// PROBLEMA QUE RESUELVE (medido 2026-07-27)
// Las URLs firmadas de Supabase llevan un token JWT que rota cada ~10 min, así
// que la clave de caché de Cloudflare cambia en cada firma: `cf-cache-status:
// BYPASS` en todas las respuestas. Resultado: los ~2 MB del snapshot viajan
// desde el ORIGEN de Supabase en cada carga de cada usuario. TTFB medido:
// 175-524 ms, contra 14-24 ms de `connect` al borde.
//
// MODELO DE SEGURIDAD — leer antes de tocar nada
// La ruta es /d/<sha>/<path>, donde <sha> es el sha256 de snapshot.json de este
// ciclo. Es una URL-capacidad, el mismo modelo que la URL firmada que sustituye:
// quien tiene la URL, lee. Lo que la protege:
//
//   1. El sha SOLO se obtiene de public.snapshot_meta, que tiene RLS `to
//      authenticated` (ver supabase/snapshot_meta.sql). Sin login no se conoce.
//   2. Son 64 hex de sha256 — no se adivina.
//   3. Esta función RECHAZA cualquier sha que no sea el del ciclo vigente. Un
//      sha filtrado deja de servir en cuanto el pipeline publica el siguiente
//      ciclo (~15 min), igual de acotado que el token firmado de 10 min.
//
// El punto 3 es el que hace que se pueda cachear en el CDN sin abrir un agujero.
// NO lo quites para "arreglar" un 404 durante el cambio de ciclo: el cliente ya
// degrada solo a URL firmada cuando esta ruta no responde 200 (ver data-source.js).

export const config = { runtime: 'edge' };

const BUCKET = 'dashboard-data';
const SHA_RE = /^[a-f0-9]{64}$/;
// Solo se sirven rutas del bucket de datos: JSON/JSONL bajo data/. Sin `..`,
// sin rutas absolutas, sin extensiones que no sean las del pipeline.
const PATH_RE = /^[a-zA-Z0-9_\-/.]+\.(json|jsonl)$/;

// El sha vigente se relee como mucho una vez por minuto por isolate. En un
// acierto de CDN esta función ni siquiera se ejecuta, así que el coste real es
// una lectura por POP y por ciclo.
let shaCache = { value: null, exp: 0 };

async function currentSha(url, key) {
  if (shaCache.value && shaCache.exp > Date.now()) return shaCache.value;
  const res = await fetch(
    `${url}/rest/v1/snapshot_meta?id=eq.1&select=manifest_sha`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  const sha = Array.isArray(rows) && rows[0] && rows[0].manifest_sha;
  if (!sha) return null;
  shaCache = { value: sha, exp: Date.now() + 60_000 };
  return sha;
}

// --- [EGRESS 2026-08-04] upstream preferido: espejo R2 (salida gratis) -----
// El bucket espejo recibe dual-write verificado (parity_ok) cada ciclo, así que
// servir desde R2 da los mismos bytes sin gastar egress de Supabase. Ante
// CUALQUIER fallo (env ausente, firma, red, 404) se cae al upstream Supabase
// original: la resiliencia no empeora — mejora, porque /d/ sigue vivo aunque
// Storage se caiga. Firma SigV4 a mano con Web Crypto: este proyecto no tiene
// build step y no puede importar dependencias.

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

async function hmacBytes(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

async function r2Fetch(path) {
  const acct = process.env.R2_ACCOUNT_ID;
  const ak = process.env.R2_ACCESS_KEY_ID;
  const sk = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET || 'bob-failover';
  if (!acct || !ak || !sk) return null;
  try {
    const host = `${acct}.r2.cloudflarestorage.com`;
    const canonicalUri = '/' + [bucket, ...path.split('/')].map(encodeURIComponent).join('/');
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = [
      'GET', canonicalUri, '',
      `host:${host}\nx-amz-content-sha256:${EMPTY_SHA256}\nx-amz-date:${amzDate}\n`,
      signedHeaders, EMPTY_SHA256,
    ].join('\n');
    const strToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256hex(canonical)].join('\n');
    let k = await hmacBytes(new TextEncoder().encode('AWS4' + sk), dateStamp);
    for (const part of ['auto', 's3', 'aws4_request']) k = await hmacBytes(k, part);
    const sig = hex((await hmacBytes(k, strToSign)).buffer);
    const res = await fetch(`https://${host}${canonicalUri}`, {
      headers: {
        Authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': EMPTY_SHA256,
      },
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

function deny(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default async function handler(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'method not allowed');

  const reqUrl = new URL(req.url);
  const sha = reqUrl.searchParams.get('sha') || '';
  const path = reqUrl.searchParams.get('path') || '';

  if (!SHA_RE.test(sha)) return deny(400, 'bad sha');
  if (!PATH_RE.test(path) || path.includes('..')) return deny(400, 'bad path');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return deny(500, 'proxy not configured');

  // Compuerta: solo el ciclo vigente. Acota lo que vale un sha filtrado.
  const live = await currentSha(SUPABASE_URL, SERVICE_KEY);
  if (!live) return deny(503, 'cycle sha unavailable');
  if (sha !== live) return deny(404, 'stale cycle');

  let upstreamSource = 'r2';
  let upstream = await r2Fetch(path);
  if (!upstream) {
    upstreamSource = 'supabase';
    upstream = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
      { headers: { Authorization: `Bearer ${SERVICE_KEY}` } },
    );
    if (!upstream.ok) return deny(upstream.status === 404 ? 404 : 502, 'upstream error');
  }

  const headers = new Headers();
  // [V1] `application/json` tambien para .jsonl: el CDN comprime por content-type
  // y `application/x-ndjson` no esta en su lista de tipos comprimibles, asi que
  // habria servido history_recent.jsonl en crudo (530 KB en vez de 34 KB),
  // deshaciendo por el borde justo lo que se arreglo en el uploader.
  headers.set('Content-Type', 'application/json');
  // El contenido está direccionado por su propio hash: mientras el sha sea el
  // vigente, esa URL siempre devuelve los mismos bytes. s-maxage cubre un ciclo
  // completo; SWR deja servir el borde mientras revalida el cambio de ciclo.
  headers.set('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=900, max-age=60');
  const etag = upstream.headers.get('ETag');
  if (etag) headers.set('ETag', etag);
  // El sha ya distingue el contenido; sin esto un intermediario podría mezclar
  // respuestas de rutas distintas bajo la misma entrada.
  headers.set('Vary', 'Accept-Encoding');
  headers.set('X-Content-Type-Options', 'nosniff');
  // Observabilidad: de qué upstream salió el byte (r2 = egress gratis).
  headers.set('X-Bob-Upstream', upstreamSource);

  return new Response(req.method === 'HEAD' ? null : upstream.body, { status: 200, headers });
}
