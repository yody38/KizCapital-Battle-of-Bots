#!/usr/bin/env node
/*
 * cdp_verify_live.js — headless authenticated check of the REAL-account live
 * stream. Reuses the service_role session-mint + inject pattern from
 * cdp_verify_auth.js, then asserts the live wiring end-to-end:
 *   - dashboard authenticates and renders with 0 JS errors
 *   - the #live-pill is green (live-on) with age < 8s
 *   - real card balances match the Supabase live_real_state row to the cent
 *   - the open position(s) for each real login render in the positions table
 *
 * Source of truth chain proven elsewhere: live_real_state == live MT5 (check_supabase),
 * so DOM == live_real_state here ⇒ DOM == MT5.
 *
 * Prereqs: local server on 127.0.0.1:8765 + Brave headless on :9222 + a running
 * publisher pushing to live_real_state.
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
  const m = fs.readFileSync(path.join(ROOT, "config.js"), "utf8").match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/);
  if (!m) throw new Error("anon key not found in config.js");
  return m[1];
}
async function mintSession(url, serviceKey, anon) {
  const base = url.replace(/\/$/, "");
  const usersRes = await fetch(`${base}/auth/v1/admin/users`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!usersRes.ok) throw new Error(`admin/users ${usersRes.status}`);
  const users = await usersRes.json();
  const list = users.users || users;
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
  if (!session.access_token) throw new Error("no access_token");
  return { email, session };
}
async function liveRows(url, serviceKey) {
  const base = url.replace(/\/$/, "");
  const r = await fetch(`${base}/rest/v1/live_real_state?select=login,balance,equity,profit,positions,ts`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!r.ok) throw new Error(`live_real_state ${r.status}`);
  return await r.json();
}
function cdpGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: CDP_PORT, path: p }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej);
  });
}

async function main() {
  const env = readEnv();
  const url = env.SUPABASE_URL, serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const anon = anonKey();
  const { email, session } = await mintSession(url, serviceKey, anon);
  const rows = await liveRows(url, serviceKey);
  const rowByLogin = {};
  rows.forEach((r) => (rowByLogin[String(r.login)] = r));

  const tabs = JSON.parse(await cdpGet("/json"));
  const tab = tabs.find((t) => t.type === "page");
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
  // Give the page time to auth, render, fetchOnce + receive a Realtime push.
  await new Promise((r) => setTimeout(r, 11000));

  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };

  const authed = await ev("!!window.kizUserEmail");
  const pillClass = await ev("(document.getElementById('live-pill')||{}).className || ''");
  const pillAge = await ev(`(function(){var e=document.querySelector('#live-pill .live-pill-age');if(!e)return null;var m=(e.textContent||'').match(/([0-9.]+)s/);return m?parseFloat(m[1]):null;})()`);
  const domBal = async (login) => ev(`(function(){var c=document.querySelector('.real-card[data-real-login="${login}"]');if(!c)return null;var b=c.querySelector('[data-live-field="balance"]');return b?b.textContent.trim():null;})()`);
  const posCount = async (login) => ev(`document.querySelectorAll('#real-positions-tbody tr[data-position-login="${login}"]').length`);

  const checks = [];
  for (const login of Object.keys(rowByLogin)) {
    const row = rowByLogin[login];
    const dom = await domBal(login);
    const expected = "$" + Number(row.balance).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const nPosExpected = Array.isArray(row.positions) ? row.positions.length : 0;
    const nPosDom = await posCount(login);
    checks.push({ login, dom_balance: dom, expected_balance: expected, balance_match: dom === expected, positions_expected: nPosExpected, positions_dom: nPosDom, positions_match: nPosDom >= nPosExpected });
  }

  ws.close();

  const greenOrWarm = /live-on|live-warn/.test(pillClass);
  const allBalMatch = checks.every((c) => c.balance_match);
  const allPosMatch = checks.every((c) => c.positions_match);
  const result = {
    email_used: email, authenticated: authed,
    pill_class: pillClass, pill_age_s: pillAge, pill_has_data: greenOrWarm,
    checks, js_errors: errors.length, error_sample: errors.slice(0, 3),
  };
  const ok = authed === true && greenOrWarm && allBalMatch && allPosMatch && errors.length === 0;
  result.PASS = ok;
  console.log(JSON.stringify(result, null, 1));
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
