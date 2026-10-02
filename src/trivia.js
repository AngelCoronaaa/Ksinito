'use strict';

// Minijuego "Trivia", individual: apuestas de MIN_BET a MAX_BET y respondes 5 preguntas. Antes
// de cada una gira una ruleta de categorías (ciencia, geografía, historia, cine, arte y deportes).
// Al terminar se paga según los aciertos: 5/5 ×3, 4/5 ×2, 3/5 ×1,5; con menos se pierde lo apostado.
//
// El servidor decide todo: la categoría que sale, la pregunta y el orden de las opciones. La
// pregunta solo se envía cuando la ruleta termina de girar, y la respuesta correcta solo después
// de contestar (o de que se acabe el tiempo). El cliente solo dice "gira" y "elijo la opción n".
//
// La partida en juego vive en memoria (una por jugador); `trivia_rounds` guarda cada partida y
// garantiza que se pague una sola vez. Todas las operaciones de un jugador, y los temporizadores
// de su partida, pasan por su SerialQueue.

const crypto = require('node:crypto');
const db = require('./db');
const wallet = require('./wallet');
const BANK = require('./trivia-questions');
const { SerialQueue } = require('./queue');
const { GameError, assertInt } = require('./errors');

const MIN_BET = 10;
const MAX_BET = 100_000;
const QUESTIONS = 5;
const MULTIPLIERS = [
  { correct: 5, multiplier: 3 },
  { correct: 4, multiplier: 2 },
  { correct: 3, multiplier: 1.5 },
]; // con menos aciertos se pierde la apuesta
const SPIN_MS = 3_600; // lo que tarda en girar la ruleta de categorías
const ANSWER_MS = 20_000; // tiempo para responder cada pregunta
const GRACE_MS = 800; // margen para respuestas enviadas justo al final (latencia)
const IDLE_MS = 30_000; // sin pulsar "Girar" en este tiempo, la ruleta gira sola
const RECENT_PER_USER = 60; // preguntas recientes que no se le repiten a un jugador

const CATEGORIES = [
  { id: 'ciencia', name: 'Ciencia' },
  { id: 'geografia', name: 'Geografía' },
  { id: 'historia', name: 'Historia' },
  { id: 'cine', name: 'Cine' },
  { id: 'arte', name: 'Arte' },
  { id: 'deportes', name: 'Deportes' },
];

const SQL = {
  insert: "INSERT INTO trivia_rounds (user_id, bet, status, created_at) VALUES (?, ?, 'playing', ?)",
  settle: `
    UPDATE trivia_rounds SET status = 'settled', correct = ?, payout = ?, questions = ?, ended_at = ?
    WHERE id = ? AND user_id = ? AND status = 'playing'`,
  open: "SELECT id, user_id, bet FROM trivia_rounds WHERE status = 'playing'",
  refund: "UPDATE trivia_rounds SET status = 'refunded', ended_at = ? WHERE id = ? AND status = 'playing'",
};

/** Multiplicador según los aciertos (0 = pierde la apuesta). */
function multiplierFor(correct) {
  return MULTIPLIERS.find((m) => m.correct === correct)?.multiplier ?? 0;
}

/** Lo que se cobra al terminar (apuesta incluida), redondeado hacia abajo. */
function payoutFor(bet, correct) {
  return Math.floor(bet * multiplierFor(correct));
}

// ---------- preguntas ----------

const QUESTION_IDS = Object.fromEntries(CATEGORIES.map((c) => [c.id, BANK[c.id].map((_, i) => `${c.id}:${i}`)]));

function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pregunta al azar de la categoría, evitando las de esta partida (`exclude`) y, si se puede,
 * las que el jugador vio hace poco (`recent`). Las opciones salen barajadas.
 */
function pickQuestion(categoryId, exclude = new Set(), recent = new Set()) {
  const ids = QUESTION_IDS[categoryId].filter((id) => !exclude.has(id));
  const fresh = ids.filter((id) => !recent.has(id));
  const pool = fresh.length ? fresh : ids;
  const id = pool[crypto.randomInt(pool.length)];
  const [text, ...answers] = BANK[categoryId][Number(id.split(':')[1])];
  const order = shuffle([0, 1, 2, 3]); // la 0 es la correcta en el banco
  return { id, category: categoryId, text, options: order.map((i) => answers[i]), correctIndex: order.indexOf(0) };
}

// ---------- partida (estado en memoria, sin base de datos ni temporizadores) ----------

class TriviaRound {
  constructor({ id, userId, bet, now = performance.now() }) {
    this.id = id;
    this.userId = userId;
    this.bet = bet;
    this.phase = 'ready'; // ready → spinning → question → answered → spinning … → finished
    this.results = []; // { questionId, category, choice, correctIndex, correct, timedOut }
    this.current = null; // pregunta en juego: { id, category, text, options, correctIndex }
    this.deadline = null; // hasta cuándo se puede responder (reloj del servidor)
    this.endsAt = now + IDLE_MS; // fin de la fase actual (para la cuenta atrás del cliente)
    this.duration = IDLE_MS;
    this.ended = false;
    this.timer = null;
  }

  get correct() {
    return this.results.filter((r) => r.correct).length;
  }

  get done() {
    return this.results.length >= QUESTIONS;
  }

  /** Ids de las preguntas de esta partida (para no repetirlas). */
  askedIds() {
    return new Set([...this.results.map((r) => r.questionId), ...(this.current ? [this.current.id] : [])]);
  }

  setPhase(phase, now, ms) {
    this.phase = phase;
    this.endsAt = now + ms;
    this.duration = ms;
  }

  /** Gira la ruleta: la pregunta ya está elegida, pero no se enseña hasta ask(). */
  spin(question, now) {
    if (this.phase !== 'ready' && this.phase !== 'answered') throw new GameError('Ahora no se puede girar');
    if (this.done) throw new GameError('Ya respondiste todas las preguntas');
    this.current = question;
    this.setPhase('spinning', now, SPIN_MS);
  }

  ask(now) {
    if (this.phase !== 'spinning') return;
    this.deadline = now + ANSWER_MS;
    this.setPhase('question', now, ANSWER_MS);
  }

  /** Registra la respuesta (`choice` null = se acabó el tiempo). Una respuesta tardía cuenta como fallo. */
  answer(choice, now) {
    if (this.phase !== 'question') throw new GameError('No hay ninguna pregunta esperando respuesta');
    const timedOut = choice === null || now > this.deadline + GRACE_MS;
    const { id, category, correctIndex } = this.current;
    const result = {
      questionId: id,
      category,
      choice: timedOut ? null : choice,
      correctIndex,
      correct: !timedOut && choice === correctIndex,
      timedOut,
    };
    this.results.push(result);
    this.deadline = null;
    if (this.done) this.setPhase('finished', now, 0);
    else this.setPhase('answered', now, IDLE_MS);
    return result;
  }

  /** Lo que ve el jugador. La respuesta correcta solo aparece cuando la pregunta ya está contestada. */
  snapshot(now = performance.now()) {
    const showQuestion = ['question', 'answered', 'finished'].includes(this.phase) && this.current;
    const last = this.phase === 'answered' || this.phase === 'finished' ? this.results.at(-1) : null;
    return {
      roundId: this.id,
      bet: this.bet,
      total: QUESTIONS,
      phase: this.phase,
      number: this.results.length + (this.phase === 'spinning' || this.phase === 'question' ? 1 : 0),
      results: this.results.map(({ category, correct, timedOut }) => ({ category, correct, timedOut })),
      correct: this.correct,
      category: this.current && this.phase !== 'ready' ? this.current.category : null,
      question: showQuestion ? { text: this.current.text, options: this.current.options } : null,
      last: last && { choice: last.choice, correctIndex: last.correctIndex, correct: last.correct, timedOut: last.timedOut },
      endsIn: Math.max(0, Math.round(this.endsAt - now)),
      duration: this.duration,
    };
  }
}

// ---------- partidas en juego ----------

let io = null;
const rounds = new Map(); // userId -> TriviaRound
const queues = new Map(); // userId -> SerialQueue
const recent = new Map(); // userId -> ids de preguntas vistas hace poco

function queueOf(userId) {
  let queue = queues.get(userId);
  if (!queue) queues.set(userId, (queue = new SerialQueue(`trivia:${userId}`)));
  return queue;
}

/** Todo va a todas las pestañas del jugador. */
function send(userId, event, data) {
  io?.to(`user:${userId}`).emit(event, data);
}

const sendRound = (round) => send(round.userId, 'trivia:round', round.snapshot());

/** Un solo temporizador por partida (cada fase reemplaza al anterior); pasa por la cola del jugador. */
function setTimer(round, ms, fn) {
  clearTimeout(round.timer);
  round.timer = setTimeout(() => {
    round.timer = null;
    queueOf(round.userId).fire(() => (round.ended ? undefined : fn()));
  }, ms);
}

function activeRound(userId, roundId) {
  const round = rounds.get(userId);
  if (!round || round.id !== roundId) throw new GameError('Esa partida ya terminó');
  return round;
}

function remember(userId, questionId) {
  const list = recent.get(userId) ?? [];
  list.push(questionId);
  if (list.length > RECENT_PER_USER) list.shift();
  recent.set(userId, list);
}

function doSpin(round) {
  const category = CATEGORIES[crypto.randomInt(CATEGORIES.length)].id;
  const question = pickQuestion(category, round.askedIds(), new Set(recent.get(round.userId)));
  round.spin(question, performance.now());
  remember(round.userId, question.id);
  setTimer(round, SPIN_MS, () => ask(round));
  sendRound(round);
}

function ask(round) {
  round.ask(performance.now());
  setTimer(round, ANSWER_MS + GRACE_MS, () => afterAnswer(round, null));
  sendRound(round);
}

/** Tras cada respuesta (o tiempo agotado): espera el siguiente giro o cierra la partida. */
function afterAnswer(round, choice) {
  round.answer(choice, performance.now());
  if (round.done) return finish(round);
  setTimer(round, IDLE_MS, () => doSpin(round));
  sendRound(round);
  return undefined;
}

/**
 * Paga la partida: una transacción que la marca como cobrada y suma el premio. El UPDATE
 * condicional (status = 'playing') hace imposible pagarla dos veces.
 */
async function settle(round) {
  const correct = round.correct;
  const payout = payoutFor(round.bet, correct);
  const questions = round.results.map((r) => `${r.questionId}${r.correct ? '+' : '-'}`).join(',');
  return db.transaction(async (tx) => {
    const { affectedRows } = await tx.query(SQL.settle, [correct, payout, questions, Date.now(), round.id, round.userId]);
    if (affectedRows !== 1) return { payout: 0, balance: null }; // ya estaba cerrada
    const balance = payout > 0 ? await wallet.credit(round.userId, payout, `trivia:win:${round.id}`, tx) : null;
    return { payout, balance };
  });
}

/** Cierra la partida (dentro de la cola del jugador), la paga y avisa a sus pestañas. */
async function finish(round) {
  round.ended = true;
  clearTimeout(round.timer);
  if (rounds.get(round.userId) === round) rounds.delete(round.userId);
  sendRound(round); // muestra la última respuesta antes del resumen

  let paid = null;
  try {
    paid = await settle(round);
  } catch (err) {
    console.error(`[trivia] No se pudo pagar la partida ${round.id} (${round.correct}/${QUESTIONS}) de ${round.userId}`, err);
  }
  send(round.userId, 'trivia:end', {
    roundId: round.id,
    bet: round.bet,
    correct: round.correct,
    total: QUESTIONS,
    multiplier: multiplierFor(round.correct),
    payout: paid?.payout ?? 0,
    error: paid === null,
  });
}

/** `trivia:start { amount }`: cobra la apuesta y empieza la partida. */
function start(userId, amount) {
  assertInt(amount, MIN_BET, MAX_BET, 'La apuesta');
  return queueOf(userId).run(async () => {
    if (rounds.has(userId)) throw new GameError('Ya tienes una partida de trivia en juego');
    // La fila de la partida y el cobro van juntos: si no le alcanza, no queda nada guardado.
    const id = await db.transaction(async (tx) => {
      const { insertId } = await tx.query(SQL.insert, [userId, amount, Date.now()]);
      if ((await wallet.bet(userId, amount, `trivia:bet:${insertId}`, tx)) === null) throw new GameError('Créditos insuficientes');
      return Number(insertId);
    });
    const round = new TriviaRound({ id, userId, bet: amount });
    rounds.set(userId, round);
    setTimer(round, IDLE_MS, () => doSpin(round));
    sendRound(round);
  });
}

/** `trivia:spin { roundId }`: gira la ruleta para la siguiente pregunta. */
function spin(userId, roundId) {
  return queueOf(userId).run(() => doSpin(activeRound(userId, roundId)));
}

/** `trivia:answer { roundId, choice }`: `choice` es el índice (0-3) de la opción elegida. */
function answer(userId, roundId, choice) {
  assertInt(choice, 0, 3, 'La respuesta');
  return queueOf(userId).run(() => afterAnswer(activeRound(userId, roundId), choice));
}

/** Partida en juego del jugador (para recuperarla tras recargar o reconectar), o null. */
function resume(userId) {
  return rounds.get(userId)?.snapshot() ?? null;
}

/** Límites y reglas para la pantalla de inicio (se envía al conectarse). */
const config = {
  min: MIN_BET,
  max: MAX_BET,
  questions: QUESTIONS,
  multipliers: MULTIPLIERS,
  categories: CATEGORIES,
  answerMs: ANSWER_MS,
};

/**
 * Se llama al arrancar: las partidas que dejó a medias un reinicio no se pueden terminar, así
 * que se devuelve lo apostado (no fue culpa del jugador).
 */
async function init(server) {
  io = server;
  const open = await db.query(SQL.open);
  for (const row of open) {
    try {
      await db.transaction(async (tx) => {
        const { affectedRows } = await tx.query(SQL.refund, [Date.now(), row.id]);
        if (affectedRows === 1) await wallet.refundBet(Number(row.user_id), Number(row.bet), `trivia:refund:${row.id}`, tx);
      });
    } catch (err) {
      console.error(`[trivia] No se pudo devolver la partida ${row.id}`, err);
    }
  }
  if (open.length) console.log(`[trivia] ${open.length} partida(s) a medias por un reinicio devueltas`);
}

module.exports = {
  init,
  start,
  spin,
  answer,
  resume,
  config,
  TriviaRound,
  pickQuestion,
  multiplierFor,
  payoutFor,
  CATEGORIES,
  QUESTIONS,
  ANSWER_MS,
  GRACE_MS,
};
