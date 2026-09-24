'use strict';

// Único módulo que modifica créditos. No hay ningún endpoint ni evento de
// socket que permita al cliente sumarse créditos: solo el bono de bienvenida
// (una vez por cuenta), los pagos que calculan los juegos en el servidor y las
// transferencias entre jugadores (que solo mueven créditos, nunca los crean).

const { EventEmitter } = require('node:events');
const { one, transaction } = require('./db');

const WELCOME_BONUS = 100;

const events = new EventEmitter();

const SQL = {
  balance: 'SELECT credits FROM users WHERE id = ?',
  debit: 'UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?',
  credit: 'UPDATE users SET credits = credits + ? WHERE id = ?',
  bonus: 'UPDATE users SET credits = credits + ?, welcome_bonus_granted = 1 WHERE id = ? AND welcome_bonus_granted = 0',
  ledger: 'INSERT INTO ledger (user_id, delta, balance_after, reason, created_at) VALUES (?, ?, ?, ?, ?)',
  transfer: 'INSERT INTO transfers (from_user, to_user, amount, created_at) VALUES (?, ?, ?, ?)',
  lockPair: 'SELECT id FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE',
};

function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`Cantidad inválida: ${amount}`);
}

async function getBalance(userId) {
  const row = await one(SQL.balance, [userId]);
  return row ? Number(row.credits) : 0;
}

/**
 * Aplica un cambio de saldo + asiento contable de forma atómica.
 * El UPDATE bloquea la fila hasta el COMMIT, así que el saldo leído después es el nuestro.
 */
async function apply(userId, delta, reason, sql, params) {
  const balance = await transaction(async (tx) => {
    if ((await tx.query(sql, params)).affectedRows === 0) return null;
    const after = Number((await tx.one(SQL.balance, [userId])).credits);
    await tx.query(SQL.ledger, [userId, delta, after, reason, Date.now()]);
    return after;
  });
  if (balance !== null) events.emit('balance', userId, balance);
  return balance;
}

/** Resta créditos. Devuelve el nuevo saldo, o null si no alcanza. */
function debit(userId, amount, reason) {
  assertAmount(amount);
  return apply(userId, -amount, reason, SQL.debit, [amount, userId, amount]);
}

/** Suma créditos (solo lo llaman los juegos al pagar o reembolsar). */
function credit(userId, amount, reason) {
  assertAmount(amount);
  return apply(userId, amount, reason, SQL.credit, [amount, userId]);
}

/** Da los 100 créditos de bienvenida. Solo tiene efecto la primera vez. */
async function grantWelcomeBonus(userId) {
  return (await apply(userId, WELCOME_BONUS, 'welcome_bonus', SQL.bonus, [WELCOME_BONUS, userId])) !== null;
}

/**
 * Pasa créditos de un jugador a otro de forma atómica: o se mueven los dos
 * saldos (con su asiento contable) o no cambia nada. Devuelve el saldo del
 * que envía, o null si no le alcanza.
 */
async function transfer(fromId, toId, amount) {
  assertAmount(amount);
  if (fromId === toId) throw new Error('Transferencia a uno mismo');

  const run = () =>
    transaction(async (tx) => {
      // Bloquea las dos cuentas siempre en el mismo orden (por id): así dos envíos
      // cruzados (A→B y B→A) no se bloquean mutuamente.
      if ((await tx.query(SQL.lockPair, [fromId, toId])).length !== 2) throw new Error(`Destinatario inexistente: ${toId}`);
      if ((await tx.query(SQL.debit, [amount, fromId, amount])).affectedRows === 0) return null;
      await tx.query(SQL.credit, [amount, toId]);
      const now = Date.now();
      const { insertId } = await tx.query(SQL.transfer, [fromId, toId, amount, now]);
      const fromAfter = Number((await tx.one(SQL.balance, [fromId])).credits);
      const toAfter = Number((await tx.one(SQL.balance, [toId])).credits);
      await tx.query(SQL.ledger, [fromId, -amount, fromAfter, `transfer:out:${insertId}`, now]);
      await tx.query(SQL.ledger, [toId, amount, toAfter, `transfer:in:${insertId}`, now]);
      return { fromAfter, toAfter };
    });

  let result;
  try {
    result = await run();
  } catch (err) {
    // MySQL puede abortar una transacción por bloqueo mutuo; se reintenta una vez.
    if (err.code !== 'ER_LOCK_DEADLOCK') throw err;
    result = await run();
  }
  if (!result) return null;
  events.emit('balance', fromId, result.fromAfter);
  events.emit('balance', toId, result.toAfter);
  return result.fromAfter;
}

module.exports = { events, getBalance, debit, credit, transfer, grantWelcomeBonus, WELCOME_BONUS };
