'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rankOf, progressOf, TIERS } = require('../src/ranks');

test('cada umbral de división da exactamente ese rango, y un crédito menos el anterior', () => {
  let previous = null;
  for (const tier of TIERS) {
    tier.divisions.forEach((min, d) => {
      const rank = rankOf(min);
      assert.equal(rank.id, tier.id);
      assert.equal(rank.division, tier.divisions.length > 1 ? d + 1 : null);
      if (previous) assert.equal(rankOf(min - 1).step, previous.step);
      previous = rank;
    });
  }
});

test('más apostado nunca da un rango menor', () => {
  let last = -1;
  for (let w = 0; w <= 6_000_000; w += 997) {
    const { step } = rankOf(w);
    assert.ok(step >= last, `bajó en ${w}`);
    last = step;
  }
});

test('nombres: tres divisiones romanas y el último sin división', () => {
  assert.equal(rankOf(0).label, 'Aprendiz I');
  assert.equal(rankOf(15_000).label, 'Apostador III');
  assert.equal(rankOf(5_000_000).label, 'Mito');
  assert.equal(rankOf(Number.MAX_SAFE_INTEGER).label, 'Mito');
});

test('progreso hacia la siguiente división', () => {
  const p = progressOf(1_500);
  assert.equal(p.label, 'Jugador I');
  assert.deepEqual(p.next, { label: 'Jugador II', min: 2_000, missing: 500 });
  assert.equal(p.progress, 0.5);
  const top = progressOf(9_000_000);
  assert.equal(top.next, null);
  assert.equal(top.progress, 1);
});
