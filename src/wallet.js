'use strict';

// Único módulo que modifica créditos. No hay ningún endpoint ni evento de
// socket que permita al cliente sumarse créditos: solo el bono de bienvenida
// (una vez por cuenta), los pagos que calculan los juegos en el servidor y las
// transferencias entre jugadores (que solo mueven créditos, nunca los crean).

const { EventEmitter } = require('node:events');
const { db, transaction } = require('./db');

const WELCOME_BONUS = 100;

const events = new EventEmitter();

const stmts = {
  balance: db.prepare('SELECT credits FROM users WHERE id = ?'),
  debit: db.prepare('UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?'),
  credit: db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?'),
  bonus: db.prepare(
    'UPDATE users SET credits = credits + ?, welcome_bonus_granted = 1 WHERE id = ? AND welcome_bonus_granted = 0'
  ),
  ledger: db.prepare(
    'INSERT INTO ledger (user_id, delta, balance_after, reason, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  transfer: db.prepare('INSERT INTO transfers (from_user, to_user, amount, created_at) VALUES (?, ?, ?, ?)'),
};

function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`Cantidad inválida: ${amount}`);
}

function getBalance(userId) {
  const row = stmts.balance.get(userId);
  return row ? row.credits : 0;
}

/** Aplica un cambio de saldo + asiento contable de forma atómica. */
function apply(userId, delta, reason, mutate) {
  const balance = transaction(() => {
    if (mutate().changes === 0) return null;
    const after = getBalance(userId);
    stmts.ledger.run(userId, delta, after, reason, Date.now());
    return after;
  });
  if (balance !== null) events.emit('balance', userId, balance);
  return balance;
}

/** Resta créditos. Devuelve el nuevo saldo, o null si no alcanza. */
function debit(userId, amount, reason) {
  assertAmount(amount);
  return apply(userId, -amount, reason, () => stmts.debit.run(amount, userId, amount));
}

/** Suma créditos (solo lo llaman los juegos al pagar o reembolsar). */
function credit(userId, amount, reason) {
  assertAmount(amount);
  return apply(userId, amount, reason, () => stmts.credit.run(amount, userId));
}

/** Da los 100 créditos de bienvenida. Solo tiene efecto la primera vez. */
function grantWelcomeBonus(userId) {
  return apply(userId, WELCOME_BONUS, 'welcome_bonus', () => stmts.bonus.run(WELCOME_BONUS, userId)) !== null;
}

/**
 * Pasa créditos de un jugador a otro de forma atómica: o se mueven los dos
 * saldos (con su asiento contable) o no cambia nada. Devuelve el saldo del
 * que envía, o null si no le alcanza.
 */
function transfer(fromId, toId, amount) {
  assertAmount(amount);
  if (fromId === toId) throw new Error('Transferencia a uno mismo');
  const result = transaction(() => {
    if (stmts.debit.run(amount, fromId, amount).changes === 0) return null;
    if (stmts.credit.run(amount, toId).changes === 0) throw new Error(`Destinatario inexistente: ${toId}`);
    const now = Date.now();
    const transferId = Number(stmts.transfer.run(fromId, toId, amount, now).lastInsertRowid);
    const fromAfter = getBalance(fromId);
    const toAfter = getBalance(toId);
    stmts.ledger.run(fromId, -amount, fromAfter, `transfer:out:${transferId}`, now);
    stmts.ledger.run(toId, amount, toAfter, `transfer:in:${transferId}`, now);
    return { fromAfter, toAfter };
  });
  if (!result) return null;
  events.emit('balance', fromId, result.fromAfter);
  events.emit('balance', toId, result.toAfter);
  return result.fromAfter;
}

module.exports = { events, getBalance, debit, credit, transfer, grantWelcomeBonus, WELCOME_BONUS };
