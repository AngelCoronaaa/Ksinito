'use strict';

// Autenticación con JWT (HS256) guardado en una cookie httpOnly.
// El token no se guarda en la base de datos: el servidor solo necesita el
// secreto para verificarlo, así que las sesiones sobreviven a reinicios y
// redespliegues siempre que el secreto sea el mismo.

const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query, one, withPublicId } = require('./db');
const wallet = require('./wallet');
const avatars = require('./avatars');

const TOKEN_COOKIE = 'ksjwt';
const TOKEN_TTL_S = 7 * 24 * 60 * 60;
const TOKEN_REFRESH_AFTER_S = 24 * 60 * 60; // /api/me renueva el token si tiene más de un día
const ISSUER = 'ksinito';
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

let JWT_SECRET = null;

const SQL = {
  userByName: 'SELECT id, public_id, username, password_hash, created_at FROM users WHERE username = ?',
  userById: 'SELECT id, public_id, username, created_at FROM users WHERE id = ?',
  insertUser: 'INSERT INTO users (username, password_hash, public_id, created_at) VALUES (?, ?, ?, ?)',
};

/**
 * Usa JWT_SECRET si está definido. Si no, genera uno y lo guarda en la tabla
 * `settings` para que las sesiones sigan valiendo tras reiniciar o redesplegar.
 */
async function init() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres');
    JWT_SECRET = fromEnv;
    return;
  }
  // INSERT IGNORE: si dos instancias arrancan a la vez, ambas acaban leyendo el mismo.
  await query("INSERT IGNORE INTO settings (name, value) VALUES ('jwt_secret', ?)", [crypto.randomBytes(48).toString('base64url')]);
  JWT_SECRET = (await one("SELECT value FROM settings WHERE name = 'jwt_secret'")).value;
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
  return jwt.sign({ name: user.username, ca: Number(user.created_at) }, JWT_SECRET, {
    algorithm: 'HS256',
    subject: String(user.id),
    issuer: ISSUER,
    expiresIn: TOKEN_TTL_S,
  });
}

/** Devuelve la cuenta ({ id, publicId, username, created_at, iat }) si el token es válido, o null. */
async function verifyToken(token) {
  if (!token) return null;
  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
  } catch {
    return null;
  }
  const user = await one(SQL.userById, [Number(claims.sub)]);
  if (!user || Number(user.created_at) !== claims.ca) return null;
  return { id: Number(user.id), publicId: user.public_id, username: user.username, created_at: Number(user.created_at), iat: claims.iat };
}

/** Devuelve { id, publicId, username } a partir de la cabecera Cookie, o null. */
async function userFromCookieHeader(header) {
  const user = await verifyToken(parseCookies(header)[TOKEN_COOKIE]);
  return user && { id: user.id, publicId: user.publicId, username: user.username };
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

async function publicUser(user) {
  const id = Number(user.id);
  return {
    id,
    publicId: user.publicId ?? user.public_id,
    username: user.username,
    credits: await wallet.getBalance(id),
    avatar: avatars.avatarUrl(id),
  };
}

/** Al iniciar sesión se entrega el bono (solo la primera vez por cuenta). */
async function loginResponse(res, user) {
  setTokenCookie(res, user);
  const bonusGranted = await wallet.grantWelcomeBonus(Number(user.id));
  res.json({
    user: await publicUser(user),
    bonusGranted,
  });
}

/** Limita peticiones por IP, o por lo que devuelva `key` (p. ej. el usuario). */
function rateLimit({ windowMs, max, message, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const id = key(req);
    let entry = hits.get(id);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(id, entry);
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
  async (req, res) => {
    const { username, password } = readCredentials(req.body);
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'El usuario debe tener de 3 a 20 caracteres (letras, números o _).' });
    }
    if (password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 100 caracteres.' });
    }
    if (await one(SQL.userByName, [username])) return res.status(409).json({ error: 'Ese usuario ya existe.' });

    const hash = await bcrypt.hash(password, 10);
    const createdAt = Date.now();
    let user;
    try {
      user = await withPublicId(async (publicId) => ({
        id: Number((await query(SQL.insertUser, [username, hash, publicId, createdAt])).insertId),
        public_id: publicId,
        username,
        created_at: createdAt,
      }));
    } catch (err) {
      // Dos registros simultáneos con el mismo nombre: el índice único rechaza el segundo.
      if (err.code === 'ER_DUP_ENTRY' && String(err.message).includes('username')) {
        return res.status(409).json({ error: 'Ese usuario ya existe.' });
      }
      throw err;
    }
    await loginResponse(res, user);
  }
);

router.post(
  '/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Demasiados intentos. Espera unos minutos.' }),
  async (req, res) => {
    const { username, password } = readCredentials(req.body);
    const user = USERNAME_RE.test(username) ? await one(SQL.userByName, [username]) : null;
    // Se compara siempre para no revelar por tiempo si el usuario existe.
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    await loginResponse(res, user);
  }
);

router.post('/logout', (req, res) => {
  res.clearCookie(TOKEN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const user = await verifyToken(parseCookies(req.headers.cookie)[TOKEN_COOKIE]);
  if (!user) {
    res.clearCookie(TOKEN_COOKIE, { path: '/' });
    return res.status(401).json({ error: 'No has iniciado sesión.' });
  }
  // Mientras el jugador siga entrando, la sesión no caduca.
  if (Date.now() / 1000 - user.iat > TOKEN_REFRESH_AFTER_S) setTokenCookie(res, user);
  res.json({ user: await publicUser(user) });
});

module.exports = { init, router, userFromCookieHeader, rateLimit };
