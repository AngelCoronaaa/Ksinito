'use strict';

// Mesa de blackjack multijugador (15 asientos por mesa; server.js crea varias).
// Reglas: 8 barajas, el crupier se planta en 17 (incluido 17 suave), el
// blackjack paga 3:2, se puede doblar con las dos primeras cartas y dividir
// una vez (los ases divididos reciben una sola carta).
//
// Fases: waiting -> betting -> dealing -> playing -> dealer -> settled -> waiting ...
//
// Todo lo que cambia el estado pasa por `this.queue`, de una operación en una: cobrar y
// pagar en MySQL es asíncrono y, sin la cola, un temporizador o la acción de otro
// jugador podrían colarse mientras se espera a la base de datos.

const crypto = require('node:crypto');
const wallet = require('./wallet');
const { avatarUrl } = require('./avatars');
const { SerialQueue } = require('./queue');
const { GameError, assertInt } = require('./errors');

const MAX_SEATS = 15;
const DECKS = 8;
const RESHUFFLE_AT = Math.floor(DECKS * 52 * 0.25);
const MIN_BET = 1;
const MAX_BET = 500;
const BETTING_MS = 15_000;
const DEAL_STEP_MS = 450;
const DEAL_TOTAL_MS = 7_000; // con la mesa llena el reparto se acelera para no pasar de esto
const MIN_DEAL_STEP_MS = 180;
const TURN_MS = 20_000;
const DEALER_STEP_MS = 800;
const RESULT_MS = 6_000;

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

function buildShoe() {
  const shoe = [];
  for (let d = 0; d < DECKS; d++) for (const s of SUITS) for (const r of RANKS) shoe.push({ r, s });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function rankValue(r) {
  if (r === 'A') return 1;
  if (r === 'J' || r === 'Q' || r === 'K') return 10;
  return Number(r);
}

function handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += rankValue(c.r);
    if (c.r === 'A') aces++;
  }
  const soft = aces > 0 && total + 10 <= 21;
  return { total: soft ? total + 10 : total, soft };
}

const isNatural = (hand) => !hand.fromSplit && hand.cards.length === 2 && handTotal(hand.cards).total === 21;

const newHand = (cards, bet, fromSplit = false) => ({
  cards,
  bet,
  fromSplit,
  splitAces: false,
  doubled: false,
  done: false,
  result: null,
  payout: 0,
});

class BlackjackTable {
  constructor(io, id, { seats = MAX_SEATS, onChange = () => {} } = {}) {
    this.io = io;
    this.id = id;
    this.name = `Mesa ${id}`;
    this.room = `bj:${id}`;
    this.onChange = onChange; // avisa a server.js para actualizar el resumen de mesas
    this.seats = Array(seats).fill(null);
    this.shoe = buildShoe();
    this.dealer = [];
    this.holeHidden = true;
    this.phase = 'waiting';
    this.turn = null;
    this.endsAt = null;
    this.duration = null;
    this.timer = null;
    this.timerGen = 0;
    this.queue = new SerialQueue(`blackjack ${id}`);
  }

  // ---------- utilidades ----------

  schedule(ms, fn) {
    clearTimeout(this.timer);
    // Si mientras el temporizador espera en la cola se programa otro (p. ej. el jugador
    // pidió carta justo al acabar su tiempo), el viejo ya no debe hacer nada.
    const gen = ++this.timerGen;
    this.endsAt = Date.now() + ms;
    this.duration = ms;
    this.timer = setTimeout(() => this.queue.fire(() => (gen === this.timerGen ? fn() : undefined)), ms);
  }

  clearSchedule() {
    clearTimeout(this.timer);
    this.timerGen++;
    this.timer = null;
    this.endsAt = null;
    this.duration = null;
  }

  draw() {
    if (this.shoe.length === 0) this.shoe = buildShoe();
    return this.shoe.pop();
  }

  seatIndexOf(userId) {
    return this.seats.findIndex((s) => s && s.userId === userId);
  }

  requireSeat(userId) {
    const i = this.seatIndexOf(userId);
    if (i === -1) throw new GameError('No estás sentado en la mesa');
    return i;
  }

  publicState() {
    // La carta tapada del crupier nunca sale del servidor mientras está oculta.
    const dealerCards = this.holeHidden && this.dealer.length === 2 ? [this.dealer[0], null] : this.dealer;
    const visible = dealerCards.filter(Boolean);
    return {
      id: this.id,
      name: this.name,
      phase: this.phase,
      endsIn: this.endsAt ? Math.max(0, this.endsAt - Date.now()) : null,
      duration: this.duration,
      turn: this.turn,
      limits: { min: MIN_BET, max: MAX_BET },
      dealer: { cards: dealerCards, total: visible.length ? handTotal(visible).total : null },
      seats: this.seats.map(
        (s) =>
          s && {
            userId: s.userId,
            username: s.username,
            avatar: avatarUrl(s.userId),
            bet: s.bet,
            leaving: s.leaving,
            activeHand: s.activeHand,
            hands: s.hands.map((h) => ({
              cards: h.cards,
              bet: h.bet,
              ...handTotal(h.cards),
              doubled: h.doubled,
              fromSplit: h.fromSplit,
              splitAces: h.splitAces,
              done: h.done,
              result: h.result,
              payout: h.payout,
            })),
          }
      ),
    };
  }

  /** Resumen para el selector de mesas (lo reciben todos los jugadores). */
  summary() {
    return {
      id: this.id,
      name: this.name,
      seats: this.seats.length,
      occupants: this.seats.filter(Boolean).map((s) => s.userId),
      phase: this.phase,
    };
  }

  broadcast() {
    this.io.to(this.room).emit('bj:state', this.publicState());
    this.onChange();
  }

  // ---------- asientos y apuestas ----------

  sit(user, seat) {
    return this.queue.run(() => this.#sit(user, seat));
  }

  #sit(user, seat) {
    assertInt(seat, 0, this.seats.length - 1, 'El asiento');
    if (this.seatIndexOf(user.id) !== -1) throw new GameError('Ya estás sentado en esta mesa');
    if (this.seats[seat]) throw new GameError('Ese asiento está ocupado');
    this.seats[seat] = { userId: user.id, username: user.username, bet: 0, hands: [], activeHand: 0, leaving: false };
    this.broadcast();
  }

  leave(userId) {
    return this.queue.run(() => this.#leave(userId));
  }

  async #leave(userId) {
    const i = this.seatIndexOf(userId);
    if (i === -1) return;
    const seat = this.seats[i];

    if (seat.hands.length === 0) {
      // No está jugando la mano actual: se va ya (y se le devuelve la apuesta si la hizo).
      if (seat.bet > 0) await wallet.credit(userId, seat.bet, 'blackjack:refund');
      this.seats[i] = null;
      if (this.phase === 'waiting' || this.phase === 'betting') this.checkBets();
    } else {
      // Tiene cartas: sus manos se plantan y el asiento se libera al terminar la ronda.
      seat.leaving = true;
      if (this.phase === 'playing' && this.turn === i) return this.advance();
    }
    this.broadcast();
  }

  placeBet(user, amount) {
    return this.queue.run(() => this.#placeBet(user, amount));
  }

  async #placeBet(user, amount) {
    if (this.phase !== 'waiting' && this.phase !== 'betting') {
      throw new GameError('La mano está en juego, espera a la siguiente');
    }
    const seat = this.seats[this.requireSeat(user.id)];
    if (seat.bet > 0) throw new GameError('Ya hiciste tu apuesta');
    assertInt(amount, MIN_BET, MAX_BET, 'La apuesta');
    if ((await wallet.debit(user.id, amount, 'blackjack:bet')) === null) throw new GameError('Créditos insuficientes');
    seat.bet = amount;
    this.checkBets();
    this.broadcast();
  }

  /** Arranca la cuenta atrás con la primera apuesta y reparte si ya apostaron todos. */
  checkBets() {
    const seated = this.seats.filter(Boolean);
    const withBet = seated.filter((s) => s.bet > 0);
    if (withBet.length === 0) {
      this.phase = 'waiting';
      this.clearSchedule();
    } else if (withBet.length === seated.length) {
      this.deal();
    } else if (this.phase === 'waiting') {
      this.phase = 'betting';
      this.schedule(BETTING_MS, () => this.deal());
    }
  }

  // ---------- ronda ----------

  deal() {
    this.clearSchedule();
    const players = this.seats.filter((s) => s && s.bet > 0);
    if (players.length === 0) {
      this.phase = 'waiting';
      return this.broadcast();
    }
    if (this.shoe.length < RESHUFFLE_AT) this.shoe = buildShoe();

    this.dealer = [];
    this.holeHidden = true;
    for (const s of players) {
      s.hands = [newHand([], s.bet)];
      s.activeHand = 0;
    }

    // Se reparte carta a carta, como en una mesa real: una a cada jugador,
    // una al crupier, y otra vuelta igual (la segunda del crupier, tapada).
    const order = [];
    for (let k = 0; k < 2; k++) {
      for (const s of players) order.push(s.hands[0].cards);
      order.push(this.dealer);
    }
    this.phase = 'dealing';
    const stepMs = Math.max(MIN_DEAL_STEP_MS, Math.min(DEAL_STEP_MS, Math.floor(DEAL_TOTAL_MS / order.length)));
    let next = 0;
    const step = () => {
      order[next++].push(this.draw());
      this.broadcast();
      this.schedule(stepMs, next < order.length ? step : () => this.startPlay());
    };
    this.broadcast();
    this.schedule(stepMs, step);
  }

  async startPlay() {
    this.phase = 'playing';
    const players = this.seats.filter((s) => s && s.hands.length > 0);
    for (const s of players) if (isNatural(s.hands[0])) s.hands[0].done = true;

    // El crupier revisa si tiene blackjack cuando muestra un As o una figura/10.
    const up = rankValue(this.dealer[0].r);
    if ((up === 1 || up === 10) && handTotal(this.dealer).total === 21) return this.settle();

    this.turn = 0;
    this.advance();
  }

  /** Pasa el turno a la siguiente mano pendiente, o al crupier si no queda ninguna. */
  advance() {
    for (let i = this.turn ?? 0; i < this.seats.length; i++) {
      const seat = this.seats[i];
      if (!seat) continue;
      if (seat.leaving) for (const h of seat.hands) h.done = true;
      const h = seat.hands.findIndex((hand) => !hand.done);
      if (h === -1) continue;
      this.turn = i;
      seat.activeHand = h;
      this.schedule(TURN_MS, () => this.onTurnTimeout());
      return this.broadcast();
    }
    this.turn = null;
    this.playDealer();
  }

  onTurnTimeout() {
    const seat = this.seats[this.turn];
    if (seat) seat.hands[seat.activeHand].done = true;
    this.advance();
  }

  act(user, action) {
    return this.queue.run(() => this.#act(user, action));
  }

  async #act(user, action) {
    if (this.phase !== 'playing') throw new GameError('Ahora no puedes jugar');
    const i = this.requireSeat(user.id);
    if (i !== this.turn) throw new GameError('No es tu turno');
    const seat = this.seats[i];
    const hand = seat.hands[seat.activeHand];

    switch (action) {
      case 'hit':
        hand.cards.push(this.draw());
        if (handTotal(hand.cards).total >= 21) hand.done = true;
        break;

      case 'stand':
        hand.done = true;
        break;

      case 'double':
        if (hand.cards.length !== 2 || hand.splitAces) {
          throw new GameError('Solo puedes doblar con tus dos primeras cartas');
        }
        if ((await wallet.debit(user.id, hand.bet, 'blackjack:double')) === null) throw new GameError('Créditos insuficientes');
        hand.bet *= 2;
        hand.doubled = true;
        hand.cards.push(this.draw());
        hand.done = true;
        break;

      case 'split': {
        const [a, b] = hand.cards;
        if (seat.hands.length !== 1 || hand.cards.length !== 2 || rankValue(a.r) !== rankValue(b.r)) {
          throw new GameError('Solo puedes dividir una pareja con tus dos primeras cartas');
        }
        if ((await wallet.debit(user.id, hand.bet, 'blackjack:split')) === null) throw new GameError('Créditos insuficientes');
        const aces = a.r === 'A';
        seat.hands = [a, b].map((card) => {
          const h = newHand([card, this.draw()], hand.bet, true);
          if (aces) h.splitAces = true;
          if (aces || handTotal(h.cards).total === 21) h.done = true;
          return h;
        });
        break;
      }

      default:
        throw new GameError('Acción no válida');
    }
    this.advance();
  }

  playDealer() {
    this.phase = 'dealer';
    this.holeHidden = false;
    // Si todas las manos se pasaron o son blackjack, el crupier no necesita pedir.
    const needsToDraw = this.seats.some(
      (s) => s && s.hands.some((h) => handTotal(h.cards).total <= 21 && !isNatural(h))
    );
    const step = () => {
      if (needsToDraw && handTotal(this.dealer).total < 17) {
        this.dealer.push(this.draw());
        this.broadcast();
        this.schedule(DEALER_STEP_MS, step);
      } else {
        return this.settle();
      }
    };
    this.broadcast();
    this.schedule(DEALER_STEP_MS, step);
  }

  async settle() {
    this.clearSchedule();
    this.phase = 'settled';
    this.holeHidden = false;
    this.turn = null;
    const dealerTotal = handTotal(this.dealer).total;
    const dealerNatural = this.dealer.length === 2 && dealerTotal === 21;

    for (const seat of this.seats) {
      if (!seat) continue;
      for (const hand of seat.hands) {
        const total = handTotal(hand.cards).total;
        const natural = isNatural(hand);
        let result;
        if (total > 21) result = 'lose';
        else if (natural && dealerNatural) result = 'push';
        else if (natural) result = 'blackjack';
        else if (dealerNatural) result = 'lose';
        else if (dealerTotal > 21 || total > dealerTotal) result = 'win';
        else if (total === dealerTotal) result = 'push';
        else result = 'lose';

        hand.done = true;
        hand.result = result;
        hand.payout =
          result === 'blackjack'
            ? hand.bet + Math.floor((hand.bet * 3) / 2)
            : result === 'win'
              ? hand.bet * 2
              : result === 'push'
                ? hand.bet
                : 0;
      }
    }

    // Se paga a todos a la vez; si un pago falla se registra y el resto sigue.
    await Promise.all(
      this.seats
        .filter((seat) => seat && seat.hands.length)
        .map(async (seat) => {
          const payout = seat.hands.reduce((sum, h) => sum + h.payout, 0);
          try {
            for (const hand of seat.hands) {
              if (hand.payout > 0) await wallet.credit(seat.userId, hand.payout, `blackjack:${hand.result}`);
            }
            // Aviso privado: llega aunque el jugador esté mirando otra mesa.
            this.io.to(`user:${seat.userId}`).emit('bj:outcome', {
              table: this.id,
              name: this.name,
              bet: seat.hands.reduce((sum, h) => sum + h.bet, 0),
              payout,
              results: seat.hands.map((h) => h.result),
            });
          } catch (err) {
            console.error(`[blackjack ${this.id}] No se pudo pagar ${payout} al usuario ${seat.userId}`, err);
          }
        })
    );

    this.schedule(RESULT_MS, () => this.resetRound());
    this.broadcast();
  }

  resetRound() {
    this.clearSchedule();
    this.dealer = [];
    this.holeHidden = true;
    this.turn = null;
    this.phase = 'waiting';
    this.seats = this.seats.map((s) =>
      !s || s.leaving ? null : Object.assign(s, { bet: 0, hands: [], activeHand: 0 })
    );
    this.broadcast();
  }
}

module.exports = { BlackjackTable, MAX_SEATS };
