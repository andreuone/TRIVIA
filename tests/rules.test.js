// Se ejecuta contra el emulador: npm run test:rules
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

const PIN = "123456";
const HOST = "host-uid";
const ANA = "ana-uid";
const BETO = "beto-uid";

let env;
const dbAs = (uid) => env.authenticatedContext(uid).firestore();
const anonymousDb = () => env.unauthenticatedContext().firestore();

const lobbyGame = (hostUid = HOST) => ({ hostUid, phase: "lobby", qIndex: -1, qTotal: 3 });
const newPlayer = (overrides = {}) => ({
  nick: "Ana",
  hostUid: HOST,
  score: 0,
  joinedAt: serverTimestamp(),
  ...overrides,
});
const newAnswer = (overrides = {}) => ({
  qIndex: 0,
  uid: ANA,
  hostUid: HOST,
  choice: 2,
  answeredAt: serverTimestamp(),
  ...overrides,
});

// Prepara datos saltándose las reglas.
async function seed(path, data) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), path), data);
  });
}

const gamePath = `games/${PIN}`;
const playerPath = (uid) => `${gamePath}/players/${uid}`;
const answerPath = (id) => `${gamePath}/answers/${id}`;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-trivia",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

describe("games", () => {
  test("el anfitrión crea su partida", async () => {
    await assertSucceeds(setDoc(doc(dbAs(HOST), gamePath), lobbyGame()));
  });

  test("no se crea a nombre de otro, sin sesión, con PIN inválido ni con la correcta", async () => {
    await assertFails(setDoc(doc(dbAs(ANA), gamePath), lobbyGame(HOST)));
    await assertFails(setDoc(doc(anonymousDb(), gamePath), lobbyGame()));
    await assertFails(setDoc(doc(dbAs(HOST), "games/abc"), lobbyGame()));
    await assertFails(setDoc(doc(dbAs(HOST), gamePath), { ...lobbyGame(), correct: 1 }));
  });

  test("un PIN ocupado no se puede reutilizar", async () => {
    await seed(gamePath, lobbyGame());
    await assertFails(setDoc(doc(dbAs(ANA), gamePath), lobbyGame(ANA)));
  });

  test("el anfitrión no puede pisar con una sala nueva una partida ya jugada", async () => {
    await seed(gamePath, { ...lobbyGame(), phase: "end" });
    await assertFails(setDoc(doc(dbAs(HOST), gamePath), lobbyGame()));
  });

  test("solo el creador escribe", async () => {
    await seed(gamePath, lobbyGame());
    await assertSucceeds(updateDoc(doc(dbAs(HOST), gamePath), { phase: "question", qIndex: 0 }));
    await assertFails(updateDoc(doc(dbAs(ANA), gamePath), { qIndex: 1 }));
    await assertFails(updateDoc(doc(anonymousDb(), gamePath), { qIndex: 1 }));
  });

  test("el creador no puede cederse la partida ni usar una fase desconocida", async () => {
    await seed(gamePath, lobbyGame());
    await assertFails(updateDoc(doc(dbAs(HOST), gamePath), { hostUid: ANA }));
    await assertFails(updateDoc(doc(dbAs(HOST), gamePath), { phase: "pausa" }));
  });

  test("la respuesta correcta solo puede estar en la fase reveal", async () => {
    await seed(gamePath, { ...lobbyGame(), phase: "question" });
    const ref = doc(dbAs(HOST), gamePath);
    await assertFails(updateDoc(ref, { correct: 1 }));
    await assertSucceeds(updateDoc(ref, { phase: "reveal", correct: 1 }));
    await assertFails(updateDoc(ref, { phase: "question" }));
    await assertFails(updateDoc(ref, { phase: "end" }));
  });

  test("cualquiera con sesión lee, nadie sin sesión", async () => {
    await seed(gamePath, lobbyGame());
    await assertSucceeds(getDoc(doc(dbAs(ANA), gamePath)));
    await assertFails(getDoc(doc(anonymousDb(), gamePath)));
  });

  test("nadie borra", async () => {
    await seed(gamePath, lobbyGame());
    await assertFails(deleteDoc(doc(dbAs(HOST), gamePath)));
  });
});

describe("players", () => {
  beforeEach(async () => {
    await seed(gamePath, lobbyGame());
  });

  test("un jugador crea su propio documento", async () => {
    await assertSucceeds(setDoc(doc(dbAs(ANA), playerPath(ANA)), newPlayer()));
  });

  test("no se crea para otro, con puntos, con apodo inválido ni con campos extra", async () => {
    const ref = doc(dbAs(ANA), playerPath(ANA));
    await assertFails(setDoc(doc(dbAs(ANA), playerPath(BETO)), newPlayer()));
    await assertFails(setDoc(ref, newPlayer({ score: 5000 })));
    await assertFails(setDoc(ref, newPlayer({ nick: "" })));
    await assertFails(setDoc(ref, newPlayer({ nick: "x".repeat(21) })));
    await assertFails(setDoc(ref, newPlayer({ admin: true })));
    await assertFails(setDoc(ref, newPlayer({ joinedAt: Timestamp.fromMillis(0) })));
  });

  test("el jugador edita su apodo, pero no su puntaje ni su anfitrión", async () => {
    await seed(playerPath(ANA), newPlayer());
    const ref = doc(dbAs(ANA), playerPath(ANA));
    await assertSucceeds(updateDoc(ref, { nick: "Anita" }));
    await assertFails(updateDoc(ref, { score: 9999 }));
    await assertFails(updateDoc(ref, { hostUid: ANA }));
  });

  test("otro jugador no edita ni lee un documento ajeno", async () => {
    await seed(playerPath(ANA), newPlayer());
    await assertFails(updateDoc(doc(dbAs(BETO), playerPath(ANA)), { nick: "Troll" }));
    await assertFails(getDoc(doc(dbAs(BETO), playerPath(ANA))));
  });

  test("el anfitrión escribe el puntaje, pero no el apodo", async () => {
    await seed(playerPath(ANA), newPlayer());
    const ref = doc(dbAs(HOST), playerPath(ANA));
    await assertSucceeds(updateDoc(ref, { score: 2500 }));
    await assertFails(updateDoc(ref, { nick: "Otro" }));
    await assertFails(updateDoc(ref, { score: -1 }));
  });

  test("solo el anfitrión lista, y solo filtrando por su uid", async () => {
    await seed(playerPath(ANA), newPlayer());
    const players = (db) => collection(db, gamePath, "players");
    const byHost = (db, uid) => query(players(db), where("hostUid", "==", uid));

    const result = await assertSucceeds(getDocs(byHost(dbAs(HOST), HOST)));
    assert.equal(result.size, 1);
    await assertFails(getDocs(players(dbAs(HOST))));
    await assertFails(getDocs(players(dbAs(BETO))));
    await assertFails(getDocs(byHost(dbAs(BETO), HOST)));
  });

  test("nadie borra", async () => {
    await seed(playerPath(ANA), newPlayer());
    await assertFails(deleteDoc(doc(dbAs(ANA), playerPath(ANA))));
    await assertFails(deleteDoc(doc(dbAs(HOST), playerPath(ANA))));
  });
});

describe("answers", () => {
  const id = `0_${ANA}`;

  beforeEach(async () => {
    await seed(gamePath, lobbyGame());
  });

  test("un jugador responde una vez", async () => {
    const ref = doc(dbAs(ANA), answerPath(id));
    await assertSucceeds(setDoc(ref, newAnswer()));
    await assertFails(setDoc(ref, newAnswer({ choice: 1 })));
  });

  test("puede responder a otra pregunta", async () => {
    await assertSucceeds(setDoc(doc(dbAs(ANA), answerPath(id)), newAnswer()));
    await assertSucceeds(setDoc(doc(dbAs(ANA), answerPath(`1_${ANA}`)), newAnswer({ qIndex: 1 })));
  });

  test("no se responde a nombre de otro ni con un ID que no corresponda", async () => {
    await assertFails(setDoc(doc(dbAs(BETO), answerPath(id)), newAnswer()));
    await assertFails(setDoc(doc(dbAs(BETO), answerPath(`0_${BETO}`)), newAnswer()));
    await assertFails(setDoc(doc(dbAs(ANA), answerPath(`1_${ANA}`)), newAnswer()));
    await assertFails(setDoc(doc(dbAs(ANA), answerPath("cualquiera")), newAnswer()));
  });

  test("no se acepta una opción inválida ni un campo extra", async () => {
    const ref = doc(dbAs(ANA), answerPath(id));
    await assertFails(setDoc(ref, newAnswer({ choice: 4 })));
    await assertFails(setDoc(ref, newAnswer({ choice: -1 })));
    await assertFails(setDoc(ref, newAnswer({ choice: 1.5 })));
    await assertFails(setDoc(ref, newAnswer({ extra: 1 })));
  });

  test("el jugador no puede elegir su propio timestamp", async () => {
    const ref = doc(dbAs(ANA), answerPath(id));
    await assertFails(setDoc(ref, newAnswer({ answeredAt: Timestamp.fromMillis(0) })));
  });

  test("una respuesta no se edita ni se borra", async () => {
    await seed(answerPath(id), { ...newAnswer(), answeredAt: Timestamp.now() });
    const ref = doc(dbAs(ANA), answerPath(id));
    await assertFails(updateDoc(ref, { choice: 1 }));
    await assertFails(deleteDoc(ref));
    await assertFails(deleteDoc(doc(dbAs(HOST), answerPath(id))));
  });

  test("solo el anfitrión lee las respuestas", async () => {
    await seed(answerPath(id), { ...newAnswer(), answeredAt: Timestamp.now() });
    const answers = (db) => collection(db, gamePath, "answers");
    const round = (db, uid) =>
      query(answers(db), where("qIndex", "==", 0), where("hostUid", "==", uid));

    const result = await assertSucceeds(getDocs(round(dbAs(HOST), HOST)));
    assert.equal(result.size, 1);
    await assertFails(getDocs(answers(dbAs(ANA))));
    await assertFails(getDocs(round(dbAs(ANA), HOST)));
    await assertFails(getDoc(doc(dbAs(ANA), answerPath(id))));
  });
});

test("cualquier otra ruta está cerrada", async () => {
  await assertFails(setDoc(doc(dbAs(ANA), "otra/cosa"), { a: 1 }));
  await assertFails(getDoc(doc(dbAs(ANA), "otra/cosa")));
});
