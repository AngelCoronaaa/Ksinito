'use strict';

// Anuncios con recompensa: el jugador ve un anuncio propio (archivos en public/spots/,
// catálogo en src/ads.config.json) y recibe créditos al terminar.
//
// El servidor es la única autoridad. /start crea un registro con un token aleatorio y
// `ready_at = NOW() + duración`; /claim solo paga si el token es de ese jugador, no se ha
// cobrado y NOW() está entre `ready_at` y `expires_at`. Lo que diga el cliente sobre el tiempo
// no cuenta: todas las fechas se comparan con NOW() de MySQL. Cada token se cobra una sola vez
// gracias a un UPDATE condicional, y los créditos los suma wallet.js en la misma transacción.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const wallet = require('./wallet');
const { one, transaction } = require('./db');
const { GameError } = require('./errors');

/** Entero de una variable de entorno; si no es válido se usa `fallback` y se avisa. */
function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
  console.warn(`[ads] ${name}=${raw} no es válido (entero entre ${min} y ${max}); se usa ${fallback}`);
  return fallback;
}

const ADS_ENABLED = intEnv('ADS_ENABLED', 1, { max: 1 }) === 1;
const AD_REWARD = intEnv('AD_REWARD', 100, { min: 1 });
const AD_DURATION_SECONDS = intEnv('AD_DURATION_SECONDS', 30, { max: 3600 });
const AD_COOLDOWN_SECONDS = intEnv('AD_COOLDOWN_SECONDS', 300, { max: 7 * 86400 });
const AD_DAILY_LIMIT = intEnv('AD_DAILY_LIMIT', 10); // 0 = ninguno
const AD_CLAIM_WINDOW_SECONDS = intEnv('AD_CLAIM_WINDOW_SECONDS', 300, { max: 86400 });

const TOKEN_RE = /^[0-9a-f]{32}$/;

const events = new EventEmitter();

/** Error con código HTTP; su mensaje se puede mostrar al jugador. */
class AdError extends GameError {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------- catálogo ----------

const CATALOG_FILE = path.join(__dirname, 'ads.config.json');
// Los archivos van en public/spots/ y no en public/ads/: los bloqueadores de anuncios
// (EasyList, uBlock…) bloquean rutas /ads/ en algunos dominios.
const ADS_DIR = path.join(__dirname, '..', 'public', 'spots');
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/; // cabe en ad_rewards.ad_id
const SRC_RE = /^\/spots\/[A-Za-z0-9][A-Za-z0-9._-]*$/; // un archivo directamente en public/spots/
const EXTENSIONS = { video: ['.mp4', '.webm'], image: ['.webp', '.jpg', '.jpeg'] };

/** Motivo por el que una entrada del catálogo no vale, o null si es correcta. */
function invalidReason(ad, ids) {
  if (!ad || typeof ad !== 'object' || Array.isArray(ad)) return 'no es un objeto';
  if (typeof ad.id !== 'string' || !ID_RE.test(ad.id)) return '`id` debe tener de 1 a 64 letras, números, ".", "_" o "-"';
  if (ids.has(ad.id)) return `el id "${ad.id}" está repetido`;
  if (!Object.hasOwn(EXTENSIONS, ad.type)) return '`type` debe ser "video" o "image"';
  if (typeof ad.src !== 'string' || !SRC_RE.test(ad.src)) return '`src` debe ser un archivo de /spots/ (p. ej. "/spots/mi-anuncio.mp4")';
  if (!EXTENSIONS[ad.type].includes(path.extname(ad.src).toLowerCase())) {
    return `un anuncio de tipo ${ad.type} debe ser ${EXTENSIONS[ad.type].join(', ')}`;
  }
  if (!fs.existsSync(path.join(ADS_DIR, ad.src.slice('/spots/'.length)))) return `no existe public${ad.src}`;
  if (typeof ad.title !== 'string' || !ad.title.trim() || ad.title.length > 120) return '`title` debe tener de 1 a 120 caracteres';
  if (ad.link !== undefined && ad.link !== null) {
    let url = null;
    try {
      url = typeof ad.link === 'string' && ad.link.length <= 2048 ? new URL(ad.link) : null;
    } catch {
      // se trata abajo
    }
    if (url?.protocol !== 'https:') return '`link` debe ser una URL https://';
  }
  if (ad.active !== undefined && typeof ad.active !== 'boolean') return '`active` debe ser true o false';
  if (ad.weight !== undefined && !(Number.isSafeInteger(ad.weight) && ad.weight >= 1 && ad.weight <= 1000)) {
    return '`weight` debe ser un entero entre 1 y 1000';
  }
  return null;
}

/** Lee y valida src/ads.config.json. Las entradas inválidas se descartan con un aviso. */
function loadCatalog() {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  } catch (err) {
    console.warn(`[ads] No se pudo leer src/ads.config.json (${err.code ?? err.message}); no hay anuncios`);
    return [];
  }
  if (!Array.isArray(list)) {
    console.warn('[ads] src/ads.config.json debe ser una lista; no hay anuncios');
    return [];
  }
  const ads = [];
  const ids = new Set();
  list.forEach((ad, i) => {
    const problem = invalidReason(ad, ids);
    if (problem) return console.warn(`[ads] Anuncio ${i + 1}${typeof ad?.id === 'string' ? ` (${ad.id})` : ''} descartado: ${problem}`);
    ids.add(ad.id);
    ads.push(
      Object.freeze({
        id: ad.id,
        type: ad.type,
        src: ad.src,
        title: ad.title.trim(),
        link: ad.link ?? null,
        active: ad.active !== false,
        weight: ad.weight ?? 1,
      })
    );
  });
  return ads;
}

const catalog = loadCatalog();
const activeAds = catalog.filter((ad) => ad.active);
if (ADS_ENABLED) console.log(`[ads] ${activeAds.length} anuncio(s) activo(s)`);

// ---------- proveedor ----------
// Todo lo que depende de dónde salen los anuncios está en estas dos funciones. Para usar un
// proveedor externo basta con cambiarlas; startAd y claimAd no saben de dónde vienen.

/**
 * Elige el anuncio que verá el jugador (al azar según `weight`), o null si no hay ninguno.
 * Recibe `userId` (aquí no se usa) por si un proveedor futuro segmenta por jugador.
 */
async function pickAd(userId) {
  const total = activeAds.reduce((sum, ad) => sum + ad.weight, 0);
  if (total === 0) return null;
  let n = crypto.randomInt(total);
  for (const ad of activeAds) {
    n -= ad.weight;
    if (n < 0) return ad;
  }
  return null;
}

/** Datos de un anuncio ya asignado (para retomar uno pendiente), aunque se haya desactivado. */
async function describeAd(adId) {
  return catalog.find((ad) => ad.id === adId) ?? null;
}

const hasAds = () => activeAds.length > 0;
const publicAd = ({ id, type, src, title, link }) => ({ id, type, src, title, link });

// ---------- recompensa ----------

const SQL = {
  lockUser: 'SELECT id FROM users WHERE id = ? FOR UPDATE',
  pending: `
    SELECT token, ad_id, reward, GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), ready_at)) AS wait
    FROM ad_rewards
    WHERE user_id = ? AND claimed_at IS NULL AND NOW() <= expires_at
    ORDER BY id DESC LIMIT 1`,
  limits: `
    SELECT
      (SELECT COUNT(*) FROM ad_rewards WHERE user_id = ? AND claimed_at IS NULL AND NOW() <= expires_at) AS pending,
      (SELECT TIMESTAMPDIFF(SECOND, MAX(created_at), NOW()) FROM ad_rewards WHERE user_id = ?) AS since_last,
      (SELECT COUNT(*) FROM ad_rewards WHERE user_id = ? AND claimed_at > NOW() - INTERVAL 1 DAY) AS claimed_today`,
  insert: `
    INSERT INTO ad_rewards (user_id, ad_id, token, reward, created_at, ready_at, expires_at)
    VALUES (?, ?, ?, ?, NOW(), NOW() + INTERVAL ? SECOND, NOW() + INTERVAL ? SECOND)`,
  claim: `
    UPDATE ad_rewards
    SET claimed_at = NOW()
    WHERE token = ? AND user_id = ? AND claimed_at IS NULL
      AND NOW() >= ready_at AND NOW() <= expires_at`,
  byToken: `
    SELECT id, user_id, reward, claimed_at IS NOT NULL AS claimed,
           TIMESTAMPDIFF(SECOND, NOW(), ready_at) AS wait, NOW() > expires_at AS expired
    FROM ad_rewards WHERE token = ?`,
};

/** Anuncio pendiente, espera por cooldown y anuncios que quedan hoy. `q` es db o una transacción. */
async function readLimits(q, userId) {
  const row = await q.one(SQL.limits, [userId, userId, userId]);
  return {
    pending: Number(row.pending) > 0,
    cooldownSeconds: row.since_last === null ? 0 : Math.max(0, AD_COOLDOWN_SECONDS - Number(row.since_last)),
    remainingToday: Math.max(0, AD_DAILY_LIMIT - Number(row.claimed_today)),
  };
}

/**
 * Empieza un anuncio. Si el jugador ya tiene uno sin cobrar y sin caducar, devuelve ese
 * (recargar la página no crea tokens nuevos). Devuelve { token, duration, reward, ad },
 * con `duration` = segundos que faltan para poder cobrarlo.
 */
async function startAd(userId) {
  // Se elige fuera de la transacción: un proveedor externo podría tardar.
  const candidate = await pickAd(userId);

  // Bloquear la fila del jugador hace que dos /start suyos a la vez se atiendan de uno en uno.
  return transaction(async (tx) => {
    if (!(await tx.one(SQL.lockUser, [userId]))) throw new Error(`No existe el usuario ${userId}`);

    const pending = await tx.one(SQL.pending, [userId]);
    if (pending) {
      const ad = (await describeAd(pending.ad_id)) ?? candidate;
      if (!ad) throw new AdError(503, 'Ahora mismo no hay anuncios disponibles.');
      return { token: pending.token, duration: Number(pending.wait), reward: Number(pending.reward), ad: publicAd(ad) };
    }

    if (!candidate) throw new AdError(503, 'Ahora mismo no hay anuncios disponibles.');
    const { cooldownSeconds, remainingToday } = await readLimits(tx, userId);
    if (cooldownSeconds > 0) {
      throw new AdError(429, 'Espera un poco antes de ver otro anuncio.', { retryAfter: cooldownSeconds });
    }
    if (remainingToday === 0) {
      throw new AdError(429, 'Ya viste todos los anuncios de hoy. Vuelve mañana.', { dailyLimit: true });
    }

    const token = crypto.randomBytes(16).toString('hex');
    await tx.query(SQL.insert, [
      userId, candidate.id, token, AD_REWARD, AD_DURATION_SECONDS, AD_DURATION_SECONDS + AD_CLAIM_WINDOW_SECONDS,
    ]);
    return { token, duration: AD_DURATION_SECONDS, reward: AD_REWARD, ad: publicAd(candidate) };
  });
}

/** Por qué no se pudo cobrar un token (el UPDATE condicional no cambió nada). */
function claimError(row, userId) {
  // Un token de otro jugador se trata como inexistente: no se revela que existe.
  if (!row || Number(row.user_id) !== userId) return new AdError(404, 'Ese anuncio no existe.');
  if (Number(row.claimed)) return new AdError(409, 'Ya cobraste este anuncio.');
  if (Number(row.wait) > 0) {
    const wait = Number(row.wait);
    return new AdError(425, `Aún faltan ${wait} s para terminar el anuncio.`, { retryAfter: wait });
  }
  if (Number(row.expired)) return new AdError(410, 'El anuncio caducó. Empieza otro.');
  return new AdError(409, 'No se pudo cobrar el anuncio. Inténtalo de nuevo.');
}

/** Cobra un anuncio terminado. Devuelve { reward, balance }. */
async function claimAd(userId, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new AdError(400, 'Token de anuncio no válido.');

  const run = () =>
    transaction(async (tx) => {
      // Solo una petición puede cambiar claimed_at de NULL a NOW(): las demás esperan al
      // bloqueo de la fila y, al repetirse la condición, ya no la cumplen.
      const { affectedRows } = await tx.query(SQL.claim, [token, userId]);
      const row = await tx.one(SQL.byToken, [token]);
      if (affectedRows !== 1) throw claimError(row, userId);
      const reward = Number(row.reward);
      const balance = await wallet.credit(userId, reward, `ad_reward:${row.id}`, tx);
      if (balance === null) throw new Error(`No existe el usuario ${userId}`);
      return { reward, balance };
    });

  let result;
  try {
    result = await run();
  } catch (err) {
    // MySQL puede abortar una transacción por bloqueo mutuo; se reintenta una vez.
    if (err.code !== 'ER_LOCK_DEADLOCK') throw err;
    result = await run();
  }
  events.emit('claimed', { userId, reward: result.reward });
  return result;
}

/** Lo que necesita el cliente para pintar el botón. */
async function getAdStatus(userId) {
  const status = { enabled: hasAds(), reward: AD_REWARD, available: false, cooldownSeconds: 0, remainingToday: 0 };
  if (!status.enabled) return status;
  const { pending, cooldownSeconds, remainingToday } = await readLimits({ one }, userId);
  // Con un anuncio pendiente, el botón lo retoma: no hay que esperar.
  status.cooldownSeconds = pending ? 0 : cooldownSeconds;
  status.remainingToday = remainingToday;
  status.available = pending || (cooldownSeconds === 0 && remainingToday > 0);
  return status;
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

/** Responde con el resultado de fn(req), o con el código y mensaje de un AdError. */
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (!(err instanceof AdError)) throw err;
    if (err.extra.retryAfter) res.set('Retry-After', String(err.extra.retryAfter));
    res.status(err.status).json({ error: err.message, ...err.extra });
  }
};

// Con ADS_ENABLED=0 las rutas no existen.
router.use('/ads', (req, res, next) => (ADS_ENABLED ? next() : res.status(404).json({ error: 'No encontrado.' })));
router.use(
  '/ads',
  requireUser,
  auth.rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Demasiadas peticiones. Espera un momento.', key: perUser })
);
router.get('/ads/status', handle((req) => getAdStatus(req.user.id)));
router.post('/ads/start', handle((req) => startAd(req.user.id)));
router.post('/ads/claim', handle((req) => claimAd(req.user.id, req.body?.token)));

module.exports = { router, events, startAd, claimAd, getAdStatus, pickAd, AdError, ADS_ENABLED, AD_REWARD };
