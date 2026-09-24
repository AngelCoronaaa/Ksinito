'use strict';

// Ruleta europea (un solo cero) con rondas compartidas por todos los jugadores:
// apuestas (20s) -> giro (7s) -> resultado (5s) -> ...
//
// Todo lo que cambia el estado (apuestas, cambios de fase) pasa por `this.queue`,
// de una operación en una, porque cobrar y pagar en MySQL es asíncrono.

const crypto = require('node:crypto');
const { query, transaction } = require('./db');
const wallet = require('./wallet');
const { SerialQueue } = require('./queue');
const { GameError, assertInt } = require('./errors');

const BETTING_MS = 20_000;
const SPIN_MS = 7_000;
const RESULT_MS = 5_000;
const HISTORY_SIZE = 30;
const MIN_BET = 1;
const MAX_BET_PER_SPOT = 500;
const MAX_BET_PER_ROUND = 2_000;

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// payout = ganancia por cada crédito apostado (se devuelve además la apuesta).
const BET_TYPES = {
  straight: { payout: 35, values: range(0, 36), wins: (v, n) => n === v },
  dozen: { payout: 2, values: [1, 2, 3], wins: (v, n) => n !== 0 && Math.ceil(n / 12) === v },
  column: { payout: 2, values: [1, 2, 3], wins: (v, n) => n !== 0 && ((n - 1) % 3) + 1 === v },
  red: { payout: 1, wins: (_, n) => colorOf(n) === 'red' },
  black: { payout: 1, wins: (_, n) => colorOf(n) === 'black' },
  even: { payout: 1, wins: (_, n) => n !== 0 && n % 2 === 0 },
  odd: { payout: 1, wins: (_, n) => n % 2 === 1 },
  low: { payout: 1, wins: (_, n) => n >= 1 && n <= 18 },
  high: { payout: 1, wins: (_, n) => n >= 19 },
};

const SQL = {
  history: 'SELECT number FROM roulette_spins ORDER BY id DESC LIMIT ?',
  insert: 'INSERT INTO roulette_spins (number, created_at) VALUES (?, ?)',
  // MySQL no deja usar LIMIT dentro de NOT IN directamente; va en una tabla derivada.
  trim: 'DELETE FROM roulette_spins WHERE id NOT IN (SELECT id FROM (SELECT id FROM roulette_spins ORDER BY id DESC LIMIT ?) AS keep_rows)',
};

class RouletteGame {
  /** Carga el historial de MySQL y arranca la primera ronda. */
  static async create(io) {
    const rows = await query(SQL.history, [HISTORY_SIZE]);
    return new RouletteGame(io, rows.map(({ number }) => ({ number, color: colorOf(number) })));
  }

  constructor(io, history) {
    this.io = io;
    this.room = 'roulette';
    this.queue = new SerialQueue('roulette');
    this.history = history;
    this.bets = new Map(); // userId -> Map(key -> { type, value, amount })
    this.startBetting();
  }

  publicState() {
    return {
      phase: this.phase,
      endsIn: Math.max(0, this.endsAt - Date.now()),
      duration: this.duration,
      result: this.phase === 'betting' ? null : this.result,
      history: this.history,
      players: this.bets.size,
      limits: { min: MIN_BET, maxPerSpot: MAX_BET_PER_SPOT, maxPerRound: MAX_BET_PER_ROUND },
    };
  }

  userBets(userId) {
    return [...(this.bets.get(userId)?.values() ?? [])];
  }

  broadcast() {
    this.io.to(this.room).emit('roulette:state', this.publicState());
  }

  sendBets(userId) {
    this.io.to(`user:${userId}`).emit('roulette:bets', this.userBets(userId));
  }

  schedule(ms, fn) {
    this.endsAt = Date.now() + ms;
    this.duration = ms;
    setTimeout(() => this.queue.fire(fn), ms);
  }

  startBetting() {
    this.phase = 'betting';
    this.result = null;
    this.bets = new Map();
    this.schedule(BETTING_MS, () => this.spin());
    this.broadcast();
  }

  spin() {
    this.phase = 'spinning';
    this.result = crypto.randomInt(0, 37);
    this.schedule(SPIN_MS, () => this.settle());
    this.broadcast();
  }

  async settle() {
    const number = this.result;
    const color = colorOf(number);
    this.history = [{ number, color }, ...this.history].slice(0, HISTORY_SIZE);

    const payouts = [];
    for (const [userId, bets] of this.bets) {
      let staked = 0;
      let won = 0;
      for (const bet of bets.values()) {
        staked += bet.amount;
        const def = BET_TYPES[bet.type];
        if (def.wins(bet.value, number)) won += bet.amount * (def.payout + 1);
      }
      payouts.push({ userId, staked, won });
    }

    // Aunque falle guardar el historial, los premios se pagan.
    await transaction(async (tx) => {
      await tx.query(SQL.insert, [number, Date.now()]);
      await tx.query(SQL.trim, [HISTORY_SIZE]);
    }).catch((err) => console.error('[roulette] No se pudo guardar el giro', err));

    await Promise.all(
      payouts.map(async ({ userId, staked, won }) => {
        try {
          if (won > 0) await wallet.credit(userId, won, `roulette:win:${number}`);
          this.io.to(`user:${userId}`).emit('roulette:outcome', { number, color, staked, won });
        } catch (err) {
          console.error(`[roulette] No se pudo pagar ${won} al usuario ${userId}`, err);
        }
      })
    );

    this.phase = 'result';
    this.schedule(RESULT_MS, () => this.startBetting());
    this.broadcast();
  }

  placeBet(user, bet) {
    return this.queue.run(() => this.#placeBet(user, bet));
  }

  async #placeBet(user, { type, value, amount }) {
    if (this.phase !== 'betting') throw new GameError('Las apuestas están cerradas');
    const def = Object.hasOwn(BET_TYPES, type) ? BET_TYPES[type] : null;
    if (!def) throw new GameError('Tipo de apuesta no válido');
    if (def.values) {
      if (!def.values.includes(value)) throw new GameError('Casilla no válida');
    } else {
      value = null;
    }
    assertInt(amount, MIN_BET, MAX_BET_PER_SPOT, 'La apuesta');

    const bets = this.bets.get(user.id) ?? new Map();
    const key = `${type}:${value ?? ''}`;
    const onSpot = bets.get(key)?.amount ?? 0;
    const inRound = [...bets.values()].reduce((sum, b) => sum + b.amount, 0);
    if (onSpot + amount > MAX_BET_PER_SPOT) throw new GameError(`Máximo ${MAX_BET_PER_SPOT} por casilla`);
    if (inRound + amount > MAX_BET_PER_ROUND) throw new GameError(`Máximo ${MAX_BET_PER_ROUND} por ronda`);

    if ((await wallet.debit(user.id, amount, `roulette:bet:${key}`)) === null) {
      throw new GameError('Créditos insuficientes');
    }
    bets.set(key, { type, value, amount: onSpot + amount });
    this.bets.set(user.id, bets);
    this.sendBets(user.id);
  }

  clearBets(user) {
    return this.queue.run(async () => {
      if (this.phase !== 'betting') throw new GameError('Las apuestas están cerradas');
      const bets = this.bets.get(user.id);
      if (!bets) return;
      const total = [...bets.values()].reduce((sum, b) => sum + b.amount, 0);
      // Primero se devuelve el dinero: si MySQL falla, las apuestas siguen en la mesa.
      if (total > 0) await wallet.credit(user.id, total, 'roulette:refund');
      this.bets.delete(user.id);
      this.sendBets(user.id);
    });
  }
}

module.exports = { RouletteGame };
