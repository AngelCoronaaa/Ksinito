'use strict';

// Fotos de perfil. El cliente ya las recorta a 256×256, pero el servidor no se
// fía: comprueba por los bytes que sea JPEG, PNG o WebP y lee sus dimensiones
// para rechazar imágenes enormes que colgarían el navegador de otros jugadores.

const { EventEmitter } = require('node:events');
const { db } = require('./db');
const { GameError } = require('./errors');

const MAX_BYTES = 300 * 1024;
const MAX_SIDE = 1024;
const MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const events = new EventEmitter();

const stmts = {
  version: db.prepare('SELECT updated_at FROM avatars WHERE user_id = ?'),
  get: db.prepare('SELECT mime, data FROM avatars WHERE user_id = ?'),
  upsert: db.prepare(`
    INSERT INTO avatars (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`),
  remove: db.prepare('DELETE FROM avatars WHERE user_id = ?'),
};

// userId -> updated_at (o null si no tiene foto). Evita consultar la base en cada broadcast.
const versions = new Map();

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    // SOF0..SOF15 salvo DHT (C4), JPG (C8) y DAC (CC) llevan el tamaño.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function webpSize(buf) {
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === 'VP8X' && buf.length >= 30) {
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

/** Devuelve { mime, width, height } según el contenido real del archivo, o null. */
function imageInfo(buf) {
  if (buf.length < 30) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const size = jpegSize(buf);
    return size && { mime: 'image/jpeg', ...size };
  }
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const size = webpSize(buf);
    return size && { mime: 'image/webp', ...size };
  }
  return null;
}

/** URL pública de la foto (con versión para poder cachearla), o null. */
function avatarUrl(userId) {
  if (!versions.has(userId)) versions.set(userId, stmts.version.get(userId)?.updated_at ?? null);
  const version = versions.get(userId);
  return version === null ? null : `/api/avatar/${userId}?v=${version}`;
}

function getAvatar(userId) {
  return stmts.get.get(userId) ?? null;
}

function saveAvatar(userId, buf) {
  const info = imageInfo(buf);
  if (!info) throw new GameError('Formato no válido: usa una imagen JPG, PNG o WebP.');
  if (!info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE) {
    throw new GameError(`La imagen es demasiado grande (máx. ${MAX_SIDE}×${MAX_SIDE} px).`);
  }
  // La versión cambia siempre, aunque se suban dos fotos en el mismo milisegundo.
  const version = Math.max(Date.now(), (versions.get(userId) ?? 0) + 1);
  stmts.upsert.run(userId, info.mime, buf, version);
  versions.set(userId, version);
  const url = avatarUrl(userId);
  events.emit('change', userId, url);
  return url;
}

function removeAvatar(userId) {
  stmts.remove.run(userId);
  versions.set(userId, null);
  events.emit('change', userId, null);
}

module.exports = { events, avatarUrl, getAvatar, saveAvatar, removeAvatar, imageInfo, MAX_BYTES, MIME_TYPES };
