// Trayectoria de los patos del minijuego "Patos". Este mismo archivo lo usan el servidor
// (src/ducks.js, para decidir si un disparo acierta) y el navegador (public/js/ducks.js, para
// dibujarlos), así que los dos calculan exactamente la misma posición.
//
// Coordenadas normalizadas: x e y van de 0 a 1 en un área 16:9, con y = 0 arriba. Solo se usan
// sumas, restas, multiplicaciones, divisiones y Math.sqrt (nada de Math.sin/cos, cuyo último
// decimal puede variar entre navegadores): el resultado es idéntico en cualquier motor.
//
// Parámetros de un pato (los genera el servidor): spawnAt (ms desde el inicio de la ronda),
// x, y (posición inicial), vx, vy (velocidad en unidades por segundo), bounces (rebotes antes
// de salir volando de la pantalla), radius (radio de impacto, en altos de pantalla) y life
// (ms que puede estar en pantalla).

/** Proporción del área de juego (ancho / alto). */
export const ASPECT = 16 / 9;

/** Caja por la que vuelan. Rebotan en los lados y arriba (gastando rebotes) y en el pasto (`floor`, siempre). */
export const BOUNDS = Object.freeze({ left: 0.04, right: 0.96, top: 0.06, floor: 0.72 });

const OUT = 0.1; // más allá de este margen el pato ya no se ve

/**
 * Recorre la trayectoria durante `seconds` segundos. Se detiene antes si el pato llega a un
 * borde sin rebotes (`free`): desde ahí sigue en línea recta hasta salir de la pantalla.
 */
function walk(p, seconds) {
  let x = p.x;
  let y = p.y;
  let vx = p.vx;
  let vy = p.vy;
  let bounces = p.bounces;
  let left = seconds;
  let free = false;
  for (let i = 0; i < 100 && left > 0; i++) {
    const tx = vx > 0 ? (BOUNDS.right - x) / vx : vx < 0 ? (BOUNDS.left - x) / vx : Infinity;
    const ty = vy < 0 ? (BOUNDS.top - y) / vy : vy > 0 ? (BOUNDS.floor - y) / vy : Infinity;
    const dt = Math.max(0, Math.min(tx, ty));
    if (dt >= left) break;
    x += vx * dt;
    y += vy * dt;
    left -= dt;
    if (ty < tx && vy > 0) {
      vy = -vy; // el pasto siempre lo devuelve hacia arriba
      continue;
    }
    if (bounces === 0) {
      free = true;
      break;
    }
    bounces--;
    if (tx <= ty) vx = -vx;
    else vy = -vy;
  }
  return { x, y, vx, vy, left, free };
}

/**
 * Posición del pato en el instante `t` (ms desde el inicio de la ronda).
 * `dir` es hacia dónde mira (1 derecha, -1 izquierda) y `gone`, si ya salió de la pantalla.
 */
export function duckPosition(p, t) {
  const w = walk(p, Math.max(0, t - p.spawnAt) / 1000);
  const x = w.x + w.vx * w.left;
  const y = w.y + w.vy * w.left;
  return { x, y, dir: w.vx < 0 ? -1 : 1, gone: x < -OUT || x > 1 + OUT || y < -OUT };
}

/** Instante (ms desde el inicio de la ronda) en que el pato escapa: al acabar su tiempo o al salir de la pantalla. */
export function duckEscapeAt(p) {
  const life = p.life / 1000;
  const w = walk(p, life);
  if (!w.free) return p.spawnAt + p.life;
  const tx = w.vx > 0 ? (1 + OUT - w.x) / w.vx : w.vx < 0 ? (-OUT - w.x) / w.vx : Infinity;
  const ty = w.vy < 0 ? (-OUT - w.y) / w.vy : Infinity;
  const out = life - w.left + Math.min(tx, ty);
  return p.spawnAt + Math.min(p.life, Math.ceil(out * 1000));
}

/** Distancia entre dos puntos normalizados, en altos de pantalla (corrige la proporción 16:9). */
export function distance(ax, ay, bx, by) {
  const dx = (ax - bx) * ASPECT;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}
