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
// Variables (wrangler secret put):
//   SUPABASE_JWT_SECRET   secreto HS256 del proyecto (Settings > API > JWT)
//   ALLOWED_EMAILS        lista separada por comas (espejo de allowed_emails)
// Binding: BUCKET -> r2 bucket `bob-failover`

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

// Verifica un JWT HS256 emitido por Supabase: firma + exp. Sin red.
async function verifyJwt(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
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
