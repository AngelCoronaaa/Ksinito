'use strict';

// Validación de disparos del minijuego "Patos" (DuckRound, en src/ducks.js), sin base de datos.

const test = require('node:test');
const assert = require('node:assert/strict');
const ducks = require('../src/ducks');

const SEED = '0123456789abcdef0123456789abcdef';
let track;

test.before(async () => {
  await ducks.ready;
  track = await import('../public/js/duck-path.js');
});

/** Ronda con la primera oleada empezada en t = 0. */
function newRound(total = 10) {
  const round = new ducks.DuckRound({ id: 1, userId: 7, seed: SEED, total, maxReward: 100, startedAtMs: 0 });
  round.startWave(0);
  return round;
}

/** Dónde está el pato `id` en el instante t. */
const at = (round, id, t) => track.duckPosition(round.ducks[id].params, t);

test('la misma semilla genera los mismos patos', () => {
  const a = new ducks.DuckRound({ id: 1, userId: 1, seed: SEED, total: 10, maxReward: 100 });
  const b = new ducks.DuckRound({ id: 2, userId: 2, seed: SEED, total: 10, maxReward: 100 });
  assert.deepEqual(a.ducks, b.ducks);
  assert.equal(a.waves, 5);
});

test('acierta un disparo donde está el pato', () => {
  const round = newRound();
  const t = 1000;
  const { x, y } = at(round, 0, t);
  const res = round.shoot(x, y, t, t);
  assert.equal(res.hit, true);
  assert.equal(res.duckId, 0);
  assert.equal(round.hits, 1);
  assert.equal(round.ammo, 2);
});

test('un disparo donde no hay pato no acierta y gasta bala', () => {
  const round = newRound();
  const t = 1000;
  const { x, y } = at(round, 0, t);
  const res = round.shoot(x > 0.5 ? 0.02 : 0.98, y < 0.5 ? 0.98 : 0.02, t, t);
  assert.equal(res.hit, false);
  assert.equal(round.ammo, 2);
});

test('rechaza un t fuera de la tolerancia sin gastar bala', () => {
  const round = newRound();
  const t = 1000;
  const { x, y } = at(round, 0, t);
  assert.equal(round.shoot(x, y, t, t + 501).ignored, 'late');
  assert.equal(round.shoot(x, y, t, t - 501).ignored, 'late');
  assert.equal(round.ammo, 3);
  assert.equal(round.shoot(x, y, t, t + 499).hit, true);
});

test('no acierta antes de 250 ms desde que aparece el pato', () => {
  const round = newRound();
  const t = round.ducks[0].params.spawnAt + 249;
  const { x, y } = at(round, 0, t);
  assert.equal(round.shoot(x, y, t, t).hit, false);
});

test('no acierta después de que el pato escape', () => {
  const round = newRound();
  const t = round.ducks[0].escapeAt;
  const { x, y } = at(round, 0, t);
  assert.equal(round.shoot(x, y, t, t).hit, false);
});

test('rechaza un t anterior al del disparo previo', () => {
  const round = newRound();
  round.shoot(0.01, 0.99, 1200, 1200);
  assert.equal(round.shoot(0.01, 0.99, 1100, 1200).ignored, 'order');
  assert.equal(round.ammo, 2);
});

test('sin balas los disparos se ignoran y los patos que quedan escapan', () => {
  const round = newRound();
  round.shoot(0.01, 0.99, 1000, 1000);
  round.shoot(0.01, 0.99, 1001, 1001);
  const last = round.shoot(0.01, 0.99, 1002, 1002);
  assert.equal(round.ammo, 0);
  assert.deepEqual(last.escaped.map((d) => d.id), [0, 1]);
  assert.ok(round.waveDone());
  const t = 1100;
  const { x, y } = at(round, 0, t);
  assert.equal(round.shoot(x, y, t, t).ignored, 'ammo');
  assert.equal(round.hits, 0);
});

test('un pato derribado no se puede derribar otra vez', () => {
  const round = newRound();
  const t = 1500;
  const { x, y } = at(round, 0, t);
  assert.equal(round.shoot(x, y, t, t).hit, true);
  const again = round.shoot(x, y, t + 1, t + 1);
  assert.notEqual(again.duckId, 0);
  assert.equal(round.hits, again.hit ? 2 : 1);
});

test('como mucho un pato por disparo', () => {
  const round = newRound();
  // Pone el segundo pato encima del primero.
  const [a, b] = round.ducks;
  Object.assign(b.params, { ...a.params });
  b.escapeAt = a.escapeAt;
  const t = 1500;
  const { x, y } = at(round, 0, t);
  const res = round.shoot(x, y, t, t);
  assert.equal(res.hit, true);
  assert.equal(round.hits, 1);
  assert.equal(round.ducks.filter((d) => d.state === 'hit').length, 1);
});

test('el snapshot no incluye patos que aún no aparecieron', () => {
  const round = new ducks.DuckRound({ id: 1, userId: 7, seed: SEED, total: 10, maxReward: 100 });
  round.startWave(round.now() + 60_000);
  assert.deepEqual(round.snapshot().flying, []);
});
