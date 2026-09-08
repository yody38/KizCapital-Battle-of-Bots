// Pins the shape of data/correlations.json as the BACKEND actually emits it.
//
// scripts/post_merge.py :: build_correlation_matrix() returns
//
//   { generated_at, bot_count, min_trades, max_bots,
//     bots:   { "<vps>-<login>-<magic>": {...}, ... },     <-- OBJECT
//     matrix: { "<vps>-<login>-<magic>": { "<key>": rho } } <-- OBJECT of OBJECTS
//
// Both `bots` and `matrix` are dictionaries keyed by "<vps>-<login>-<magic>".
// They are NOT arrays. Any frontend helper that reaches for array semantics
// (.findIndex / .length / matrix[i][j] with numeric indices) silently gets
// undefined instead of a correlation — no exception, no console error, just a
// blank or wrong correlation panel. This file documents that failure mode so
// the fix cannot regress.
//
// Zero dependencies. Run with:  node --test tests/js/
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const KEYS = ['vps1-900001-5001', 'vps1-900002-5002', 'vps2-900003-5003'];

/** A correlations.json with the exact shape build_correlation_matrix() emits. */
function makeCorrelations() {
  const rho = {
    'vps1-900001-5001': { 'vps1-900001-5001': 1.0, 'vps1-900002-5002': 0.12, 'vps2-900003-5003': -0.34 },
    'vps1-900002-5002': { 'vps1-900001-5001': 0.12, 'vps1-900002-5002': 1.0, 'vps2-900003-5003': 0.51 },
    'vps2-900003-5003': { 'vps1-900001-5001': -0.34, 'vps1-900002-5002': 0.51, 'vps2-900003-5003': 1.0 },
  };
  const bots = {};
  KEYS.forEach((key, i) => {
    const [vps, login, magic] = key.split('-');
    bots[key] = {
      vps,
      login: Number(login),
      magic: Number(magic),
      symbols: ['EURUSD'],
      promotion_score: 60 - i,
      promotion_status: i === 0 ? 'READY' : 'NEAR',
      net_profit: 1000 - 100 * i,
      trades: 120 + i,
    };
  });
  return {
    generated_at: '2026-09-08T12:00:00+00:00',
    bot_count: KEYS.length,
    min_trades: 25,
    max_bots: 60,
    bots,
    matrix: rho,
  };
}

/** THE BUG: array semantics over an object. */
function lookupWithArraySemantics(corr, keyA, keyB) {
  const i = corr.bots.findIndex((b) => `${b.vps}-${b.login}-${b.magic}` === keyA);
  const j = corr.bots.findIndex((b) => `${b.vps}-${b.login}-${b.magic}` === keyB);
  return corr.matrix[i][j];
}

/** THE FIX: dictionary semantics, the shape the backend really emits. */
function lookupWithDictSemantics(corr, keyA, keyB) {
  const row = corr.matrix[keyA];
  return row ? row[keyB] : undefined;
}

test('bots and matrix are objects keyed by <vps>-<login>-<magic>, not arrays', () => {
  const corr = makeCorrelations();
  assert.strictEqual(Array.isArray(corr.bots), false);
  assert.strictEqual(Array.isArray(corr.matrix), false);
  for (const key of Object.keys(corr.bots)) {
    assert.match(key, /^vps\d+-\d+-\d+$/);
    assert.ok(corr.matrix[key], `matrix is missing the row for ${key}`);
  }
  assert.strictEqual(corr.bot_count, Object.keys(corr.bots).length);
});

test('the shape survives a JSON round-trip as an object (arrays would coerce)', () => {
  const corr = JSON.parse(JSON.stringify(makeCorrelations()));
  assert.strictEqual(Array.isArray(corr.bots), false);
  assert.strictEqual(typeof corr.bots, 'object');
  assert.deepStrictEqual(Object.keys(corr.bots).sort(), [...KEYS].sort());
});

test('array-semantics lookup FAILS on the real shape (documents the frontend bug)', () => {
  const corr = makeCorrelations();
  assert.throws(
    () => lookupWithArraySemantics(corr, KEYS[0], KEYS[1]),
    (err) => err instanceof TypeError && /findIndex is not a function/.test(err.message),
    'corr.bots is an object: .findIndex must not exist on it',
  );
});

test('numeric indexing into the matrix yields undefined, never a correlation', () => {
  const corr = makeCorrelations();
  // Even if the index lookup were fixed, matrix rows are keyed by string ids:
  // matrix[0] is undefined, so matrix[0][0] throws instead of returning rho.
  assert.strictEqual(corr.matrix[0], undefined);
  assert.throws(() => corr.matrix[0][0], TypeError);
  assert.strictEqual(corr.bots.length, undefined, 'an object has no .length');
});

test('dict-semantics lookup returns the correlation, symmetric and 1.0 on the diagonal', () => {
  const corr = makeCorrelations();
  assert.strictEqual(lookupWithDictSemantics(corr, KEYS[0], KEYS[1]), 0.12);
  assert.strictEqual(lookupWithDictSemantics(corr, KEYS[1], KEYS[0]), 0.12);
  assert.strictEqual(lookupWithDictSemantics(corr, KEYS[1], KEYS[2]), 0.51);
  for (const key of KEYS) {
    assert.strictEqual(lookupWithDictSemantics(corr, key, key), 1.0);
  }
});

test('an unknown key is undefined, not a silent zero correlation', () => {
  const corr = makeCorrelations();
  assert.strictEqual(lookupWithDictSemantics(corr, 'vps9-999999-9999', KEYS[0]), undefined);
  assert.strictEqual(lookupWithDictSemantics(corr, KEYS[0], 'vps9-999999-9999'), undefined);
});

test('a null correlation (too few overlapping days) is preserved, not coerced to 0', () => {
  const corr = makeCorrelations();
  corr.matrix[KEYS[0]][KEYS[2]] = null;
  const rho = lookupWithDictSemantics(corr, KEYS[0], KEYS[2]);
  assert.strictEqual(rho, null);
  assert.notStrictEqual(rho, 0, 'null means UNKNOWN overlap, never "uncorrelated"');
});
