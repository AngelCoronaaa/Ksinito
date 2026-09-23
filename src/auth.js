'use strict';

const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const wallet = require('./wallet');

const SESSION_COOKIE = 'ksid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

const stmts = {
  userByName: db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare(`
    SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const key = part.slice(0, i).trim();
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // cookie mal formada: se ignora
    }
  }
  return out;
}

/** Devuelve { id, username } a partir de la cabecera Cookie, o null. */
function userFromCookieHeader(header) {
  const token = parseCookies(header)[SESSION_COOKIE];
  if (!token) return null;
  return stmts.sessionUser.get(hashToken(token), Date.now()) ?? null;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  stmts.insertSession.run(hashToken(token), userId, Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

/** Al iniciar sesión se entrega el bono (solo la primera vez por cuenta). */
function loginResponse(res, user) {
  startSession(res, user.id);
  const bonusGranted = wallet.grantWelcomeBonus(user.id);
  res.json({
    user: { id: user.id, username: user.username, credits: wallet.getBalance(user.id) },
    bonusGranted,
  });
}

function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(req.ip, entry);
    }
    if (++entry.count > max) return res.status(429).json({ error: message });
    next();
  };
}

function readCredentials(body) {
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  return { username, password };
}

const router = express.Router();

router.post(
  '/register',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'Demasiadas cuentas creadas desde tu red. Inténtalo más tarde.' }),
  async (req, res) => {
    const { username, password } = readCredentials(req.body);
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'El usuario debe tener de 3 a 20 caracteres (letras, números o _).' });
    }
    if (password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 100 caracteres.' });
    }
    if (stmts.userByName.get(username)) return res.status(409).json({ error: 'Ese usuario ya existe.' });

    const hash = await bcrypt.hash(password, 10);
    let id;
    try {
      id = Number(stmts.insertUser.run(username, hash, Date.now()).lastInsertRowid);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ese usuario ya existe.' });
      throw err;
    }
    loginResponse(res, { id, username });
  }
);

router.post(
  '/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Demasiados intentos. Espera unos minutos.' }),
  async (req, res) => {
    const { username, password } = readCredentials(req.body);
    const user = USERNAME_RE.test(username) ? stmts.userByName.get(username) : null;
    // Se compara siempre para no revelar por tiempo si el usuario existe.
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    loginResponse(res, user);
  }
);

router.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) stmts.deleteSession.run(hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const user = userFromCookieHeader(req.headers.cookie);
  if (!user) return res.status(401).json({ error: 'No has iniciado sesión.' });
  res.json({ user: { id: user.id, username: user.username, credits: wallet.getBalance(user.id) } });
});

stmts.purgeSessions.run(Date.now());
setInterval(() => stmts.purgeSessions.run(Date.now()), 60 * 60 * 1000).unref();

module.exports = { router, userFromCookieHeader };
