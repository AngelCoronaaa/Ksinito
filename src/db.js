'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'casino.db');
const db = new DatabaseSync(DB_FILE);
console.log(`[db] Base de datos en ${DB_FILE}`);

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

  -- Solo se conservan los últimos 30 giros (ver roulette.js).
  CREATE TABLE IF NOT EXISTS roulette_spins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    number     INTEGER NOT NULL CHECK (number BETWEEN 0 AND 36),
    created_at INTEGER NOT NULL
  );
`);

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

module.exports = { db, transaction, DATA_DIR };
