'use strict';

// Minijuego "Patos": individual y gratis. Cada pato derribado da DUCK_REWARD créditos, que se
// suman una sola vez, al cerrar la ronda, en una transacción. Como jugar no cuesta nada, un bot
// que apunte bien podría farmear créditos: la protección real es el tope diario
// (DUCKS_DAILY_CREDIT_LIMIT), que se comprueba al empezar y otra vez al pagar.
//
// El servidor es la única autoridad. Genera los patos con crypto a partir de la semilla de la
// ronda, los suelta de uno en uno con `ducks:spawn` cuando aparecen (nunca por adelantado) y
// decide si un disparo acierta calculando dónde estaba cada pato en ese instante con la misma
// duckPosition() con la que los dibuja el navegador (public/js/duck-path.js). El cliente solo
// dice "disparé en (x, y) en el instante t", y t tiene que cuadrar con el reloj del servidor.
//
// Las rondas activas viven en memoria (una por jugador); `duck_rounds` guarda el historial y
// sirve para el cooldown y el tope diario. Todas las operaciones de un jugador pasan por su
// SerialQueue, y los temporizadores de la ronda también (con queue.fire()).

const crypto = require('node:crypto');
const express = require('express');
const auth = require('./auth');
const wallet = require('./wallet');
const db = require('./db');
const { intEnv } = require('./env');
const { SerialQueue } = require('./queue');
const { GameError } = require('./errors');

const env = (name, fallback, opts) => intEnv(name, fallback, { ...opts, label: 'ducks' });
const DUCKS_ENABLED = env('DUCKS_ENABLED', 1, { max: 1 }) === 1;
const DUCK_REWARD = env('DUCK_REWARD', 2, { max: 1_000_000 });
const DUCKS_PER_ROUND = env('DUCKS_PER_ROUND', 10, { min: 1, max: 50 });
const DUCKS_DAILY_CREDIT_LIMIT = env('DUCKS_DAILY_CREDIT_LIMIT', 100, { max: 1_000_000_000 });
const DUCKS_ROUND_COOLDOWN_SECONDS = env('DUCKS_ROUND_COOLDOWN_SECONDS', 10, { max: 7 * 86400 });

const DUCKS_PER_WAVE = 2;
const AMMO_PER_WAVE = 3;
const DUCK_LIFE_MS = 5000; // tiempo máximo de cada pato en pantalla
const NEXT_DUCK_DELAY_MS = [300, 900]; // el segundo pato de la oleada sale un poco después
const FIRST_WAVE_MS = 1500; // "¡Prepárate!" antes de la primera oleada
const WAVE_PAUSE_MS = 1500; // entre oleadas
const REACTION_MS = 250; // nadie acierta antes de esto desde que aparece un pato
const LATENCY_MS = 500; // diferencia máxima entre el `t` del cliente y el reloj del servidor
const IDLE_MS = 60_000; // sin disparos durante este tiempo, la ronda se cierra
const OFFLINE_MS = 30_000; // sin ninguna pestaña conectada durante este tiempo, también
const SHOTS_PER_SECOND = 10; // por jugador; el exceso se descarta sin gastar balas
const BASE_SPEED = 0.42; // altos de pantalla por segundo en la primera oleada
const SPEED_STEP = 0.09; // se suma en cada oleada
const BASE_RADIUS = 0.075; // radio de impacto (altos de pantalla) en la primera oleada
const RADIUS_STEP = 0.004; // se resta en cada oleada

// Misma función de trayectoria que el navegador. Es un módulo ESM: se carga con import().
let track = null;
const ready = import('../public/js/duck-path.js').then((mod) => {
  track = mod;
});

const SQL = {
  lockUser: 'SELECT id FROM users WHERE id = ? FOR UPDATE',
  sinceLast: 'SELECT TIMESTAMPDIFF(SECOND, MAX(ended_at), NOW()) AS since FROM duck_rounds WHERE user_id = ?',
  earnedToday: `
    SELECT reward, TIMESTAMPDIFF(SECOND, NOW(), credited_at + INTERVAL 1 DAY) AS expires_in
    FROM duck_rounds
    WHERE user_id = ? AND reward > 0 AND credited_at > NOW() - INTERVAL 1 DAY
    ORDER BY credited_at`,
  insert: 'INSERT INTO duck_rounds (user_id, seed, started_at, ducks_total) VALUES (?, ?, NOW(), ?)',
  settle: `
    UPDATE duck_rounds
    SET ended_at = NOW(), ducks_hit = ?, shots = ?, reward = ?, credited_at = NOW()
    WHERE id = ? AND user_id = ? AND credited_at IS NULL`,
  abandon: 'UPDATE duck_rounds SET ended_at = NOW() WHERE ended_at IS NULL',
};

// ---------- generación de patos ----------

/** Números en [0, 1) derivados de la semilla: la misma semilla da siempre los mismos patos. */
function seeded(seed) {
  return (label) => crypto.createHmac('sha256', seed).update(label).digest().readUIntBE(0, 6) / 2 ** 48;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function makeDucks(seed, total) {
  const rand = seeded(seed);
  return Array.from({ length: total }, (_, id) => {
    const r = (key) => rand(`${id}:${key}`);
    const wave = Math.floor(id / DUCKS_PER_WAVE); // 0 = primera
    const x = 0.12 + 0.76 * r('x');
    // Cerca de un lado, sale hacia el centro; si no, al azar.
    const dir = x < 0.3 ? 1 : x > 0.7 ? -1 : r('dir') < 0.5 ? -1 : 1;
    const angle = ((30 + 40 * r('angle')) * Math.PI) / 180;
    const speed = (BASE_SPEED + SPEED_STEP * wave) * (0.9 + 0.2 * r('speed'));
    const [minDelay, maxDelay] = NEXT_DUCK_DELAY_MS;
    return {
      id,
      wave: wave + 1,
      delay: (id % DUCKS_PER_WAVE) * Math.round(minDelay + (maxDelay - minDelay) * r('delay')),
      params: {
        spawnAt: null, // se fija al empezar su oleada
        x: round6(x),
        y: track.BOUNDS.floor, // sale de entre los juncos
        // La velocidad se reparte en ejes aquí (con seno y coseno), así duckPosition() no los necesita.
        vx: round6((dir * speed * Math.cos(angle)) / track.ASPECT),
        vy: round6(-speed * Math.sin(angle)),
        bounces: 2 + Math.floor(4 * r('bounces')),
        radius: round6(Math.max(0.05, BASE_RADIUS - RADIUS_STEP * wave)),
        life: DUCK_LIFE_MS,
      },
      state: 'waiting', // waiting → flying → hit | escaped
      escapeAt: null,
      hitAt: null,
    };
  });
}

// ---------- ronda (estado en memoria, sin base de datos ni temporizadores) ----------

class DuckRound {
  constructor({ id, userId, seed, total, maxReward, startedAtMs = performance.now() }) {
    this.id = id;
    this.userId = userId;
    this.ducks = makeDucks(seed, total);
    this.waves = Math.ceil(total / DUCKS_PER_WAVE);
    this.wave = 0; // 0 = aún no empezó la primera
    this.waveOpen = false;
    this.ammo = 0;
    this.shots = 0;
    this.hits = 0;
    this.lastShotT = -Infinity;
    this.maxReward = maxReward; // cupo diario que quedaba al empezar
    this.startedAtMs = startedAtMs; // reloj monótono: no le afectan los cambios de hora
    this.ended = false;
    this.timers = new Set();
    this.idleTimer = null;
    this.offlineTimer = null;
  }

  /** ms desde el inicio de la ronda según el servidor. */
  now() {
    return performance.now() - this.startedAtMs;
  }

  waveDucks() {
    return this.ducks.filter((d) => d.wave === this.wave);
  }

  /** Empieza la siguiente oleada en el instante `at`. Devuelve sus patos. */
  startWave(at) {
    this.wave++;
    this.waveOpen = true;
    this.ammo = AMMO_PER_WAVE;
    const ducks = this.waveDucks();
    for (const d of ducks) {
      d.params.spawnAt = Math.round(at + d.delay);
      d.escapeAt = track.duckEscapeAt(d.params);
      d.state = 'flying';
    }
    return ducks;
  }

  /**
   * Disparo en (x, y) en el instante `t` del cliente; `serverT` es cuándo llegó según el servidor.
   * Devuelve { ignored } si no cuenta, o { hit, duckId, escaped } (patos que escapan por quedarse sin balas).
   */
  shoot(x, y, t, serverT) {
    if (Math.abs(t - serverT) > LATENCY_MS) return { ignored: 'late' };
    if (t < this.lastShotT) return { ignored: 'order' };
    if (!this.waveOpen || this.ammo === 0) return { ignored: 'ammo' };
    this.ammo--;
    this.shots++;
    this.lastShotT = t;

    // Como mucho un pato por disparo: el más cercano de los que se podían alcanzar.
    let target = null;
    let best = Infinity;
    for (const d of this.waveDucks()) {
      if (d.state !== 'flying' || t < d.params.spawnAt + REACTION_MS || t >= d.escapeAt) continue;
      const pos = track.duckPosition(d.params, t);
      const dist = track.distance(pos.x, pos.y, x, y);
      if (dist < d.params.radius && dist < best) {
        target = d;
        best = dist;
      }
    }
    if (target) {
      target.state = 'hit';
      target.hitAt = t;
      this.hits++;
    }
    return { hit: target !== null, duckId: target?.id ?? null, escaped: this.ammo === 0 ? this.escapeAll(t) : [] };
  }

  /** Sin balas: los patos que quedan en la oleada escapan en el instante `at`. */
  escapeAll(at) {
    const escaped = this.waveDucks().filter((d) => d.state === 'flying');
    for (const d of escaped) {
      d.state = 'escaped';
      d.escapeAt = Math.min(d.escapeAt, at);
    }
    return escaped;
  }

  escape(duck) {
    if (duck.state === 'flying') duck.state = 'escaped';
  }

  /** ¿Ya no queda ningún pato volando en la oleada actual? */
  waveDone() {
    return this.waveDucks().every((d) => d.state !== 'flying');
  }

  /** Lo que necesita el cliente para dibujar la ronda (al empezar o al volver a conectarse). */
  snapshot() {
    const now = this.now();
    return {
      roundId: this.id,
      now,
      ducksTotal: this.ducks.length,
      waves: this.waves,
      wave: this.wave,
      waveOpen: this.waveOpen,
      ammo: this.ammo,
      ammoPerWave: AMMO_PER_WAVE,
      reward: DUCK_REWARD,
      maxReward: this.maxReward,
      ducksHit: this.hits,
      results: this.ducks.map((d) => (d.state === 'hit' || d.state === 'escaped' ? d.state : 'pending')),
      // Solo los que ya aparecieron: los siguientes llegan con ducks:spawn.
      flying: this.ducks
        .filter((d) => d.state === 'flying' && d.params.spawnAt <= now)
        .map((d) => ({ duckId: d.id, params: d.params })),
    };
  }
}

// ---------- límites (cooldown y tope diario) ----------

/** Espera por cooldown, cupo diario restante y segundos hasta que se libere cupo. `q` es db o una transacción. */
async function readLimits(q, userId) {
  const last = await q.one(SQL.sinceLast, [userId]);
  const rows = await q.query(SQL.earnedToday, [userId]);
  const since = last?.since === null || last?.since === undefined ? null : Number(last.since);
  let earned = rows.reduce((sum, row) => sum + Number(row.reward), 0);
  const dailyRemaining = Math.max(0, DUCKS_DAILY_CREDIT_LIMIT - earned);
  let resetSeconds = 0;
  if (dailyRemaining === 0) {
    // Se libera cupo cuando la ganancia más antigua sale de la ventana de 24 h.
    for (const row of rows) {
      earned -= Number(row.reward);
      if (earned < DUCKS_DAILY_CREDIT_LIMIT) {
        resetSeconds = Math.max(1, Number(row.expires_in) + 1);
        break;
      }
    }
  }
  return {
    cooldownSeconds: since === null ? 0 : Math.max(0, DUCKS_ROUND_COOLDOWN_SECONDS - since),
    dailyRemaining,
    resetSeconds,
  };
}

// ---------- rondas en juego ----------

let io = null;
const rounds = new Map(); // userId -> DuckRound
const queues = new Map(); // userId -> SerialQueue

function queueOf(userId) {
  let queue = queues.get(userId);
  if (!queue) queues.set(userId, (queue = new SerialQueue(`ducks:${userId}`)));
  return queue;
}

/** Los eventos van a todas las pestañas del jugador. */
function send(userId, event, data) {
  io?.to(`user:${userId}`).emit(event, data);
}

/** Temporizador de la ronda: pasa por la cola del jugador y no hace nada si la ronda ya terminó. */
function schedule(round, ms, fn) {
  const handle = setTimeout(() => {
    round.timers.delete(handle);
    queueOf(round.userId).fire(() => (round.ended ? undefined : fn()));
  }, Math.max(0, ms));
  round.timers.add(handle);
  return handle;
}

function cancel(round, handle) {
  if (!handle) return;
  clearTimeout(handle);
  round.timers.delete(handle);
}

function armIdle(round) {
  cancel(round, round.idleTimer);
  round.idleTimer = schedule(round, IDLE_MS, () => end(round, 'idle'));
}

function assertEnabled() {
  if (!DUCKS_ENABLED) throw new GameError('El juego de patos está desactivado.');
}

/** Empieza una ronda, o devuelve la que ya está en juego (p. ej. tras recargar la página). */
function start(userId) {
  assertEnabled();
  return queueOf(userId).run(async () => {
    const active = rounds.get(userId);
    if (active) return send(userId, 'ducks:round', active.snapshot());

    const limits = await readLimits(db, userId);
    if (limits.cooldownSeconds > 0) {
      throw new GameError(`Espera ${limits.cooldownSeconds} s para jugar otra ronda.`, { retryAfter: limits.cooldownSeconds });
    }
    if (limits.dailyRemaining === 0) {
      throw new GameError('Ya ganaste el máximo de créditos de hoy con los patos.', {
        retryAfter: limits.resetSeconds,
        dailyLimit: true,
      });
    }

    const seed = crypto.randomBytes(16).toString('hex');
    const { insertId } = await db.query(SQL.insert, [userId, seed, DUCKS_PER_ROUND]);
    const round = new DuckRound({ id: Number(insertId), userId, seed, total: DUCKS_PER_ROUND, maxReward: limits.dailyRemaining });
    rounds.set(userId, round);
    schedule(round, FIRST_WAVE_MS, () => nextWave(round));
    armIdle(round);
    send(userId, 'ducks:round', round.snapshot());
  });
}

function nextWave(round) {
  const ducks = round.startWave(Math.round(round.now()));
  send(round.userId, 'ducks:wave', { roundId: round.id, wave: round.wave, waves: round.waves, ammo: round.ammo, now: round.now() });
  for (const duck of ducks) {
    // Cada pato se envía justo cuando aparece, no antes.
    schedule(round, duck.params.spawnAt - round.now(), () => {
      if (duck.state !== 'flying') return; // escapó antes de salir (la oleada se quedó sin balas)
      send(round.userId, 'ducks:spawn', { roundId: round.id, duckId: duck.id, params: duck.params, now: round.now() });
    });
    // Se da por escapado un poco después de su escape: un disparo anterior puede llegar con retraso.
    schedule(round, duck.escapeAt + LATENCY_MS - round.now(), () => {
      if (duck.state !== 'flying') return;
      round.escape(duck);
      send(round.userId, 'ducks:escaped', { roundId: round.id, duckId: duck.id, at: duck.escapeAt });
      return afterChange(round);
    });
  }
}

/** Si la oleada terminó, programa la siguiente o cierra la ronda. */
function afterChange(round) {
  if (!round.waveOpen || !round.waveDone()) return undefined;
  round.waveOpen = false;
  if (round.wave < round.waves) {
    schedule(round, WAVE_PAUSE_MS, () => nextWave(round));
    return undefined;
  }
  return end(round, 'complete');
}

// Límite de disparos por jugador (cubre todas sus pestañas).
const shotBuckets = new Map(); // userId -> { tokens, last }
setInterval(() => {
  const old = performance.now() - 10_000;
  for (const [userId, bucket] of shotBuckets) if (bucket.last < old) shotBuckets.delete(userId);
}, 60_000).unref();

function takeShot(userId) {
  const now = performance.now();
  const bucket = shotBuckets.get(userId) ?? { tokens: SHOTS_PER_SECOND, last: now };
  bucket.tokens = Math.min(SHOTS_PER_SECOND, bucket.tokens + ((now - bucket.last) / 1000) * SHOTS_PER_SECOND);
  bucket.last = now;
  shotBuckets.set(userId, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** `ducks:shot { roundId, x, y, t }`. Todo lo demás que venga en el payload se ignora. */
function shoot(userId, payload) {
  assertEnabled();
  const receivedAt = performance.now(); // antes de esperar en la cola
  if (!takeShot(userId)) throw new GameError('Vas demasiado rápido');
  const { roundId, x, y, t } = payload;
  const valid = Number.isSafeInteger(roundId) && [x, y, t].every((n) => Number.isFinite(n)) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
  if (!valid) throw new GameError('Disparo no válido');

  return queueOf(userId).run(() => {
    const round = rounds.get(userId);
    if (!round || round.id !== roundId) throw new GameError('Esa ronda ya terminó');
    const result = round.shoot(x, y, t, receivedAt - round.startedAtMs);
    armIdle(round);
    send(userId, 'ducks:shotResult', {
      roundId,
      t,
      hit: result.hit === true,
      duckId: result.duckId ?? null,
      ammoLeft: round.ammo,
      ignored: result.ignored ?? null,
    });
    for (const duck of result.escaped ?? []) send(userId, 'ducks:escaped', { roundId, duckId: duck.id, at: duck.escapeAt });
    return afterChange(round);
  });
}

/** `ducks:quit { roundId }`: cierra la ronda y paga lo ganado hasta ahora. */
function quit(userId, roundId) {
  assertEnabled();
  return queueOf(userId).run(() => {
    const round = rounds.get(userId);
    if (!round || round.id !== roundId) throw new GameError('No tienes ninguna ronda en juego.');
    return end(round, 'quit');
  });
}

/** Ronda en juego del jugador (para recuperarla tras recargar o reconectar), o null. */
function resume(userId) {
  assertEnabled();
  return rounds.get(userId)?.snapshot() ?? null;
}

/** Sin pestañas conectadas: la ronda se cierra (y se paga) si no vuelve en OFFLINE_MS. */
function setOnline(userId, online) {
  const round = rounds.get(userId);
  if (!round) return;
  cancel(round, round.offlineTimer);
  round.offlineTimer = online ? null : schedule(round, OFFLINE_MS, () => end(round, 'offline'));
}

/**
 * Paga la ronda: una sola transacción que la marca como cobrada y suma los créditos. El UPDATE
 * condicional (credited_at IS NULL) hace imposible pagarla dos veces.
 */
async function settle(round) {
  const run = () =>
    db.transaction(async (tx) => {
      // Bloquear al jugador ordena este pago frente a cualquier otro suyo que lea el cupo.
      if (!(await tx.one(SQL.lockUser, [round.userId]))) throw new Error(`No existe el usuario ${round.userId}`);
      const { dailyRemaining } = await readLimits(tx, round.userId);
      const reward = Math.min(round.hits * DUCK_REWARD, dailyRemaining);
      const { affectedRows } = await tx.query(SQL.settle, [round.hits, round.shots, reward, round.id, round.userId]);
      if (affectedRows !== 1) return { reward: 0, balance: null }; // ya estaba cerrada
      const balance = reward > 0 ? await wallet.credit(round.userId, reward, `duck_reward:${round.id}`, tx) : null;
      return { reward, balance };
    });
  try {
    return await run();
  } catch (err) {
    // MySQL puede abortar una transacción por bloqueo mutuo; se reintenta una vez.
    if (err.code !== 'ER_LOCK_DEADLOCK') throw err;
    return run();
  }
}

/** Cierra la ronda (se llama desde dentro de la cola del jugador), la paga y avisa a sus pestañas. */
async function end(round, reason) {
  if (round.ended) return;
  round.ended = true;
  for (const handle of round.timers) clearTimeout(handle);
  round.timers.clear();
  if (rounds.get(round.userId) === round) rounds.delete(round.userId);

  let paid = null;
  try {
    paid = await settle(round);
  } catch (err) {
    console.error(`[ducks] No se pudo pagar la ronda ${round.id} (${round.hits} patos) de ${round.userId}`, err);
  }
  let limits = null;
  try {
    limits = await readLimits(db, round.userId);
  } catch (err) {
    console.error('[ducks] Al leer el cupo tras la ronda', err);
  }
  send(round.userId, 'ducks:end', {
    roundId: round.id,
    reason, // complete | quit | idle | offline
    ducksHit: round.hits,
    ducksTotal: round.ducks.length,
    reward: paid?.reward ?? 0,
    balance: paid?.balance ?? null,
    error: paid === null,
    dailyRemaining: limits?.dailyRemaining ?? null,
    cooldownSeconds: limits?.cooldownSeconds ?? DUCKS_ROUND_COOLDOWN_SECONDS,
    resetSeconds: limits?.resetSeconds ?? 0,
  });
}

/** Lo que necesita el cliente para la pantalla de inicio del juego. */
async function getStatus(userId) {
  if (!DUCKS_ENABLED) return { enabled: false };
  const limits = await readLimits(db, userId);
  return {
    enabled: true,
    reward: DUCK_REWARD,
    ducksPerRound: DUCKS_PER_ROUND,
    dailyLimit: DUCKS_DAILY_CREDIT_LIMIT,
    ...limits,
    active: rounds.has(userId),
  };
}

/** Se llama al arrancar: las rondas que dejó a medias un reinicio se cierran sin créditos. */
async function init(server) {
  io = server;
  await ready;
  const { affectedRows } = await db.query(SQL.abandon);
  if (affectedRows) console.log(`[ducks] ${affectedRows} ronda(s) a medias por un reinicio cerradas sin créditos`);
  if (!DUCKS_ENABLED) console.log('[ducks] Juego de patos desactivado (DUCKS_ENABLED=0)');
}

// ---------- rutas ----------

const router = express.Router();
const perUser = (req) => `user:${req.user.id}`;

async function requireUser(req, res, next) {
  const user = await auth.userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'No has iniciado sesión.' });
  req.user = user;
  next();
}

router.get(
  '/ducks/status',
  requireUser,
  auth.rateLimit({ windowMs: 60 * 1000, max: 60, message: 'Demasiadas peticiones. Espera un momento.', key: perUser }),
  async (req, res) => res.json(await getStatus(req.user.id))
);

module.exports = {
  init,
  router,
  start,
  shoot,
  quit,
  resume,
  setOnline,
  getStatus,
  ready,
  DuckRound,
  DUCKS_ENABLED,
};
