'use strict';

// Autenticación con JWT (HS256) guardado en una cookie httpOnly.
// El token no se guarda en la base de datos: el servidor solo necesita el
// secreto para verificarlo, así que las sesiones sobreviven a reinicios y
// redespliegues siempre que JWT_SECRET sea el mismo.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, DATA_DIR } = require('./db');
const wallet = require('./wallet');

const TOKEN_COOKIE = 'ksjwt';
const TOKEN_TTL_S = 7 * 24 * 60 * 60;
const TOKEN_REFRESH_AFTER_S = 24 * 60 * 60; // /api/me renueva el token si tiene más de un día
const ISSUER = 'ksinito';
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

const JWT_SECRET = loadSecret();

const stmts = {
  userByName: db.prepare('SELECT id, username, password_hash, created_at FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username, created_at FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
};

/**
 * Usa JWT_SECRET si está definido. Si no, genera uno y lo guarda junto a la
 * base de datos para que los tokens sigan valiendo tras reiniciar.
 */
function loadSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres');
    return fromEnv;
  }
  const file = path.join(DATA_DIR, 'jwt-secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {
    // no existe todavía
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  console.warn(`[auth] JWT_SECRET no está definido; se generó uno en ${file}. En producción define JWT_SECRET.`);
  return secret;
}

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

function signToken(user) {
  // `ca` (fecha de creación de la cuenta) ata el token a esta cuenta concreta:
  // si la base se reinicia y otro usuario recibe el mismo id, el token deja de valer.
  return jwt.sign({ name: user.username, ca: user.created_at }, JWT_SECRET, {
    algorithm: 'HS256',
    subject: String(user.id),
    issuer: ISSUER,
    expiresIn: TOKEN_TTL_S,
  });
}

/** Devuelve { id, username, iat } si el token es válido y la cuenta existe, o null. */
function verifyToken(token) {
  if (!token) return null;
  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
  } catch {
    return null;
  }
  const user = stmts.userById.get(Number(claims.sub));
  if (!user || user.created_at !== claims.ca) return null;
  return { id: user.id, username: user.username, iat: claims.iat };
}

/** Devuelve { id, username } a partir de la cabecera Cookie, o null. */
function userFromCookieHeader(header) {
  const user = verifyToken(parseCookies(header)[TOKEN_COOKIE]);
  return user && { id: user.id, username: user.username };
}

function setTokenCookie(res, user) {
  res.cookie(TOKEN_COOKIE, signToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: TOKEN_TTL_S * 1000,
    path: '/',
  });
}

/** Al iniciar sesión se entrega el bono (solo la primera vez por cuenta). */
function loginResponse(res, user) {
  setTokenCookie(res, user);
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
    const createdAt = Date.now();
    let id;
    try {
      id = Number(stmts.insertUser.run(username, hash, createdAt).lastInsertRowid);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ese usuario ya existe.' });
      throw err;
    }
    loginResponse(res, { id, username, created_at: createdAt });
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
  res.clearCookie(TOKEN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const user = verifyToken(parseCookies(req.headers.cookie)[TOKEN_COOKIE]);
  if (!user) {
    res.clearCookie(TOKEN_COOKIE, { path: '/' });
    return res.status(401).json({ error: 'No has iniciado sesión.' });
  }
  // Mientras el jugador siga entrando, la sesión no caduca.
  if (Date.now() / 1000 - user.iat > TOKEN_REFRESH_AFTER_S) setTokenCookie(res, stmts.userById.get(user.id));
  res.json({ user: { id: user.id, username: user.username, credits: wallet.getBalance(user.id) } });
});

module.exports = { router, userFromCookieHeader };
