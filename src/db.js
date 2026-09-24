'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// En un contenedor (Docker, Coolify, Dokploy…) todo lo que no esté en un volumen
// se borra al redesplegar, incluida la base de datos con las cuentas.
const IN_CONTAINER = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');

function mountPoints() {
  try {
    return fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map((line) => line.split(' ')[4]).filter(Boolean);
  } catch {
    return [];
  }
}

function onVolume(dir) {
  const real = fs.realpathSync(dir);
  return mountPoints().some((m) => m !== '/' && (real === m || real.startsWith(`${m}/`)));
}

// Si hay un volumen montado en /data se usa aunque no se haya definido DATA_DIR.
const DATA_DIR =
  process.env.DATA_DIR ||
  (IN_CONTAINER && mountPoints().includes('/data') ? '/data' : path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

/** 'persistent' (volumen), 'ephemeral' (se borra al redesplegar) o 'local' (fuera de contenedores). */
const STORAGE = !IN_CONTAINER ? 'local' : onVolume(DATA_DIR) ? 'persistent' : 'ephemeral';

const DB_FILE = path.join(DATA_DIR, 'casino.db');
const db = new DatabaseSync(DB_FILE);
console.log(`[db] Base de datos en ${DB_FILE} (almacenamiento: ${STORAGE})`);
if (STORAGE === 'ephemeral') {
  console.warn(`[db] ⚠ ATENCIÓN: ${DATA_DIR} no está en un volumen persistente.`);
  console.warn('[db] ⚠ Las cuentas, créditos y fotos se BORRARÁN en el próximo deploy.');
  console.warn('[db] ⚠ Añade un volumen con destino /data en Coolify/Dokploy (ver README → Despliegue).');
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    username              TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash         TEXT    NOT NULL,
    credits               INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
    welcome_bonus_granted INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL
  );

  -- Las sesiones ahora son JWT (ver auth.js); esta tabla ya no se usa.
  DROP TABLE IF EXISTS sessions;

  -- Registro de cada movimiento de créditos (auditoría).
  CREATE TABLE IF NOT EXISTS ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta         INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason        TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id);

  -- Fotos de perfil (ver avatars.js). Viven en la misma base que las cuentas.
  CREATE TABLE IF NOT EXISTS avatars (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mime       TEXT    NOT NULL,
    data       BLOB    NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Solo se conservan los últimos 30 giros (ver roulette.js).
  CREATE TABLE IF NOT EXISTS roulette_spins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    number     INTEGER NOT NULL CHECK (number BETWEEN 0 AND 36),
    created_at INTEGER NOT NULL
  );

  -- Chat de la ruleta y de cada mesa de blackjack (ver chat.js).
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel    TEXT    NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_channel ON chat_messages(channel, id);

  -- Envíos de créditos entre jugadores (ver wallet.transfer).
  CREATE TABLE IF NOT EXISTS transfers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount     INTEGER NOT NULL CHECK (amount > 0),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS transfers_from ON transfers(from_user, id);
  CREATE INDEX IF NOT EXISTS transfers_to ON transfers(to_user, id);
`);

// ---------- ID público de cada jugador ----------
// Número de 8 cifras, aleatorio para que no se pueda adivinar ni equivocarse con
// el de otro jugador por una cifra (como pasaría con 1, 2, 3…).

const newPublicId = () => String(crypto.randomInt(10_000_000, 100_000_000));

if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'public_id')) {
  db.exec('ALTER TABLE users ADD COLUMN public_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_public_id ON users(public_id)');

/** Ejecuta insert(publicId) con IDs nuevos hasta que no choque con uno existente. */
function withPublicId(insert) {
  for (let attempt = 0; ; attempt++) {
    const publicId = newPublicId();
    try {
      return insert(publicId);
    } catch (err) {
      if (attempt < 10 && String(err.message).includes('users.public_id')) continue;
      throw err;
    }
  }
}

// Las cuentas creadas antes de existir el ID reciben uno ahora.
const setPublicId = db.prepare('UPDATE users SET public_id = ? WHERE id = ?');
for (const { id } of db.prepare('SELECT id FROM users WHERE public_id IS NULL').all()) {
  withPublicId((publicId) => setPublicId.run(publicId, id));
}

/** Ejecuta fn dentro de una transacción; hace ROLLBACK si lanza. */
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, transaction, withPublicId, DATA_DIR, STORAGE };
