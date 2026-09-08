// test_real_basket_ui.js — regresion de como el dashboard PINTA la cesta fija.
//
// Extrae renderStalenessBanner y renderRealAccounts del app.js real y las corre
// contra un DOM de mentira, sin navegador ni dependencias. Protege lo que el
// 2026-08-20 fallo en produccion: VPS3 reinicio, quedaron 1 de 5 terminales MT5
// abiertos, y el dashboard publico $4,738.19 en vez de $31,758.30 con el badge
// verde y SIN cartel. El backend ya no deja caer la suma (carry_forward_reals.py);
// esto verifica que la UI lo DICE en vez de mostrar un numero viejo sin marca.
//
// Correr:  node scripts/test_real_basket_ui.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no encontrada: ${name}`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('desbalanceado');
}

// --- DOM mínimo ---------------------------------------------------------
function el(id) {
  return {
    id, textContent: '', innerHTML: '', hidden: false, _cls: new Set(),
    classList: { add: (...c) => c.forEach(x => el.registry[id]._cls.add(x)),
                 remove: (...c) => c.forEach(x => el.registry[id]._cls.delete(x)),
                 contains: c => el.registry[id]._cls.has(c) },
    querySelector: (sel) => el.registry[id + sel] || (el.registry[id + sel] = el(id + sel)),
  };
}
el.registry = {};
const document = {
  getElementById: (id) => (el.registry[id] || (el.registry[id] = el(id))),
  querySelector: () => null, querySelectorAll: () => [],
};
const fmt = { usd: (v, s) => (s && v >= 0 ? '+' : '') + '$' + Number(v || 0).toFixed(2),
              dateTime: (iso) => String(iso).slice(0, 16).replace('T', ' ') };
const signedClass = (v) => (v > 0 ? 'positive' : v < 0 ? 'negative' : '');
const vpsPrettyName = (v) => String(v || '').toUpperCase();
const state = {};
const liveState = { byLogin: new Map(), initialized: false };
const requestAnimationFrame = () => {};
const updateRealRiskCard = () => {};
const historyForLogin = () => [];
const drawSpark = () => {};
const initLiveStream = () => {}, initRealHistory = () => {}, renderRealBotsTable = () => {},
      renderRealRace = () => {}, renderRealHeatmap = () => {}, renderWarRoom = () => {},
      renderRealWaterfall = () => {}, renderRealRisk = () => {}, renderRealClock = () => {},
      renderRealWeek = () => {}, renderRealToday = () => {}, renderRealPositionsPanel = () => {};
const renderRealPositions = () => {};
const isFundedRealAccount = (a) => !(Number(a.balance) === 0 && Number(a.equity) === 0);

eval(grab('renderStalenessBanner'));
eval(grab('renderRealAccounts'));

const A = (l, b, disc) => ({ login: l, vps: 'vps3', balance: b, equity: b, profit: 0,
  margin: 0, server: 'ADNBrokerCFD-Server', leverage: 100,
  ...(disc ? { disconnected: true, stale: true, as_of: '2026-08-20T06:00:00+00:00' } : {}) });

const FRESH = { vps3: { present: true, stale: false, carried_forward: false, lag_sec: 600 } };
const reset = () => { el.registry = {}; };
let ok = 0;
const check = (cond, msg) => { if (!cond) throw new Error('FALLO: ' + msg); ok++; console.log('  ✓ ' + msg); };

// 1 · El caso de hoy: 4 reales caídas, VPS fresca.
reset();
const snapDown = {
  bots: [], accounts: [], open_positions: [],
  generated_at: new Date().toISOString(), partial_data: true, vps_freshness: FRESH,
  degraded_reals: [25425, 43306, 43411, 43414].map(l => ({ login: l, expected_vps: 'vps3', as_of: '2026-08-20T06:00:00+00:00' })),
  real_portfolio: { expected_count: 5, live_count: 1, total_balance: 31758.30,
    total_equity: 31756.85, total_unrealised_pnl: -1.45, open_positions: [],
    accounts: [A(32081, 4738.19), A(25425, 7317.36, 1), A(43306, 4977.98, 1), A(43411, 9821.20, 1), A(43414, 4903.57, 1)] },
};
console.log('\n1 · 4 cuentas reales desconectadas (el fallo de hoy)');
renderStalenessBanner(snapDown);
const banner = el.registry['staleness-banner'];
const btxt = el.registry['staleness-banner.staleness-banner__text'].textContent;
check(!banner._cls.has('hidden') && banner._cls.has('warn'), 'el cartel se muestra (warn)');
check(/4 de 5 cuentas reales desconectadas/.test(btxt), 'dice cuántas: ' + btxt.slice(0, 60));
check(/25425, 43306, 43411, 43414/.test(btxt), 'nombra los 4 logins');
check(/VPS3/.test(btxt), 'nombra la VPS');
check(/último dato conocido/.test(btxt), 'aclara que las cifras no son de este ciclo');


console.log('\n2 · Tarjetas de cuenta real');
state.snapshot = snapDown;
renderRealAccounts();
const cardsHtml = el.registry['real-cards'].innerHTML;
const note = el.registry['real-degraded-note'];
check(el.registry['real-count'].textContent === 5, 'el subtítulo sigue diciendo 5 cuentas reales');
check(el.registry['real-balance'].textContent === '$31758.30', 'el balance NO cae: ' + el.registry['real-balance'].textContent);
check(!note._cls.has('hidden') && /4 desconectadas/.test(note.textContent), 'nota: ' + note.textContent);
check((cardsHtml.match(/real-card--disconnected/g) || []).length === 4, '4 tarjetas marcadas desconectadas');
check((cardsHtml.match(/⚠ DESCONECTADA/g) || []).length === 4, '4 chips DESCONECTADA');
check(!/data-risk-login="25425"/.test(cardsHtml), 'la caída no pinta fila de riesgo intradía');
check(/data-risk-login="32081"/.test(cardsHtml), 'la viva sí conserva su fila de riesgo');
check((cardsHtml.match(/id="spark-/g) || []).length === 1, 'solo la viva dibuja sparkline');
check(/Sin conexión · dato de 2026-08-20 06:00/.test(cardsHtml), 'el pie dice de cuándo es el dato');
check(/Broker: ADNBrokerCFD-Server/.test(cardsHtml), 'la viva conserva su pie normal');

console.log('\n3 · Cesta sana: nada de esto aparece');
reset();
const snapOk = { bots: [], accounts: [], open_positions: [], generated_at: new Date().toISOString(), partial_data: false, vps_freshness: FRESH,
  degraded_reals: [], real_portfolio: { expected_count: 5, live_count: 5, total_balance: 31758.30,
    total_equity: 31756.85, total_unrealised_pnl: -1.45, open_positions: [],
    accounts: [A(32081, 4738.19), A(25425, 7317.36), A(43306, 4977.98), A(43411, 9821.20), A(43414, 4903.57)] } };
renderStalenessBanner(snapOk);
check(el.registry['staleness-banner']._cls.has('hidden'), 'sin cartel');
state.snapshot = snapOk;
renderRealAccounts();
check(el.registry['real-degraded-note']._cls.has('hidden'), 'sin nota de degradación');
check(!/real-card--disconnected/.test(el.registry['real-cards'].innerHTML), 'ninguna tarjeta marcada');

console.log('\n4 · VPS heredada / ausente: el cartel ahora la NOMBRA');
reset();
renderStalenessBanner({ generated_at: new Date().toISOString(), partial_data: true,
  vps_freshness: { vps3: { present: true, stale: false, carried_forward: true },
                   vps5: { present: false },
                   vps6: { present: true, stale: true, lag_sec: 7200 } },
  degraded_reals: [], real_portfolio: {} });
const t4 = el.registry['staleness-banner.staleness-banner__text'].textContent;
check(/VPS3 \(datos heredados\)/.test(t4), 'nombra la heredada');
check(/VPS5 \(sin responder\)/.test(t4), 'nombra la ausente');
check(/VPS6 \(atrasada 120 min\)/.test(t4), 'nombra la atrasada con su lag');
check(!/al menos una VPS/.test(t4), 'ya no dice el mensaje mudo de antes');

console.log(`\n${ok} comprobaciones OK`);
