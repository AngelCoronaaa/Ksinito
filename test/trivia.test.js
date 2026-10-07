'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BANK = require('../src/trivia-questions');
const { TriviaRound, pickQuestion, payoutFor, multiplierFor, CATEGORIES, QUESTIONS, ANSWER_MS, GRACE_MS } = require('../src/trivia');

test('pagos: 8/8 ×2,5, 7/8 y 6/8 ×2, 5/8 ×1,5 y menos de 5 pierde', () => {
  assert.equal(QUESTIONS, 8);
  assert.equal(payoutFor(1_000, 8), 2_500);
  assert.equal(payoutFor(1_000, 7), 2_000);
  assert.equal(payoutFor(1_000, 6), 2_000);
  assert.equal(payoutFor(1_000, 5), 1_500);
  for (const c of [0, 1, 2, 3, 4]) assert.equal(payoutFor(1_000, c), 0);
  assert.equal(payoutFor(15, 5), 22); // se redondea hacia abajo
  assert.equal(payoutFor(11, 8), 27);
  assert.equal(payoutFor(100_000, 8), 250_000);
  assert.equal(multiplierFor(8), 2.5);
  assert.equal(ANSWER_MS, 10_000);
});

const OPENTDB = require('../src/trivia-questions-opentdb');
const { QUESTION_IDS, QUESTIONS_BY_ID } = require('../src/trivia');

test('banco: cada categoría tiene muchas preguntas con 4 opciones distintas y no vacías', () => {
  for (const { id } of CATEGORIES) {
    const all = [...BANK[id], ...(OPENTDB[id] ?? [])];
    const min = CATEGORIES.slice(0, 6).some((c) => c.id === id) ? 100 : 25; // clásica / tecnología
    assert.ok(all.length >= min, `pocas preguntas en ${id}: ${all.length}`);
    for (const [text, ...answers] of all) {
      assert.ok(text.trim().endsWith('?'), text);
      assert.equal(answers.length, 4, text);
      assert.equal(new Set(answers.map((a) => a.trim().toLowerCase())).size, 4, `opciones repetidas: ${text}`);
      assert.ok(answers.every((a) => a.trim()), text);
    }
  }
});

test('banco: ninguna pregunta repetida y los ids caben en la base de datos', () => {
  const texts = new Set();
  for (const { id } of CATEGORIES) {
    for (const [text] of [...BANK[id], ...(OPENTDB[id] ?? [])]) {
      const key = text.toLowerCase();
      assert.ok(!texts.has(key), `repetida: ${text}`);
      texts.add(key);
    }
    for (const qid of QUESTION_IDS[id]) assert.ok(qid.length <= 32 && /^[a-z]+:[0-9a-f]{10}$/.test(qid), qid);
  }
  assert.equal(QUESTIONS_BY_ID.size, texts.size);
});

test('pickQuestion baraja las opciones y sabe cuál es la correcta', () => {
  for (let i = 0; i < 50; i++) {
    const q = pickQuestion('cine');
    const { text, answers } = QUESTIONS_BY_ID.get(q.id);
    assert.equal(q.text, text);
    assert.equal(q.options[q.correctIndex], answers[0]);
    assert.deepEqual([...q.options].sort(), [...answers].sort());
  }
});

test('pickQuestion no repite las de la partida y prefiere las nunca vistas', () => {
  const all = QUESTION_IDS.arte;
  assert.equal(pickQuestion('arte', new Set(all.slice(1))).id, all[0]);
  // Vistas todas menos una: sale esa.
  const seen = new Map(all.slice(1).map((id, i) => [id, i]));
  assert.equal(pickQuestion('arte', new Set(), seen).id, all[0]);
  // Vistas todas: sale una de las que vio hace más tiempo (el 25 % más antiguo).
  const allSeen = new Map(all.map((id, i) => [id, 1000 + i]));
  const oldest = new Set(all.slice(0, Math.ceil(all.length / 4)));
  for (let i = 0; i < 30; i++) assert.ok(oldest.has(pickQuestion('arte', new Set(), allSeen).id));
});

const fixed = (correctIndex) => ({ id: `ciencia:${correctIndex}`, category: 'ciencia', text: '¿?', options: ['a', 'b', 'c', 'd'], correctIndex });

function play(answers) {
  const round = new TriviaRound({ id: 1, userId: 1, bet: 100, now: 0 });
  let t = 0;
  for (const choice of answers) {
    round.spin(fixed(2), t);
    round.ask((t += 3_600));
    round.answer(choice, (t += 1_000));
  }
  return round;
}

test('una partida completa: cuenta aciertos y termina tras la octava', () => {
  const round = play([2, 2, 0, 2, 1, 2, 3, 2]);
  assert.equal(round.correct, 5);
  assert.equal(round.results.length, QUESTIONS);
  assert.equal(round.phase, 'finished');
  assert.throws(() => round.spin(fixed(0), 99_999));
});

test('la respuesta correcta no se envía hasta contestar', () => {
  const round = new TriviaRound({ id: 1, userId: 1, bet: 100, now: 0 });
  round.spin(fixed(3), 0);
  let snap = round.snapshot(10);
  assert.equal(snap.question, null); // girando: ni siquiera la pregunta
  assert.equal(snap.category, 'ciencia');
  round.ask(3_600);
  snap = round.snapshot(3_700);
  assert.deepEqual(snap.question.options, ['a', 'b', 'c', 'd']);
  assert.equal(snap.last, null);
  assert.ok(!JSON.stringify(snap).includes('correctIndex'));
  round.answer(1, 5_000);
  snap = round.snapshot(5_000);
  assert.deepEqual(snap.last, { choice: 1, correctIndex: 3, correct: false, timedOut: false });
});

test('fuera de tiempo cuenta como fallo, aunque acierte', () => {
  const round = new TriviaRound({ id: 1, userId: 1, bet: 100, now: 0 });
  round.spin(fixed(0), 0);
  round.ask(0);
  const result = round.answer(0, ANSWER_MS + GRACE_MS + 1);
  assert.equal(result.correct, false);
  assert.equal(result.timedOut, true);
});

test('no se puede responder dos veces ni sin pregunta', () => {
  const round = new TriviaRound({ id: 1, userId: 1, bet: 100, now: 0 });
  assert.throws(() => round.answer(0, 0));
  round.spin(fixed(0), 0);
  assert.throws(() => round.answer(0, 100)); // aún gira
  round.ask(3_600);
  round.answer(0, 4_000);
  assert.throws(() => round.answer(0, 4_100));
  assert.throws(() => round.ask(4_200) ?? round.answer(0, 4_300));
});

test('límite de apuesta por modo: Clásica 100.000, Tecnología 10.000', () => {
  const { MODES, config } = require('../src/trivia');
  const max = Object.fromEntries(MODES.map((m) => [m.id, m.max]));
  assert.deepEqual(max, { clasica: 100_000, tecnologia: 10_000 });
  assert.equal(config.min, 10);
});
