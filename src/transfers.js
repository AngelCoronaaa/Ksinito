'use strict';

// Envío de créditos entre jugadores usando su ID público de 8 cifras.

const { EventEmitter } = require('node:events');
const express = require('express');
const auth = require('./auth');
const avatars = require('./avatars');
const wallet = require('./wallet');
const { query, one } = require('./db');

const MAX_TRANSFER = 1_000_000;
const PUBLIC_ID_RE = /^\d{8}$/;

const events = new EventEmitter();

const SQL = {
  byPublicId: 'SELECT id, public_id, username FROM users WHERE public_id = ?',
  history: `
    SELECT t.id, t.amount, t.created_at, t.from_user,
           f.username AS from_name, f.public_id AS from_public_id,
           r.username AS to_name, r.public_id AS to_public_id
    FROM transfers t
    JOIN users f ON f.id = t.from_user
    JOIN users r ON r.id = t.to_user
    WHERE t.from_user = ? OR t.to_user = ?
    ORDER BY t.id DESC LIMIT 15`,
};

const router = express.Router();
const perUser = (req) => `user:${req.user.id}`;

async function requireUser(req, res, next) {
  const user = await auth.userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'No has iniciado sesión.' });
  req.user = user;
  next();
}

async function findRecipient(publicId) {
  if (typeof publicId !== 'string' || !PUBLIC_ID_RE.test(publicId)) return null;
  const user = await one(SQL.byPublicId, [publicId]);
  return user && { ...user, id: Number(user.id) };
}

// Para mostrar a quién le vas a enviar antes de confirmar.
router.get(
  '/users/:publicId',
  requireUser,
  auth.rateLimit({ windowMs: 60 * 1000, max: 60, message: 'Demasiadas búsquedas. Espera un momento.', key: perUser }),
  async (req, res) => {
    const user = await findRecipient(req.params.publicId);
    if (!user) return res.status(404).json({ error: 'No existe ningún jugador con ese ID.' });
    res.json({ user: { publicId: user.public_id, username: user.username, avatar: avatars.avatarUrl(user.id) } });
  }
);

router.post(
  '/transfer',
  requireUser,
  auth.rateLimit({ windowMs: 10 * 60 * 1000, max: 20, message: 'Has hecho demasiados envíos. Espera unos minutos.', key: perUser }),
  async (req, res) => {
    const { to, amount } = req.body ?? {};
    const recipient = await findRecipient(to);
    if (!recipient) return res.status(404).json({ error: 'No existe ningún jugador con ese ID.' });
    if (recipient.id === req.user.id) return res.status(400).json({ error: 'No puedes enviarte créditos a ti mismo.' });
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_TRANSFER) {
      return res.status(400).json({ error: `La cantidad debe ser un número entero entre 1 y ${MAX_TRANSFER.toLocaleString('es')}.` });
    }
    const balance = await wallet.transfer(req.user.id, recipient.id, amount);
    if (balance === null) return res.status(400).json({ error: 'No tienes créditos suficientes.' });

    events.emit('sent', {
      toUserId: recipient.id,
      amount,
      from: { publicId: req.user.publicId, username: req.user.username, avatar: avatars.avatarUrl(req.user.id) },
    });
    res.json({ balance, to: { publicId: recipient.public_id, username: recipient.username } });
  }
);

router.get('/transfers', requireUser, async (req, res) => {
  const rows = await query(SQL.history, [req.user.id, req.user.id]);
  res.json({
    transfers: rows.map((t) => {
      const sent = Number(t.from_user) === req.user.id;
      return {
        id: Number(t.id),
        direction: sent ? 'out' : 'in',
        amount: Number(t.amount),
        at: Number(t.created_at),
        other: sent ? { username: t.to_name, publicId: t.to_public_id } : { username: t.from_name, publicId: t.from_public_id },
      };
    }),
  });
});

module.exports = { router, events, MAX_TRANSFER };
