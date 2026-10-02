'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BANK = require('../src/trivia-questions');
const { TriviaRound, pickQuestion, payoutFor, multiplierFor, CATEGORIES, QUESTIONS, ANSWER_MS, GRACE_MS } = require('../src/trivia');

test('pagos: 5/5 ×3, 4/5 ×2, 3/5 ×1,5 y menos de 3 pierde', () => {
  assert.equal(payoutFor(1_000, 5), 3_000);
  assert.equal(payoutFor(1_000, 4), 2_000);
  assert.equal(payoutFor(1_000, 3), 1_500);
  for (const c of [0, 1, 2]) assert.equal(payoutFor(1_000, c), 0);
  assert.equal(payoutFor(15, 3), 22); // se redondea hacia abajo
  assert.equal(payoutFor(100_000, 5), 300_000);
  assert.equal(multiplierFor(3), 1.5);
});

test('banco: cada categoría tiene preguntas con 4 opciones distintas y no vacías', () => {
  for (const { id } of CATEGORIES) {
    assert.ok(BANK[id]?.length >= 20, `pocas preguntas en ${id}`);
    for (const [text, ...answers] of BANK[id]) {
      assert.ok(text.trim().endsWith('?'), text);
      assert.equal(answers.length, 4, text);
      assert.equal(new Set(answers.map((a) => a.toLowerCase())).size, 4, `opciones repetidas: ${text}`);
      assert.ok(answers.every((a) => a.trim()), text);
    }
  }
});

test('pickQuestion baraja las opciones y sabe cuál es la correcta', () => {
  for (let i = 0; i < 50; i++) {
    const q = pickQuestion('cine');
    const original = BANK.cine[Number(q.id.split(':')[1])];
    assert.equal(q.text, original[0]);
    assert.equal(q.options[q.correctIndex], original[1]);
    assert.deepEqual([...q.options].sort(), original.slice(1).sort());
  }
});

test('pickQuestion no repite las preguntas excluidas mientras queden otras', () => {
  const all = BANK.arte.map((_, i) => `arte:${i}`);
  const exclude = new Set(all.slice(1));
  assert.equal(pickQuestion('arte', exclude).id, 'arte:0');
  // Las recientes se evitan si se puede, pero no bloquean el juego.
  assert.equal(pickQuestion('arte', new Set(), new Set(all.slice(1))).id, 'arte:0');
  assert.ok(pickQuestion('arte', new Set(), new Set(all)).id.startsWith('arte:'));
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

test('una partida completa: cuenta aciertos y termina tras la quinta', () => {
  const round = play([2, 2, 0, 2, 1]);
  assert.equal(round.correct, 3);
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
