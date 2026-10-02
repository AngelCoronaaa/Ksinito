'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FRAMES, TIERS } = require('../src/cosmetics');

test('precios por nivel: básico 12k, especial 16k, legendario 20k, mítico 30k', () => {
  const price = Object.fromEntries(TIERS.map((t) => [t.id, t.price]));
  assert.deepEqual(price, { basico: 12_000, especial: 16_000, legendario: 20_000, mitico: 30_000 });
  for (const f of FRAMES) assert.equal(f.price, price[f.tier], f.id);
});

test('cada borde del catálogo tiene su dibujo en public/js/frames.js (y con el mismo nivel)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'frames.js'), 'utf8');
  for (const f of FRAMES) {
    const match = src.match(new RegExp(`\\b${f.id}: \\{\\s*tier: '(\\w+)'`));
    assert.ok(match, `falta el dibujo de ${f.id}`);
    assert.equal(match[1], f.tier, f.id);
  }
  assert.equal(new Set(FRAMES.map((f) => f.id)).size, FRAMES.length);
  assert.ok(FRAMES.every((f) => f.id.length <= 32)); // users.frame y user_cosmetics.item_id son VARCHAR(32)
});
