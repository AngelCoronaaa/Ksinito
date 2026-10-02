'use strict';

// Tienda de cosméticos: bordes de perfil animados (con alas metálicas) que se compran con
// créditos y se ven alrededor de la foto en las mesas, el chat y el ranking. Comprar no
// cuenta como apuesta (no sube el rango): es wallet.debit(), con su asiento "cosmetic:<id>".
//
// Aquí solo están el catálogo, los precios y quién tiene qué; el dibujo de cada borde está en
// public/js/frames.js (mismo id).

const { EventEmitter } = require('node:events');
const express = require('express');
const auth = require('./auth');
const wallet = require('./wallet');
const db = require('./db');
const { GameError } = require('./errors');

const TIERS = [
  { id: 'basico', name: 'Básico', price: 12_000 },
  { id: 'especial', name: 'Especial', price: 16_000 },
  { id: 'legendario', name: 'Legendario', price: 20_000 },
  { id: 'mitico', name: 'Mítico', price: 30_000 },
];
const TIER_BY_ID = new Map(TIERS.map((t) => [t.id, t]));

const FRAMES = [
  { id: 'hierro', name: 'Alas de Hierro', tier: 'basico' },
  { id: 'bronce', name: 'Alas de Bronce', tier: 'basico' },
  { id: 'plata', name: 'Alas de Plata', tier: 'basico' },
  { id: 'acero', name: 'Acero Azul', tier: 'especial' },
  { id: 'jade', name: 'Jade Imperial', tier: 'especial' },
  { id: 'cobre', name: 'Cobre Ardiente', tier: 'especial' },
  { id: 'oro', name: 'Corona de Oro', tier: 'legendario' },
  { id: 'zafiro', name: 'Zafiro Real', tier: 'legendario' },
  { id: 'amatista', name: 'Amatista Arcana', tier: 'legendario' },
  { id: 'fenix', name: 'Fénix', tier: 'mitico' },
  { id: 'obsidiana', name: 'Dragón de Obsidiana', tier: 'mitico' },
  { id: 'serafin', name: 'Serafín', tier: 'mitico' },
].map((f) => ({ ...f, price: TIER_BY_ID.get(f.tier).price }));
const FRAME_BY_ID = new Map(FRAMES.map((f) => [f.id, f]));

const SQL = {
  equipped: 'SELECT id, frame FROM users WHERE frame IS NOT NULL',
  owned: 'SELECT item_id FROM user_cosmetics WHERE user_id = ?',
  owns: 'SELECT 1 AS ok FROM user_cosmetics WHERE user_id = ? AND item_id = ?',
  buy: 'INSERT INTO user_cosmetics (user_id, item_id, price, purchased_at) VALUES (?, ?, ?, ?)',
  equip: 'UPDATE users SET frame = ? WHERE id = ?',
};

const events = new EventEmitter();

// userId -> id del borde equipado. Se carga entero al arrancar para que frameOf() sea inmediato
// (la mesa de blackjack y el chat lo llaman en cada mensaje); solo cambia a través de equip().
const equipped = new Map();

async function init() {
  for (const row of await db.query(SQL.equipped)) {
    if (FRAME_BY_ID.has(row.frame)) equipped.set(Number(row.id), row.frame);
  }
}

/** Borde equipado del jugador, o null. */
const frameOf = (userId) => equipped.get(userId) ?? null;

async function ownedBy(userId) {
  return (await db.query(SQL.owned, [userId])).map((r) => r.item_id).filter((id) => FRAME_BY_ID.has(id));
}

function frameOrError(id) {
  const frame = typeof id === 'string' ? FRAME_BY_ID.get(id) : null;
  if (!frame) throw new GameError('Ese borde no existe.');
  return frame;
}

/**
 * Compra un borde: en una transacción se apunta y se cobra; si no alcanza el saldo, no queda
 * nada. La clave primaria de user_cosmetics impide pagarlo dos veces (también desde dos pestañas).
 * Devuelve el nuevo saldo.
 */
async function buy(userId, id) {
  const frame = frameOrError(id);
  try {
    return await db.transaction(async (tx) => {
      await tx.query(SQL.buy, [userId, frame.id, frame.price, Date.now()]);
      const balance = await wallet.debit(userId, frame.price, `cosmetic:${frame.id}`, tx);
      if (balance === null) throw new GameError(`Necesitas ${frame.price.toLocaleString('es')} créditos para comprarlo.`);
      return balance;
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new GameError('Ya tienes ese borde.');
    throw err;
  }
}

/** Equipa un borde que el jugador ya tiene, o lo quita (`id` null). */
async function equip(userId, id) {
  const frame = id === null ? null : frameOrError(id);
  if (frame && !(await db.one(SQL.owns, [userId, frame.id]))) throw new GameError('Primero tienes que comprar ese borde.');
  await db.query(SQL.equip, [frame?.id ?? null, userId]);
  if (frame) equipped.set(userId, frame.id);
  else equipped.delete(userId);
  events.emit('change', userId, frame?.id ?? null);
  return frame?.id ?? null;
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

/** Responde con el mensaje de un GameError (400); cualquier otro error sigue su curso. */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!(err instanceof GameError)) throw err;
    res.status(400).json({ error: err.message });
  }
};

const limit = auth.rateLimit({ windowMs: 60_000, max: 30, message: 'Demasiadas peticiones. Espera un momento.', key: perUser });

router.get(
  '/cosmetics',
  requireUser,
  limit,
  handle(async (req, res) => {
    res.json({ tiers: TIERS, frames: FRAMES, owned: await ownedBy(req.user.id), equipped: frameOf(req.user.id) });
  })
);

router.post(
  '/cosmetics/buy',
  requireUser,
  limit,
  handle(async (req, res) => {
    const balance = await buy(req.user.id, req.body?.id);
    res.json({ balance, owned: await ownedBy(req.user.id) });
  })
);

router.post(
  '/cosmetics/equip',
  requireUser,
  limit,
  handle(async (req, res) => {
    res.json({ equipped: await equip(req.user.id, req.body?.id ?? null) });
  })
);

module.exports = { init, router, events, frameOf, buy, equip, TIERS, FRAMES };
