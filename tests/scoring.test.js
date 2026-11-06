import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeQuestions, normalizeTitle, validateQuestions } from "../js/questions.js";
import {
  GRACE_MS,
  buildResults,
  buildTop,
  computePoints,
  displayNames,
  publicQuestion,
  questionUpdate,
  rankPlayers,
  scoreRound,
} from "../js/scoring.js";

const validQuestion = () => ({
  text: "¿Pregunta?",
  options: ["a", "b", "c", "d"],
  correct: 1,
  timeLimit: 20,
  imageUrl: "",
});

test("los puntos bajan de 1000 a 500 con el tiempo", () => {
  assert.equal(computePoints(0, 20), 1000);
  assert.equal(computePoints(10000, 20), 750);
  assert.equal(computePoints(20000, 20), 500);
});

test("los puntos se mantienen en el rango aunque el tiempo se salga de él", () => {
  assert.equal(computePoints(-50, 20), 1000);
  assert.equal(computePoints(21000, 20), 500);
});

test("scoreRound puntúa solo aciertos y cuenta todos los votos válidos", () => {
  const round = scoreRound({
    answers: [
      { uid: "a", choice: 1, answeredAtMs: 1000 },
      { uid: "b", choice: 0, answeredAtMs: 1000 },
      { uid: "c", choice: 1, answeredAtMs: 11000 },
    ],
    correct: 1,
    startedAtMs: 1000,
    limitSeconds: 20,
    roster: new Set(["a", "b", "c"]),
    totals: { a: 100 },
  });
  assert.deepEqual(round.votes, [1, 2, 0, 0]);
  assert.deepEqual(round.gains, { a: 1000, c: 750 });
  assert.deepEqual(round.totals, { a: 1100, c: 750 });
});

test("scoreRound no modifica los totales recibidos", () => {
  const totals = { a: 100 };
  scoreRound({
    answers: [{ uid: "a", choice: 0, answeredAtMs: 0 }],
    correct: 0,
    startedAtMs: 0,
    limitSeconds: 10,
    totals,
  });
  assert.deepEqual(totals, { a: 100 });
});

test("scoreRound descarta respuestas anticipadas, tardías, ajenas o inválidas", () => {
  const limit = 10;
  const round = scoreRound({
    answers: [
      { uid: "antes", choice: 0, answeredAtMs: 999 },
      { uid: "tarde", choice: 0, answeredAtMs: 1000 + limit * 1000 + GRACE_MS + 1 },
      { uid: "ajeno", choice: 0, answeredAtMs: 2000 },
      { uid: "mala", choice: 7, answeredAtMs: 2000 },
    ],
    correct: 0,
    startedAtMs: 1000,
    limitSeconds: limit,
    roster: new Set(["antes", "tarde", "mala"]),
    totals: {},
  });
  assert.deepEqual(round.votes, [0, 0, 0, 0]);
  assert.deepEqual(round.gains, {});
});

test("una respuesta dentro del margen cuenta como 500 puntos", () => {
  const round = scoreRound({
    answers: [{ uid: "a", choice: 0, answeredAtMs: 10000 + GRACE_MS }],
    correct: 0,
    startedAtMs: 0,
    limitSeconds: 10,
    totals: {},
  });
  assert.equal(round.gains.a, 500);
});

test("los empates comparten posición y la siguiente se salta", () => {
  const ranking = rankPlayers({ a: 900, b: 900, c: 500 }, { a: "Ana", b: "Beto", c: "Ceci", d: "Dani" });
  assert.deepEqual(
    ranking.map((r) => [r.nick, r.score, r.rank]),
    [["Ana", 900, 1], ["Beto", 900, 1], ["Ceci", 500, 3], ["Dani", 0, 4]],
  );
});

test("results incluye a todos, también a quien no ganó puntos", () => {
  const ranking = rankPlayers({ a: 900 }, { a: "Ana", b: "Beto" });
  assert.deepEqual(buildResults(ranking, { a: 900 }), {
    a: { g: 900, s: 900, r: 1 },
    b: { g: 0, s: 0, r: 2 },
  });
});

test("el top se limita a 5", () => {
  const names = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((id) => [id, id]));
  assert.equal(buildTop(rankPlayers({}, names)).length, 5);
});

test("los apodos repetidos se distinguen sin importar mayúsculas", () => {
  const names = displayNames([
    { uid: "2", nick: "ana", joinedAtMs: 20 },
    { uid: "1", nick: "Ana", joinedAtMs: 10 },
    { uid: "3", nick: "Beto", joinedAtMs: 30 },
  ]);
  assert.deepEqual(names, { 1: "Ana", 2: "ana (2)", 3: "Beto" });
});

test("la respuesta correcta no sale nunca en la pregunta publicada", () => {
  const question = { ...validQuestion(), secreto: "x" };
  assert.deepEqual(Object.keys(publicQuestion(question)).sort(), ["options", "text", "timeLimit"]);

  const update = questionUpdate(question, 0, {
    serverTimestamp: () => "SERVER",
    deleteField: () => "DELETE",
  });
  assert.equal(update.correct, "DELETE");
  assert.equal(update.question.correct, undefined);
});

test("publicQuestion conserva la imagen cuando existe", () => {
  const question = { ...validQuestion(), imageUrl: "https://example.com/a.png" };
  assert.equal(publicQuestion(question).imageUrl, "https://example.com/a.png");
});

test("el set de ejemplo tiene 10 preguntas válidas", () => {
  const raw = readFileSync(new URL("../data/ejemplo.json", import.meta.url), "utf8");
  const questions = normalizeQuestions(JSON.parse(raw));
  assert.equal(questions.length, 10);
  assert.deepEqual(validateQuestions(questions), []);
});

test("la validación detecta cada tipo de error", () => {
  const cases = [
    [{ text: "" }, "falta el texto"],
    [{ options: ["a", "b", "c"] }, "4 opciones"],
    [{ options: ["a", "", "c", "d"] }, "opciones vacías"],
    [{ correct: 4 }, "índice de 0 a 3"],
    [{ correct: undefined }, "índice de 0 a 3"],
    [{ timeLimit: 2 }, "tiempo"],
    [{ imageUrl: "http://example.com/a.png" }, "https"],
    [{ imageUrl: "javascript:alert(1)" }, "https"],
  ];
  for (const [override, expected] of cases) {
    const errors = validateQuestions([{ ...validQuestion(), ...override }]);
    assert.ok(errors.some((e) => e.includes(expected)), `${JSON.stringify(override)}: ${errors}`);
  }
  assert.deepEqual(validateQuestions([validQuestion()]), []);
  assert.ok(validateQuestions([]).length > 0);
});

test("normalizeQuestions acepta lista u objeto y rechaza otras formas", () => {
  assert.equal(normalizeQuestions([validQuestion()]).length, 1);
  assert.equal(normalizeQuestions({ questions: [validQuestion()] }).length, 1);
  assert.throws(() => normalizeQuestions({ preguntas: [] }));
});

test("el nombre de la trivia es opcional, se recorta y se limita a 60 caracteres", () => {
  assert.equal(normalizeTitle({ title: "  Fin de año  ", questions: [] }), "Fin de año");
  assert.equal(normalizeTitle({ questions: [] }), "");
  assert.equal(normalizeTitle([validQuestion()]), "");
  assert.equal(normalizeTitle({ title: 42 }), "");
  assert.equal(normalizeTitle({ title: "x".repeat(80) }).length, 60);
});
