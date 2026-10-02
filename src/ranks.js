'use strict';

// Rangos por créditos apostados en total (users.wagered: apuestas menos reembolsos),
// al estilo de los shooters competitivos: 8 rangos con 3 divisiones (I, II, III) y uno
// final sin divisiones. También sirve el ranking del top 10 por créditos.

const { EventEmitter } = require('node:events');
const express = require('express');
const auth = require('./auth');
const avatars = require('./avatars');
const cosmetics = require('./cosmetics');
const wallet = require('./wallet');
const { query, one } = require('./db');

// Umbral de cada división: `min` créditos apostados en total. El orden importa.
const TIERS = [
  { id: 'aprendiz', name: 'Aprendiz', divisions: [0, 300, 600] },
  { id: 'jugador', name: 'Jugador', divisions: [1_000, 2_000, 3_500] },
  { id: 'apostador', name: 'Apostador', divisions: [5_000, 10_000, 15_000] },
  { id: 'tahur', name: 'Tahúr', divisions: [20_000, 35_000, 55_000] },
  { id: 'as', name: 'As', divisions: [75_000, 125_000, 185_000] },
  { id: 'magnate', name: 'Magnate', divisions: [250_000, 400_000, 575_000] },
  { id: 'baron', name: 'Barón', divisions: [750_000, 1_150_000, 1_550_000] },
  { id: 'leyenda', name: 'Leyenda', divisions: [2_000_000, 3_000_000, 4_000_000] },
  { id: 'mito', name: 'Mito', divisions: [5_000_000] }, // el más alto, sin divisiones
];
const ROMAN = ['I', 'II', 'III'];

// Todos los escalones en orden, del primero (Aprendiz I) al último (Mito).
const STEPS = TIERS.flatMap((tier, t) =>
  tier.divisions.map((min, d) => ({
    tier: t,
    id: tier.id,
    name: tier.name,
    division: tier.divisions.length > 1 ? d + 1 : null,
    label: tier.divisions.length > 1 ? `${tier.name} ${ROMAN[d]}` : tier.name,
    min,
  }))
);

/** Rango para un total apostado: { tier, id, name, division, label, step }. */
function rankOf(wagered) {
  let step = 0;
  while (step + 1 < STEPS.length && wagered >= STEPS[step + 1].min) step++;
  const { tier, id, name, division, label } = STEPS[step];
  return { tier, id, name, division, label, step };
}

/** Rango con el progreso hacia el siguiente escalón (para el propio jugador). */
function progressOf(wagered) {
  const rank = rankOf(wagered);
  const next = STEPS[rank.step + 1] ?? null;
  const from = STEPS[rank.step].min;
  return {
    ...rank,
    wagered,
    next: next && { label: next.label, min: next.min, missing: next.min - wagered },
    progress: next ? (wagered - from) / (next.min - from) : 1,
  };
}

// ---------- caché de lo apostado por jugador ----------
// Las sillas del blackjack y el chat muestran el rango en cada actualización; se lee de
// aquí en vez de MySQL. Se carga al conectarse cada jugador y la actualiza wallet.

const events = new EventEmitter();
const wageredCache = new Map(); // userId -> total apostado

/** Total apostado del jugador; con `fresh` se relee de MySQL (al conectarse, por si cambió fuera del juego). */
async function load(userId, { fresh = false } = {}) {
  if (fresh || !wageredCache.has(userId)) wageredCache.set(userId, await wallet.getWagered(userId));
  return wageredCache.get(userId);
}

/** Rango corto (sin progreso) de un jugador ya cargado; Aprendiz I si aún no lo está. */
const badgeOf = (userId) => rankOf(wageredCache.get(userId) ?? 0);

wallet.events.on('wagered', (userId, wagered) => {
  const before = wageredCache.has(userId) ? rankOf(wageredCache.get(userId)).step : null;
  wageredCache.set(userId, wagered);
  const progress = progressOf(wagered);
  // `up` solo si sube de escalón (los reembolsos pueden bajarlo un poco, sin anunciarlo).
  events.emit('change', userId, progress, { up: before !== null && progress.step > before, stepChanged: progress.step !== before });
});

// ---------- ranking ----------

const TOP = 10;
const CACHE_MS = 5_000;
let topCache = { at: 0, rows: null };

async function top() {
  if (topCache.rows && Date.now() - topCache.at < CACHE_MS) return topCache.rows;
  const rows = await query(
    'SELECT id, public_id, username, credits, wagered FROM users ORDER BY credits DESC, id ASC LIMIT ?',
    [TOP]
  );
  topCache = {
    at: Date.now(),
    rows: rows.map((u, i) => ({
      position: i + 1,
      userId: Number(u.id),
      publicId: u.public_id,
      username: u.username,
      avatar: avatars.avatarUrl(Number(u.id)),
      frame: cosmetics.frameOf(Number(u.id)),
      credits: Number(u.credits),
      rank: rankOf(Number(u.wagered)),
    })),
  };
  return topCache.rows;
}

const router = express.Router();

async function requireUser(req, res, next) {
  const user = await auth.userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'No has iniciado sesión.' });
  req.user = user;
  next();
}

router.get(
  '/leaderboard',
  requireUser,
  auth.rateLimit({ windowMs: 60_000, max: 30, message: 'Demasiadas consultas. Espera un momento.', key: (req) => `user:${req.user.id}` }),
  async (req, res) => {
    const me = await one('SELECT credits, wagered FROM users WHERE id = ?', [req.user.id]);
    const credits = Number(me.credits);
    // Empates: va delante quien se registró antes (como en el top).
    const { ahead } = await one('SELECT COUNT(*) AS ahead FROM users WHERE credits > ? OR (credits = ? AND id < ?)', [
      credits, credits, req.user.id,
    ]);
    res.json({
      top: await top(),
      me: { position: Number(ahead) + 1, credits, rank: progressOf(Number(me.wagered)) },
    });
  }
);

/** Los rangos y sus umbrales, para la tabla de rangos del cliente. */
router.get('/ranks', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ tiers: TIERS.map(({ id, name, divisions }) => ({ id, name, divisions })) });
});

module.exports = { router, events, rankOf, progressOf, badgeOf, load, TIERS };
