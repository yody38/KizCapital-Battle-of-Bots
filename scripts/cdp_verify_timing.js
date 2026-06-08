#!/usr/bin/env node
/*
 * cdp_verify_timing.js — authenticated headless CDP check for the new frontend:
 * pipeline-latency chip + modal, stale-while-revalidate snapshot cache, and the
 * "what moved" delta. Reuses the service_role session-minting from
 * cdp_verify_auth.js. Asserts 0 JS errors (catches any runtime break in the new
 * code), the chip exists and its modal opens, the SWR cache is written, the
 * delta object is computed, and the ranking table still renders.
 *
 * Prereqs (caller provides): local server on 127.0.0.1:8765 + Brave headless on
 * --remote-debugging-port=9222.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const WS = require("/usr/local/lib/node_modules/openclaw/node_modules/ws");

const ROOT = path.resolve(__dirname, "..");
const SITE = "http://127.0.0.1:8765/";
const STORAGE_KEY = "kiz-capital-auth";
const CDP_PORT = 9222;

function readEnv() {
  const env = {};
  for (const raw of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
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
  const usersRes = await fetch(`${base}/auth/v1/admin/users`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!usersRes.ok) throw new Error(`admin/users ${usersRes.status}`);
  const users = await usersRes.json();
  const list = users.users || users;
  if (!list || !list.length) throw new Error("no users in project");
  const email = list[0].email;
  const genRes = await fetch(`${base}/auth/v1/admin/generate_link`, {
    method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email }),
  });
  if (!genRes.ok) throw new Error(`generate_link ${genRes.status}`);
  const gen = await genRes.json();
  const tokenHash = (gen.properties && gen.properties.hashed_token) || gen.hashed_token;
  const verRes = await fetch(`${base}/auth/v1/verify`, {
    method: "POST", headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
  });
  if (!verRes.ok) throw new Error(`verify ${verRes.status}`);
  const session = await verRes.json();
  if (!session.access_token) throw new Error("verify returned no access_token");
  return { email, session };
}
function cdpGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: CDP_PORT, path: p }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej);
  });
}

async function main() {
  const env = readEnv();
  const url = env.SUPABASE_URL, serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SUPABASE creds missing in .env.local");
  const { email, session } = await mintSession(url, serviceKey, anonKey());

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
  await send("Page.navigate", { url: SITE });
  await new Promise((r) => setTimeout(r, 2500));
  await send("Runtime.evaluate", { expression: `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(session))})` });
  await send("Page.navigate", { url: SITE + "?cdpauth=" + Date.now() });
  await new Promise((r) => setTimeout(r, 8000));

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };

  const authed = await ev("!!window.kizUserEmail");
  const chipExists = await ev("!!document.getElementById('timing-chip')");
  const wired = await ev("typeof window.refreshTiming==='function' || typeof refreshTiming==='function'");
  // open the modal via click, check overlay becomes visible
  const modalOpens = await ev(`(function(){
    var c=document.getElementById('timing-chip'); var o=document.getElementById('timing-modal-overlay');
    if(!c||!o) return false; c.click(); return o.hidden===false;
  })()`);
  const gridRendered = await ev("(document.getElementById('timing-grid')||{}).children.length>0");
  // close it again
  await ev("var o=document.getElementById('timing-modal-overlay'); if(o) o.hidden=true;");
  const swrCached = await ev("localStorage.getItem('kiz.snapshot.v1')!==null");
  const deltasComputed = await ev("typeof window.__kizDeltas==='object' && window.__kizDeltas!==null");
  const botRows = await ev("document.querySelectorAll('#bots-tbody tr.bot-row').length");
  const freshnessLabel = await ev("(document.querySelector('#freshness .label')||{}).textContent||''");

  ws.close();
  const result = {
    email_used: email, authenticated: authed,
    timing_chip_exists: chipExists, timing_wired: wired,
    timing_modal_opens: modalOpens, timing_grid_rendered: gridRendered,
    swr_snapshot_cached: swrCached, what_moved_computed: deltasComputed,
    bot_rows: botRows, freshness_label: freshnessLabel,
    js_errors: errors.length, error_sample: errors.slice(0, 4),
  };
  const ok =
    authed === true && chipExists === true && modalOpens === true &&
    swrCached === true && deltasComputed === true &&
    botRows > 0 && errors.length === 0;
  result.PASS = ok;
  console.log(JSON.stringify(result, null, 1));
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
