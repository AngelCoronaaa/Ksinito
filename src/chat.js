'use strict';

// Chat por canal: "roulette" y uno por mesa de blackjack ("bj:1", "bj:2"…).
// Los canales coinciden con las salas de Socket.IO, así que server.js decide
// quién puede escribir en cada uno según las salas del socket.

const { db } = require('./db');
const avatars = require('./avatars');
const { GameError } = require('./errors');

const MAX_LENGTH = 300;
const HISTORY = 50; // mensajes que se envían al entrar a un canal
const KEEP = 200; // mensajes que se guardan por canal
const BURST = 5; // máximo de mensajes…
const BURST_MS = 8_000; // …en esta ventana, por jugador

const stmts = {
  insert: db.prepare('INSERT INTO chat_messages (channel, user_id, text, created_at) VALUES (?, ?, ?, ?)'),
  recent: db.prepare(`
    SELECT m.id, m.channel, m.user_id, m.text, m.created_at, u.username, u.public_id
    FROM chat_messages m JOIN users u ON u.id = m.user_id
    WHERE m.channel = ? ORDER BY m.id DESC LIMIT ?`),
  trim: db.prepare(`
    DELETE FROM chat_messages WHERE channel = ? AND id <= (
      SELECT id FROM chat_messages WHERE channel = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`),
};

const recentByUser = new Map(); // userId -> marcas de tiempo de sus últimos mensajes

const toMessage = (row) => ({
  id: row.id,
  channel: row.channel,
  userId: row.user_id,
  publicId: row.public_id,
  username: row.username,
  avatar: avatars.avatarUrl(row.user_id),
  text: row.text,
  at: row.created_at,
});

function history(channel) {
  return stmts.recent.all(channel, HISTORY).reverse().map(toMessage);
}

/** Guarda un mensaje y lo devuelve listo para enviar a la sala. */
function post(user, channel, text) {
  if (typeof text !== 'string') throw new GameError('Mensaje vacío');
  // Sin caracteres de control ni saltos de línea; el cliente lo pinta como texto plano.
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) throw new GameError('Mensaje vacío');
  if (clean.length > MAX_LENGTH) throw new GameError(`El mensaje es demasiado largo (máx. ${MAX_LENGTH} caracteres)`);

  const now = Date.now();
  const times = (recentByUser.get(user.id) ?? []).filter((t) => now - t < BURST_MS);
  if (times.length >= BURST) throw new GameError('Vas demasiado rápido, espera un momento');
  times.push(now);
  recentByUser.set(user.id, times);

  const id = Number(stmts.insert.run(channel, user.id, clean, now).lastInsertRowid);
  if (id % 20 === 0) stmts.trim.run(channel, channel, KEEP);
  return toMessage({ id, channel, user_id: user.id, text: clean, created_at: now, username: user.username, public_id: user.publicId });
}

// Limpia la memoria de jugadores que ya no escriben.
setInterval(() => {
  const now = Date.now();
  for (const [userId, times] of recentByUser) if (times.every((t) => now - t >= BURST_MS)) recentByUser.delete(userId);
}, 60_000).unref();

module.exports = { history, post, MAX_LENGTH };
