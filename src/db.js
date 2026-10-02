'use strict';

// Conexión a MySQL. Se configura con DATABASE_URL (mysql://usuario:clave@host:3306/base)
// o con MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD y MYSQL_DATABASE.
// DATABASE_SSL=1 activa TLS, que exigen los MySQL gestionados (TiDB Cloud, PlanetScale, Aiven…).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'schema.sql');
const CONNECT_ATTEMPTS = 30; // al arrancar, espera a que MySQL esté listo (~1 min)

let pool = null;

function connectionOptions() {
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
  const target = url
    ? { uri: url }
    : {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD ?? '',
        database: process.env.MYSQL_DATABASE || 'ksinito',
      };
  const ssl = /^(1|true|required)$/i.test(process.env.DATABASE_SSL ?? '')
    ? { minVersion: 'TLSv1.2', rejectUnauthorized: true }
    : undefined;
  return {
    ...target,
    ssl,
    charset: 'utf8mb4',
    connectionLimit: Number(process.env.DATABASE_POOL_SIZE) || 10,
    waitForConnections: true,
    supportBigNumbers: true, // BIGINT como número mientras quepa sin perder precisión
    enableKeepAlive: true,
  };
}

/** Descripción de la conexión para los logs, sin la contraseña. */
function describe() {
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (url) {
    try {
      const u = new URL(url);
      return `${u.hostname}:${u.port || 3306}${u.pathname}`;
    } catch {
      return 'DATABASE_URL';
    }
  }
  return `${process.env.MYSQL_HOST || '127.0.0.1'}:${process.env.MYSQL_PORT || 3306}/${process.env.MYSQL_DATABASE || 'ksinito'}`;
}

/** Sentencias de db/schema.sql, una a una (sin multipleStatements, que abre la puerta a inyecciones). */
function schemaStatements() {
  return fs
    .readFileSync(SCHEMA_FILE, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((sql) => sql.trim())
    .filter(Boolean);
}

const columnExists = async (table, column) =>
  !!(await one('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]));
const indexExists = async (table, index) =>
  !!(await one('SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [table, index]));

/**
 * Cambios a tablas que ya existían (schema.sql solo crea las que faltan). Cada paso
 * comprueba si ya está hecho, así que se pueden ejecutar en cada arranque.
 */
const MIGRATIONS = [
  async function usersWagered() {
    if (await columnExists('users', 'wagered')) return;
    await query('ALTER TABLE users ADD COLUMN wagered BIGINT NOT NULL DEFAULT 0 AFTER credits');
    // Lo apostado hasta ahora sale del registro de movimientos: apuestas menos reembolsos.
    await query(`
      UPDATE users u JOIN (
        SELECT user_id, SUM(-delta) AS w FROM ledger
        WHERE reason LIKE 'roulette:bet:%'
           OR reason IN ('blackjack:bet', 'blackjack:double', 'blackjack:split', 'roulette:refund', 'blackjack:refund')
        GROUP BY user_id
      ) l ON l.user_id = u.id
      SET u.wagered = GREATEST(l.w, 0)`);
    console.log('[db] Migración: users.wagered creada y calculada a partir del registro de apuestas');
  },
  async function usersCreditsIndex() {
    if (!(await indexExists('users', 'users_credits'))) await query('ALTER TABLE users ADD INDEX users_credits (credits)');
  },
];

/** Conecta (reintentando mientras MySQL arranca) y crea las tablas que falten. */
async function init() {
  pool = mysql.createPool(connectionOptions());
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= CONNECT_ATTEMPTS) throw new Error(`No se pudo conectar a MySQL en ${describe()}: ${err.message}`);
      console.warn(`[db] MySQL en ${describe()} no responde (${err.code ?? err.message}); reintento ${attempt}/${CONNECT_ATTEMPTS}…`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  for (const sql of schemaStatements()) await pool.query(sql);
  for (const migrate of MIGRATIONS) await migrate();
  console.log(`[db] Conectado a MySQL en ${describe()}`);
}

function requirePool() {
  if (!pool) throw new Error('La base de datos no está inicializada (falta db.init())');
  return pool;
}

/** Ejecuta una consulta. Devuelve las filas (SELECT) o el resultado (INSERT/UPDATE: affectedRows, insertId). */
async function query(sql, params = []) {
  const [result] = await requirePool().query(sql, params);
  return result;
}

/** Primera fila de un SELECT, o null. */
async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/**
 * Ejecuta fn(tx) dentro de una transacción; hace ROLLBACK si lanza.
 * `tx` tiene los mismos query/one pero sobre la conexión de la transacción, y
 * `tx.onCommit(cb)` para avisar de algo solo si la transacción llega a confirmarse.
 */
async function transaction(fn) {
  const conn = await requirePool().getConnection();
  const committed = [];
  const tx = {
    query: async (sql, params = []) => (await conn.query(sql, params))[0],
    one: async (sql, params = []) => (await conn.query(sql, params))[0][0] ?? null,
    onCommit: (cb) => committed.push(cb),
  };
  try {
    await conn.beginTransaction();
    const result = await fn(tx);
    await conn.commit();
    for (const cb of committed) {
      try {
        cb();
      } catch (err) {
        console.error('[db] Tras confirmar la transacción', err); // ya está guardada: no se deshace
      }
    }
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/** ¿Responde la base de datos? (para /api/health) */
async function ping() {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ---------- ID público de cada jugador ----------
// Número de 8 cifras, aleatorio para que no se pueda adivinar ni equivocarse con
// el de otro jugador por una cifra (como pasaría con 1, 2, 3…).

const newPublicId = () => String(crypto.randomInt(10_000_000, 100_000_000));

/** Ejecuta insert(publicId) con IDs nuevos hasta que no choque con uno existente. */
async function withPublicId(insert) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await insert(newPublicId());
    } catch (err) {
      if (attempt < 10 && err.code === 'ER_DUP_ENTRY' && String(err.message).includes('public_id')) continue;
      throw err;
    }
  }
}

module.exports = { init, query, one, transaction, ping, withPublicId, describe };
