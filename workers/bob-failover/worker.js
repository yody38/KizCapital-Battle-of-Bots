// Kiz Capital · Battle of Bots — Worker de failover (R1)
//
// Sirve los datos del dashboard desde el espejo Cloudflare R2 (bucket
// `bob-failover`, que el pipeline ya mantiene con parity_ok en cada ciclo)
// cuando Supabase Storage no responde.
//
// PRIVACIDAD: mantiene exactamente la misma barrera que hoy. El bucket NO es
// publico; este Worker exige un JWT valido de Supabase y ademas que el email
// del token este en la whitelist. La firma se verifica LOCALMENTE con el JWT
// secret (HS256) — sin llamar a Supabase — que es justo lo que permite que el
// respaldo funcione durante una caida de Supabase.
//
// Coste: 0. Plan gratuito de Workers = 100.000 peticiones/dia; R2 ya esta en
// uso, su egress es gratis y el dataset (~4 MB) cabe de sobra en los 10 GB
// gratuitos.
//
// Variables:
//   ALLOWED_EMAILS        lista separada por comas (espejo de allowed_emails)
//   SUPABASE_JWT_SECRET   [opcional] solo si quedan tokens legacy HS256
// Binding: BUCKET -> r2 bucket `bob-failover`
//
// El proyecto firma con claves ASIMETRICAS ES256 (ECC P-256), asi que aqui solo
// hace falta la clave PUBLICA — va embebida abajo (es publica por diseño: la
// sirve el propio Supabase en /auth/v1/.well-known/jwks.json). Embeberla, en
// vez de descargarla, es lo que permite validar sesiones incluso con Supabase
// caido, que es justo cuando este Worker tiene que funcionar.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Clave PUBLICA de firma del proyecto (ES256 / ECC P-256). Publica por diseño.
// Si algun dia rotas la clave en Supabase, actualiza este bloque desde
//   https://sudnilwqhbfcjqnzzmhi.supabase.co/auth/v1/.well-known/jwks.json
const JWKS = {
  keys: [
    {
      alg: "ES256",
      crv: "P-256",
      ext: true,
      key_ops: ["verify"],
      kid: "91c9018e-d9c6-4826-b16b-2b6f03da114e",
      kty: "EC",
      use: "sig",
      x: "-CPXGXzBR6PFXWUX6WuWFuvW5PAoJEUWPHXzVTrX6Rw",
      y: "Ub59s5M1T55OM4jLIfaVXrbGVeqp_izPhNzcq8DIKBs",
    },
  ],
};

// Verifica un JWT de Supabase: firma + exp. Sin red — funciona con Supabase caido.
// Soporta ES256 (el actual, asimetrico) y HS256 (legacy, solo si hay secreto).
async function verifyJwt(token, secret) {
  try {
    return await _verifyJwt(token, secret);
  } catch {
    // Un token malformado (base64 invalido, curva rara, JWK que no importa) es
    // un 401, nunca un 500: probado en vivo, `Bearer x.y.z` reventaba en
    // b64urlToBytes fuera del try y devolvia error de servidor.
    return null;
  }
}

async function _verifyJwt(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const signed = new TextEncoder().encode(`${h}.${p}`);
  const sig = b64urlToBytes(s);

  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));

  let ok = false;
  if (header.alg === "ES256") {
    const jwk = JWKS.keys.find((k) => !header.kid || k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    // En JWT la firma ECDSA es R||S en crudo, que es lo que espera WebCrypto.
    ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, signed);
  } else if (header.alg === "HS256") {
    if (!secret) return null;   // sin secreto legacy no se acepta HS256
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    ok = await crypto.subtle.verify("HMAC", key, sig, signed);
  } else {
    return null;   // 'none' y cualquier alg desconocido: rechazado
  }
  if (!ok) return null;

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch {
    return null;
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;
  return claims;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return json(405, { error: "method not allowed" });

    const url = new URL(request.url);
    // /health responde sin auth: lo usa el watchdog para saber si el respaldo
    // esta utilizable ANTES de que haga falta de verdad.
    if (url.pathname === "/health") {
      const probe = await env.BUCKET.head("snapshot.json");
      return json(probe ? 200 : 503, {
        ok: !!probe,
        object: "snapshot.json",
        size: probe ? probe.size : null,
        uploaded: probe ? probe.uploaded : null,
      });
    }

    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return json(401, { error: "missing bearer token" });

    const claims = await verifyJwt(token, env.SUPABASE_JWT_SECRET);
    if (!claims) return json(401, { error: "invalid or expired token" });

    // Segunda barrera: whitelist de emails (espejo de public.allowed_emails).
    const allowed = String(env.ALLOWED_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const email = String(claims.email || "").toLowerCase();
    if (allowed.length && !allowed.includes(email)) {
      return json(403, { error: "email not whitelisted" });
    }

    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!key || key.includes("..")) return json(400, { error: "bad key" });

    const obj = await env.BUCKET.get(key);
    if (!obj) return json(404, { error: "not found in failover mirror", key });

    const headers = new Headers(CORS);
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    // Mismo tipo que sirve Supabase para que el CDN comprima igual.
    if (!headers.get("content-type")) {
      headers.set("content-type", key.endsWith(".jsonl") || key.endsWith(".json")
        ? "application/json"
        : "application/octet-stream");
    }
    headers.set("cache-control", "no-cache");
    headers.set("x-kiz-source", "r2-failover");
    return new Response(obj.body, { headers });
  },
};
