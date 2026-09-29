// Trayectoria de los patos (public/js/duck-path.js). El servidor y el navegador importan este
// mismo archivo, así que calculan lo mismo por construcción; aquí se comprueba que la función
// es pura, determinista y que respeta la caja de vuelo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ASPECT, BOUNDS, duckPosition, duckEscapeAt, distance } from '../public/js/duck-path.js';

const duck = (over = {}) => ({ spawnAt: 1000, x: 0.5, y: BOUNDS.floor, vx: 0.2, vy: -0.4, bounces: 3, radius: 0.07, life: 5000, ...over });

test('la misma entrada da exactamente la misma posición', () => {
  const p = duck();
  for (let t = 1000; t <= 6000; t += 37) {
    assert.deepEqual(duckPosition(p, t), duckPosition(structuredClone(p), t));
  }
});

test('no modifica los parámetros', () => {
  const p = duck();
  const copy = structuredClone(p);
  duckPosition(p, 5000);
  duckEscapeAt(p);
  assert.deepEqual(p, copy);
});

test('antes de aparecer está en su posición inicial', () => {
  const p = duck();
  assert.deepEqual(duckPosition(p, 0), { x: p.x, y: p.y, dir: 1, gone: false });
});

test('mientras le quedan rebotes no sale de la caja de vuelo', () => {
  const p = duck({ bounces: 1000, vx: 0.37, vy: -0.61 });
  for (let t = p.spawnAt; t <= p.spawnAt + 20_000; t += 10) {
    const { x, y } = duckPosition(p, t);
    assert.ok(x >= BOUNDS.left - 1e-9 && x <= BOUNDS.right + 1e-9, `x=${x} en t=${t}`);
    assert.ok(y >= BOUNDS.top - 1e-9 && y <= BOUNDS.floor + 1e-9, `y=${y} en t=${t}`);
  }
});

test('rebota en el borde derecho y cambia de dirección', () => {
  const p = duck({ x: 0.9, vx: 0.2, vy: -0.01 });
  const before = duckPosition(p, p.spawnAt + 200);
  const after = duckPosition(p, p.spawnAt + 600);
  assert.equal(before.dir, 1);
  assert.equal(after.dir, -1);
  assert.ok(after.x < BOUNDS.right);
});

test('sin rebotes sale de la pantalla y escapa antes de su tiempo', () => {
  const p = duck({ bounces: 0, vy: -0.8, vx: 0 });
  const escapeAt = duckEscapeAt(p);
  assert.ok(escapeAt < p.spawnAt + p.life);
  assert.equal(duckPosition(p, escapeAt + 1).gone, true);
  assert.equal(duckPosition(p, p.spawnAt + 100).gone, false);
});

test('con rebotes de sobra escapa al acabar su tiempo', () => {
  const p = duck({ bounces: 100 });
  assert.equal(duckEscapeAt(p), p.spawnAt + p.life);
});

test('la distancia corrige la proporción 16:9', () => {
  assert.equal(distance(0, 0, 0, 0.5), 0.5);
  assert.ok(Math.abs(distance(0, 0, 0.5, 0) - 0.5 * ASPECT) < 1e-12);
});
