// cc/dev/fixture-data.js — generador de datos SINTETICOS para desarrollo.
//
// NO toca ninguna VPS, ningun broker y ninguna credencial. Los logins, los
// magics y los servidores son inventados y deterministas (PRNG con semilla),
// asi que dos ejecuciones producen exactamente el mismo tablero y una
// diferencia visual siempre es culpa del codigo, no del azar.
//
// Sirve para: (1) recorrer las 8 rutas sin poder iniciar sesion, y (2) probar
// la virtualizacion con 10.000 filas.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VPS = ['vps1', 'vps2', 'vps3', 'vps4', 'vps5', 'vps6'];
const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'EURJPY', 'EURGBP',
  'NZDUSD', 'USDCHF', 'GBPJPY', 'XAUUSD', 'CADJPY', 'AUDNZD', 'CHFJPY'];
const STAGES = ['CANDIDATE', 'OBSERVATION', 'NEW', 'HISTORICAL'];
const TIERS = ['MEASURED', 'INFERRED', 'UNKNOWN'];

// Cuentas "reales" del fixture: numeros claramente ficticios (9000xx) para que
// nadie los confunda con los del owner.
const FIXTURE_REAL_LOGINS = [900001, 900002, 900003, 900004, 900005];

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

export function buildFixture({ botCount = 1200, seed = 20260908 } = {}) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b) => a + rnd() * (b - a);
  const ri = (a, b) => Math.floor(between(a, b + 1));

  // ---- Cuentas -----------------------------------------------------------
  const accounts = [];
  const demoAccountCount = 63;
  for (let i = 0; i < demoAccountCount; i++) {
    const vps = VPS[i % VPS.length];
    const bal = Math.round(between(2000, 120000));
    const prof = Math.round(between(-3000, 6000));
    accounts.push({
      vps, login: 500000 + i, name: `Demo ${i + 1}`, server: 'FixtureBroker-Demo',
      balance: bal, equity: bal + prof, margin: Math.round(between(0, 4000)),
      free_margin: Math.round(between(1000, 90000)), profit: prof,
      currency: 'USD', leverage: 200, is_real: false,
    });
  }
  const realAccounts = FIXTURE_REAL_LOGINS.map((login, i) => {
    const bal = Math.round(between(8000, 45000));
    const prof = Math.round(between(-900, 1400));
    // La tercera cuenta llega DESCONECTADA a proposito: es el caso que la vista
    // de dinero real tiene que marcar sin sacarla de la suma.
    const off = i === 2;
    return {
      vps: 'vps3', login, name: `Real ${i + 1}`, server: 'FixtureBroker-Live',
      balance: bal, equity: bal + prof, margin: Math.round(between(200, 3000)),
      free_margin: Math.round(between(3000, 40000)), profit: prof,
      currency: 'USD', leverage: 100, is_real: true,
      disconnected: off, as_of: off ? iso(52 * 60 * 1000) : undefined,
    };
  });
  accounts.push(...realAccounts);

  const accountPool = accounts.map((a) => a.login);

  // ---- Bots --------------------------------------------------------------
  const bots = [];
  for (let i = 0; i < botCount; i++) {
    // Los primeros 12 bots viven en cuentas reales, el resto en demo.
    const real = i < 12;
    const acct = real
      ? realAccounts[i % realAccounts.length]
      : accounts[ri(0, demoAccountCount - 1)];
    const trades = ri(5, 900);
    const wins = Math.round(trades * between(0.28, 0.72));
    const grossProfit = Math.round(between(200, 60000));
    const grossLoss = -Math.round(between(150, 52000));
    const net = Math.round(grossProfit + grossLoss);
    const months = Number(between(0.4, 40).toFixed(1));
    const dd = Math.round(between(80, 14000));
    const ddPct = Number(((dd / Math.max(1, acct.balance)) * 100).toFixed(2));
    const decayRatio = Number(between(-0.6, 2.4).toFixed(3));
    const decayFlag = decayRatio < 0.3 && net > 0 && rnd() < 0.5;
    const driftSeverity = Number(between(0.2, 2.6).toFixed(2));
    const dsl = ri(0, 240);
    const score = Number(between(4, 92).toFixed(1));
    const scoreV2 = Number(Math.max(0, score + between(-9, 9)).toFixed(1));
    const status = score > 78 ? 'READY' : score > 63 ? 'NEAR' : score > 45 ? 'WATCH' : 'NO';
    const nSym = rnd() < 0.75 ? 1 : 2;
    const symbols = Array.from({ length: nSym }, () => pick(SYMBOLS));
    const commission = -Math.round(trades * between(1, 7));

    const gating = {
      min_trades: trades >= 30,
      min_months_active: months >= 3,
      dd_under_cap: ddPct <= 10,
      net_profitable: net > 0,
      no_decay_flag: !decayFlag,
      valid_magic: true,
    };
    const fails = [];
    if (!gating.min_trades) fails.push('trades < 30');
    if (!gating.min_months_active) fails.push('meses activo < 3');
    if (!gating.dd_under_cap) fails.push(`DD ${ddPct.toFixed(1)}% > 10%`);
    if (!gating.net_profitable) fails.push('net profit <= 0');
    if (!gating.no_decay_flag) fails.push('decay detectado');

    const comp = {
      net_return: Number(between(0, 1).toFixed(3)),
      cadence: Number(between(0, 1).toFixed(3)),
      profit_factor: Number(between(0, 1).toFixed(3)),
      age: Number(between(0, 1).toFixed(3)),
      trade_count: Number(between(0, 1).toFixed(3)),
      oos_robustness: Number(between(0, 1).toFixed(3)),
      safety: Number(between(0, 1).toFixed(3)),
      tail_quality: Number(between(0, 1).toFixed(3)),
      significance: Number(between(0, 1).toFixed(3)),
    };
    const comp2 = { ...comp,
      net_return: Number(between(0, 1).toFixed(3)),
      oos_robustness: Number(between(0, 1).toFixed(3)),
      significance: Number(between(0, 1).toFixed(3)) };

    bots.push({
      vps: real ? 'vps3' : acct.vps,
      account_login: acct.login,
      magic: 100000 + i,
      symbols,
      trades, wins, losses: trades - wins,
      win_rate_pct: Number(((wins / Math.max(1, trades)) * 100).toFixed(2)),
      net_profit: net,
      net_after_commission: net + commission,
      net_profit_365d: Math.round(net * between(0.5, 1)),
      net_profit_lifetime: net,
      gross_profit: grossProfit, gross_loss: grossLoss,
      profit_factor: grossLoss ? Number((grossProfit / Math.abs(grossLoss)).toFixed(3)) : null,
      avg_win: Math.round(grossProfit / Math.max(1, wins)),
      avg_loss: Math.round(grossLoss / Math.max(1, trades - wins)),
      expectancy: Number((net / Math.max(1, trades)).toFixed(2)),
      best_trade: Math.round(between(50, 4000)),
      worst_trade: -Math.round(between(40, 3500)),
      first_trade: iso(months * 30 * 86400000),
      last_trade: iso(dsl * 86400000),
      max_drawdown: dd,
      dd_pct_of_balance: ddPct,
      recovery_factor: Number(between(0.1, 9).toFixed(2)),
      max_consecutive_losses: ri(1, 22),
      max_consecutive_wins: ri(1, 26),
      sharpe_annualized: Number(between(-0.6, 3.4).toFixed(2)),
      sortino: Number(between(-0.4, 5.2).toFixed(2)),
      calmar: Number(between(0, 7).toFixed(2)),
      months_active: months,
      months_active_365d: Math.min(12, months),
      months_active_lifetime: months,
      months_positive_pct: Number(between(10, 96).toFixed(1)),
      return_monthly_pct_365d: Number(between(-1.4, 4.2).toFixed(2)),
      trades_per_month: Number((trades / Math.max(0.5, months)).toFixed(1)),
      trades_30d: ri(0, 90), trades_90d: ri(0, 260),
      net_7d: Math.round(between(-900, 1400)),
      net_30d: Math.round(between(-3000, 5200)),
      net_90d: Math.round(between(-6000, 12000)),
      stability_score: Number(between(0, 1).toFixed(3)),
      improvement: Number(between(-4, 4).toFixed(3)),
      slope_lifetime: Number(between(-3, 9).toFixed(4)),
      slope_recent_90d: Number(between(-6, 8).toFixed(4)),
      decay_ratio: decayRatio,
      decay_flag: decayFlag,
      drift: { flag: driftSeverity > 1.3, severity: driftSeverity },
      dormant: dsl > 45,
      days_since_last_trade: dsl,
      capacity_usd: Math.round(between(20000, 900000)),
      scientific_score: rnd() < 0.6 ? Number(between(10, 95).toFixed(1)) : null,
      evidence_tier: pick(TIERS),
      gm_id: rnd() < 0.3 ? `GM-${1000 + i}` : '',
      is_real: real,
      lifecycle: { stage: real ? 'REAL' : pick(STAGES) },
      promotion_score: score,
      promotion_score_shrunk: Number((score * between(0.82, 1)).toFixed(1)),
      promotion_score_v2: scoreV2,
      promotion_components: comp,
      promotion_components_v2: comp2,
      promotion_status: Object.values(gating).every(Boolean) ? status : 'NO',
      promotion_gating: gating,
      promotion_fails: fails,
      provisional_low_confidence: rnd() < 0.06,
      trust_fails: rnd() < 0.1 ? ['frescura'] : [],
      shrinkage_meta: {
        confidence: trades > 300 ? 'HIGH' : trades > 90 ? 'MEDIUM' : 'LOW',
        delta: Number(between(-9, 3).toFixed(1)),
        cohort_prior_used: rnd() < 0.5,
        cohort_n: ri(8, 140),
      },
      oos: { oos_net: Math.round(between(-3000, 8000)), oos_ratio: Number(between(0, 1.6).toFixed(2)), verdict: pick(['PASS', 'WEAK', 'FAIL']) },
      confidence_intervals: { net_p5: Math.round(net * 0.4), net_p95: Math.round(net * 1.6) },
      institutional: { cvar_95: -Math.round(between(80, 2600)), var_95: -Math.round(between(50, 1800)) },
      stress: { mc_dd_p95: Math.round(between(200, 18000)), prob_ruin: Number(between(0, 0.22).toFixed(4)) },
      underwater: { max_days: ri(1, 260) },
      regime: { dominant: pick(['TREND', 'RANGE', 'MIXTO']) },
      trade_distribution: { profile: rnd() < 0.05 ? 'LOTTERY' : 'NORMAL' },
      ready_streak_days: rnd() < 0.2 ? ri(1, 40) : null,
    });
  }
  bots.sort((a, b) => b.net_profit - a.net_profit);

  // ---- Posiciones abiertas de la cesta real ------------------------------
  const openPositions = [];
  for (const a of realAccounts) {
    if (a.disconnected) continue;
    for (let k = 0; k < ri(0, 3); k++) {
      const b = bots[ri(0, 11)];
      openPositions.push({
        vps: a.vps, login: a.login, ticket: 700000 + openPositions.length,
        magic: b.magic, symbol: pick(SYMBOLS), type: rnd() < 0.5 ? 'BUY' : 'SELL',
        volume: Number(between(0.01, 1.2).toFixed(2)),
        price_open: Number(between(0.9, 1.4).toFixed(5)),
        price_current: Number(between(0.9, 1.4).toFixed(5)),
        sl: null, tp: null,
        profit: Math.round(between(-400, 700)),
        time_open: iso(ri(1, 300) * 60000),
      });
    }
  }

  const sum = (list, f) => Math.round(list.reduce((s, x) => s + (Number(f(x)) || 0), 0) * 100) / 100;

  const vpsFreshness = {};
  const vpsSources = {};
  VPS.forEach((v, i) => {
    // vps5 llega ATRASADA y vps6 con datos HEREDADOS: los dos paneles que la
    // vista de salud tiene que levantar con nombre y apellidos.
    const stale = v === 'vps5';
    const carried = v === 'vps6';
    vpsFreshness[v] = {
      present: true,
      generated_at: iso((stale ? 130 : carried ? 40 : 6) * 60000),
      lag_sec: (stale ? 130 : carried ? 40 : 6) * 60,
      stale, carried_forward: carried,
      bot_count: Math.round(botCount / VPS.length),
    };
    vpsSources[v] = { bot_count: Math.round(botCount / VPS.length), account_count: 11 + i };
  });

  const snapshot = {
    generated_at: iso(9 * 60000),
    oldest_source_generated_at: iso(14 * 60000),
    reconciled_at: iso(8 * 60000),
    window_days: 365,
    partial_data: true,
    accounts,
    bots,
    open_positions: openPositions,
    vps_sources: vpsSources,
    vps_freshness: vpsFreshness,
    metrics_meta: {
      schema: 1, window_days: 365,
      commission_policy: {
        suffixed_lifetime: 'net = profit + commission + swap',
        unsuffixed_legacy: 'net = profit + swap (sin comision)',
      },
    },
    health_metrics: {
      uptime_pct_30d: 98.42, heartbeat_samples_30d: 2841,
      mean_lag_sec_7d: 512.3, max_lag_sec_7d: 3120, recovery_count_7d: 4,
    },
    real_portfolio: {
      total_balance: sum(realAccounts, (a) => a.balance),
      total_equity: sum(realAccounts, (a) => a.equity),
      total_unrealised_pnl: sum(realAccounts, (a) => a.profit),
      total_open_margin: sum(realAccounts, (a) => a.margin),
      account_count: realAccounts.length,
      accounts: realAccounts,
      open_positions: openPositions,
      live_count: realAccounts.filter((a) => !a.disconnected).length,
      expected_count: 5,
    },
    degraded_reals: realAccounts.filter((a) => a.disconnected).map((a) => a.login),
    promotion_meta: {
      score_versions: {
        live: 'v1', shadow: ['v2'],
        v2: {
          changelog: { net_return: { old: 'lifetime / months_365d', new: 'ambos en la misma ventana' } },
          diff: {
            n_scored: botCount, mean_abs_delta: 3.42, p90_abs_delta: 7.1,
            max_abs_delta: 9.0,
            ready_v1: bots.filter((b) => b.promotion_status === 'READY').slice(0, 3).map((b) => `${b.vps}-${b.account_login}-${b.magic}`),
            ready_v2: bots.filter((b) => b.promotion_status === 'READY').slice(1, 4).map((b) => `${b.vps}-${b.account_login}-${b.magic}`),
            jaccard_ready: 0.5,
          },
        },
      },
      weights: { net_return: 0.22, cadence: 0.08, profit_factor: 0.14, age: 0.08, trade_count: 0.08,
        oos_robustness: 0.14, safety: 0.1, tail_quality: 0.08, significance: 0.08 },
      rank_caps: { READY: 3, NEAR: 5, WATCH: 15 },
      gating: { min_trades: 30, min_months_active: 3, max_drawdown_pct_of_balance: 10 },
      human_veto_required: true,
      pool_pre_commission: Math.round(botCount * 0.5),
      eligible_count: Math.round(botCount * 0.36),
      pool_post_dedup: Math.round(botCount * 0.3),
      trusted_count: Math.round(botCount * 0.2),
      provisional_count: Math.round(botCount * 0.05),
      hard_blocked_count: Math.round(botCount * 0.05),
      ranker: 'promotion_score_shrunk desc, net_after_commission desc, trades desc, vps asc, login asc',
    },
  };

  // ---- Correlaciones: los 40 mejores, v1 + v2 + solape --------------------
  const corrBots = bots.filter((b) => b.trades >= 30 && b.promotion_score != null).slice(0, 40);
  const keys = corrBots.map((b) => `${b.vps}-${b.account_login}-${b.magic}`);
  const matrix = {}; const matrixV2 = {}; const overlap = {}; const meta = {};
  keys.forEach((ki, i) => {
    matrix[ki] = {}; matrixV2[ki] = {}; overlap[ki] = {};
    meta[ki] = {
      vps: corrBots[i].vps, login: corrBots[i].account_login, magic: corrBots[i].magic,
      symbols: corrBots[i].symbols, promotion_score: corrBots[i].promotion_score,
      promotion_status: corrBots[i].promotion_status, net_profit: corrBots[i].net_profit,
      trades: corrBots[i].trades,
    };
  });
  keys.forEach((ki, i) => {
    keys.forEach((kj, j) => {
      if (i === j) { matrix[ki][kj] = 1.0; matrixV2[ki][kj] = 1.0; overlap[ki][kj] = 300; return; }
      if (j < i) { matrix[ki][kj] = matrix[kj][ki]; matrixV2[ki][kj] = matrixV2[kj][ki]; overlap[ki][kj] = overlap[kj][ki]; return; }
      const v1 = Number(between(-0.85, 0.95).toFixed(3));
      const n = ri(2, 220);
      matrix[ki][kj] = v1;
      overlap[ki][kj] = n;
      matrixV2[ki][kj] = n < 20 ? null : Number(Math.max(-1, Math.min(1, v1 + between(-0.25, 0.25))).toFixed(3));
    });
  });

  const correlations = {
    generated_at: snapshot.generated_at,
    bot_count: keys.length, min_trades: 30, max_bots: 60,
    bots: meta, matrix, matrix_v2: matrixV2, overlap_n: overlap,
    estimators: {
      live: 'v1 · pearson sobre la union de fechas, dias sin operar = 0.0',
      shadow: 'v2 · pearson sobre la interseccion de dias activos, minimo 20 dias solapados, None si no llega',
      live_version: 'v1',
    },
  };

  const portfolio = {
    n_bots: 24,
    allocations: {
      50000: {
        inverse_volatility: corrBots.slice(0, 12).map((b, i) => ({
          magic: b.magic, weight: Number((0.16 - i * 0.01).toFixed(4)),
          capital_usd: Math.round(50000 * (0.16 - i * 0.01)),
        })),
      },
    },
  };

  const watchdog = {
    ts: iso(4 * 60000), result: 'warn', duration_ms: 8421,
    fails: ['workflows en rojo: composite-fleet'],
    fails_data: [], fails_infra: ['workflows en rojo: composite-fleet'],
    warns: ['vercel version pin no verificado'],
    steps: { files: { total: 1284 }, ci: { id: 'fixture' }, vercel: { app_js: 'v20260908a' } },
  };

  const mcpHealth = {
    generated_at: iso(3 * 60000),
    servers: VPS.map((v, i) => ({ name: `mt5-portfolio-${v}`, ok: v !== 'vps5', latency_ms: 120 + i * 40,
      error: v === 'vps5' ? 'ssh timeout' : '' })),
  };

  const pipelineTiming = { generated_at: iso(9 * 60000), total_sec: 451.2, p50_sec: 388.4, p95_sec: 612.9,
    stages: { mirror: 210.4, post_merge: 168.2, upload: 42.1, verify: 30.5 } };

  const uploadHealth = { ts: iso(8 * 60000), uploaded: 1284, failed: 0, bytes: 42_118_233 };

  const integrityReport = {
    generated_at: iso(7 * 60000), status: 'ok',
    checks: [
      { name: 'freshness', ok: true, detail: 'todas las fuentes < 45 min' },
      { name: 'real_basket', ok: true, detail: '5/5 cuentas presentes (1 heredada)' },
      { name: 'per_bot_parity', ok: true, detail: 'detail._fields == detail_n' },
    ],
  };

  const basket = { status: 'ok', generated_at: iso(3 * 3600000), recommendations: [] };

  // Filas del stream: la cuenta desconectada NO publica, a proposito.
  const liveRows = realAccounts.filter((a) => !a.disconnected).map((a) => ({
    login: String(a.login), vps: a.vps, ts: new Date().toISOString(),
    balance: a.balance, equity: a.equity + Math.round(between(-40, 40)),
    margin: a.margin, free_margin: a.free_margin,
    profit: a.profit + Math.round(between(-30, 30)),
    positions: 1, source_age_ms: 2400, publisher_id: 'fixture',
  }));

  return { snapshot, correlations, portfolio, watchdog, mcpHealth, pipelineTiming,
    uploadHealth, integrityReport, basket, liveRows, bots, accounts, realAccounts, VPS, SYMBOLS };
}

/** Detalle per-bot sintetizado a demanda (trades + serie diaria de equity). */
export function buildPerBot(bot, { trades = 400, seed = 7 } = {}) {
  const rnd = mulberry32(seed + (bot.magic || 1));
  const n = Math.min(trades, Math.max(20, bot.trades || 120));
  const list = [];
  let t = Date.now() - n * 3 * 3600000;
  for (let i = 0; i < n; i++) {
    t += Math.round(rnd() * 6 * 3600000);
    const net = Math.round((rnd() - 0.44) * 400);
    list.push({
      ticket: 800000 + i,
      magic: bot.magic,
      symbol: (bot.symbols || ['EURUSD'])[0],
      type: rnd() < 0.5 ? 'BUY' : 'SELL',
      volume: Number((0.01 + rnd() * 0.8).toFixed(2)),
      open_time: Math.floor((t - 3600000) / 1000),
      close_time: Math.floor(t / 1000),
      price_open: Number((1 + rnd() * 0.3).toFixed(5)),
      price_close: Number((1 + rnd() * 0.3).toFixed(5)),
      commission: -Number((rnd() * 4).toFixed(2)),
      swap: Number(((rnd() - 0.5) * 2).toFixed(2)),
      net,
    });
  }
  const byDay = new Map();
  for (const tr of list) {
    const d = new Date(tr.close_time * 1000).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + tr.net);
  }
  const base = 20000;
  let cum = 0, peakCum = 0, peakEq = base;
  const series = [...byDay.entries()].sort().map(([date, dailyNet]) => {
    cum += dailyNet;
    if (cum > peakCum) peakCum = cum;
    const eq = base + cum;
    if (eq > peakEq) peakEq = eq;
    const ddAbs = Math.max(0, peakEq - eq);
    return { date, cum_net: Number(cum.toFixed(2)), daily_net: Number(dailyNet.toFixed(2)),
      peak: Number(peakCum.toFixed(2)), dd_abs: Number(ddAbs.toFixed(2)),
      dd_pct: Number(((ddAbs / base) * 100).toFixed(3)) };
  });
  const wins = list.filter((x) => x.net > 0).length;
  return {
    login: bot.account_login, magic: bot.magic, account_balance: base,
    symbols: bot.symbols, trade_count: list.length,
    wins, losses: list.length - wins,
    win_rate_pct: Number(((wins / list.length) * 100).toFixed(2)),
    net_profit: Number(list.reduce((s, x) => s + x.net, 0).toFixed(2)),
    max_drawdown_abs: Math.max(...series.map((s) => s.dd_abs), 0),
    first_trade_time: list[0].open_time,
    last_trade_time: list[list.length - 1].close_time,
    daily_equity_series: series,
    trades: list,
  };
}

export { FIXTURE_REAL_LOGINS, VPS, SYMBOLS };
