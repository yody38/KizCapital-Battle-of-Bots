#!/usr/bin/env node
/*
 * cdp_verify_auth.js — headless authenticated CDP verification of the dashboard.
 *
 * The dashboard is Supabase-Auth gated, so a plain headless load only sees the
 * login page. This harness mints a real session using the SERVICE_ROLE key
 * (already in .env.local) — no user password needed — injects it into the
 * supabase-js localStorage slot, loads the authenticated dashboard, and asserts
 * the rendered DOM (candidate caps, no duplicate magics, no drift section, 0 JS
 * errors). The token is minted fresh each run and never persisted.
 *
 * Prereqs (caller provides): local server on 127.0.0.1:8765 + Brave headless on
 * --remote-debugging-port=9222.
 *
 * Exit 0 = all assertions pass; exit 1 = a check failed or harness error.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const WS = require("/usr/local/lib/node_modules/openclaw/node_modules/ws");

const ROOT = path.resolve(__dirname, "..");
const SITE = "http://127.0.0.1:8765/";
const STORAGE_KEY = "kiz-capital-auth"; // supabase-client.js:31
const CDP_PORT = 9222;

function readEnv() {
  const env = {};
  const p = path.join(ROOT, ".env.local");
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

function anonKey() {
  const cfg = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
  const m = cfg.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/);
  if (!m) throw new Error("anon key not found in config.js");
  return m[1];
}

async function mintSession(url, serviceKey, anon) {
  const base = url.replace(/\/$/, "");
  // 1. find the owner user
  const usersRes = await fetch(`${base}/auth/v1/admin/users`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!usersRes.ok) throw new Error(`admin/users ${usersRes.status}`);
  const users = await usersRes.json();
  const list = users.users || users;
  if (!list || !list.length) throw new Error("no users in project");
  const email = list[0].email;

  // 2. mint a magiclink token (service_role only)
  const genRes = await fetch(`${base}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!genRes.ok) throw new Error(`generate_link ${genRes.status}: ${(await genRes.text()).slice(0, 160)}`);
  const gen = await genRes.json();
  const tokenHash = (gen.properties && gen.properties.hashed_token) || gen.hashed_token;
  if (!tokenHash) throw new Error("no hashed_token from generate_link");

  // 3. verify -> real session (access_token + refresh_token + user)
  const verRes = await fetch(`${base}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
  });
  if (!verRes.ok) throw new Error(`verify ${verRes.status}: ${(await verRes.text()).slice(0, 160)}`);
  const session = await verRes.json();
  if (!session.access_token) throw new Error("verify returned no access_token");
  return { email, session };
}

function cdpGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: CDP_PORT, path: p }, (r) => {
      let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d));
    }).on("error", rej);
  });
}

async function main() {
  const env = readEnv();
  const url = env.SUPABASE_URL, serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SUPABASE_URL / SERVICE_ROLE_KEY missing in .env.local");
  const anon = anonKey();

  const { email, session } = await mintSession(url, serviceKey, anon);

  const tabs = JSON.parse(await cdpGet("/json"));
  const tab = tabs.find((t) => t.type === "page");
  if (!tab) throw new Error("no Brave page tab on :9222");
  const ws = new WS(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = {}; const errors = [];
  const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  await new Promise((r) => ws.on("open", r));
  ws.on("message", (d) => {
    const m = JSON.parse(d);
    if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
    if (m.method === "Runtime.exceptionThrown") {
      const e = m.params.exceptionDetails;
      errors.push((e.text || "") + " " + ((e.exception || {}).description || ""));
    }
  });
  await send("Runtime.enable"); await send("Page.enable");

  // Establish the origin, inject the session, then load the authenticated page.
  await send("Page.navigate", { url: SITE });
  await new Promise((r) => setTimeout(r, 2500));
  await send("Runtime.evaluate", {
    expression: `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(session))})`,
  });
  await send("Page.navigate", { url: SITE + "?cdpauth=" + Date.now() });
  await new Promise((r) => setTimeout(r, 7000));

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };

  // Count candidate rows by clicking each status pill and reading the table.
  const countFor = async (status) => ev(`(function(){
    var p=[...document.querySelectorAll('#candidates-status-pills .pill')].find(b=>b.dataset.status===${JSON.stringify(status)});
    if(p) p.click();
    var rows=[...document.querySelectorAll('#candidates-tbody tr')];
    var magics=rows.map(r=>r.getAttribute('data-magic'));
    return JSON.stringify({n:rows.length, magics:magics});
  })()`);

  const title = await ev("document.title");
  const authed = await ev("!!window.kizUserEmail");
  const driftGone = await ev("document.getElementById('drift-section')===null");
  const ready = JSON.parse((await countFor("READY")) || '{"n":-1,"magics":[]}');
  await new Promise((r) => setTimeout(r, 400));
  const near = JSON.parse((await countFor("NEAR")) || '{"n":-1,"magics":[]}');
  await new Promise((r) => setTimeout(r, 400));
  const watch = JSON.parse((await countFor("WATCH")) || '{"n":-1,"magics":[]}');
  const allMagics = [...ready.magics, ...near.magics, ...watch.magics].filter(Boolean);
  const dupMagic = allMagics.length !== new Set(allMagics).size;

  ws.close();

  const result = {
    email_used: email,
    title,
    authenticated: authed,
    drift_section_gone: driftGone,
    READY: ready.n, NEAR: near.n, WATCH: watch.n,
    duplicate_magic_across_buckets: dupMagic,
    js_errors: errors.length,
    error_sample: errors.slice(0, 3),
  };
  const ok =
    authed === true &&
    ready.n >= 0 && ready.n <= 3 &&
    near.n >= 0 && near.n <= 5 &&
    watch.n >= 0 && watch.n <= 15 &&
    !dupMagic &&
    driftGone === true &&
    errors.length === 0;
  result.PASS = ok;
  console.log(JSON.stringify(result, null, 1));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
