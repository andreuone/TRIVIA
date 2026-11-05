// Simula una partida completa contra el emulador, con un cliente real por jugador y las
// reglas activas, y cuenta las lecturas y escrituras que cobraría Firestore.
// Uso: npm run test:load (o: node tests/load-bots.js --players=250 --questions=16 --limit=4)
import { deleteApp, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInAnonymously } from "firebase/auth";
import {
  collection,
  connectFirestoreEmulator,
  deleteField,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  GRACE_MS,
  buildResults,
  buildTop,
  displayNames,
  endUpdate,
  questionUpdate,
  rankPlayers,
  revealUpdate,
  scoreRound,
} from "../js/scoring.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")),
);
const PLAYERS = Number(args.players ?? 250);
const QUESTIONS = Number(args.questions ?? 16);
const LIMIT_SECONDS = Number(args.limit ?? 4);
const JOIN_CONCURRENCY = 25;
const ACK_TIMEOUT_MS = 30000;
const DAILY_READS = 50000;
const DAILY_WRITES = 20000;

const fv = { serverTimestamp, deleteField };
const PIN = String(100000 + Math.floor(Math.random() * 900000));

const reads = { playersState: 0, join: 0, hostStartedAt: 0, hostRoster: 0, hostAnswers: 0 };
const writes = { state: 0, join: 0, answers: 0, scores: 0 };
const failures = [];
const latencies = [];
let appCounter = 0;

function client() {
  const app = initializeApp({ apiKey: "demo", projectId: "demo-trivia" }, `app-${(appCounter += 1)}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  return { app, auth, db };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition, timeoutMs, label) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      failures.push(`Tiempo agotado: ${label}`);
      return false;
    }
    await sleep(25);
  }
  return true;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

/* ---------- Bots ---------- */

const correctByQuestion = Array.from({ length: QUESTIONS }, (_, i) => i % 4);
const ackedAnswers = Array.from({ length: QUESTIONS }, () => []);
const closedRounds = [];
const writeLatencies = [];
const seenPhase = new Map();
let phaseSentAt = 0;

function createBot(index) {
  const bot = { index, nick: `Bot ${index}`, ...client(), uid: null, unsubscribe: null, lastResults: null };

  bot.join = async () => {
    const credential = await signInAnonymously(bot.auth);
    bot.uid = credential.user.uid;
    const gameSnap = await getDoc(doc(bot.db, "games", PIN));
    reads.join += 1;
    const { hostUid } = gameSnap.data();

    await setDoc(doc(bot.db, "games", PIN, "players", bot.uid), {
      nick: bot.nick,
      hostUid,
      score: 0,
      joinedAt: serverTimestamp(),
    });
    writes.join += 1;

    let lastKey = null;
    bot.unsubscribe = onSnapshot(doc(bot.db, "games", PIN), (snapshot) => {
      reads.playersState += 1;
      const game = snapshot.data();
      const key = `${game.phase}:${game.qIndex}`;
      if (key === lastKey) return;
      lastKey = key;
      seenPhase.set(key, (seenPhase.get(key) ?? 0) + 1);
      if (game.phase !== "lobby") latencies.push(Date.now() - phaseSentAt);

      if (game.phase !== "reveal" && "correct" in game) {
        failures.push(`Filtración: ${bot.nick} vio la correcta en la fase ${game.phase}`);
      }
      if (game.phase === "question") {
        if (JSON.stringify(game.question).includes('"correct"')) {
          failures.push(`Filtración: la pregunta ${game.qIndex} incluye la correcta`);
        }
        bot.answer(game);
      }
      if (game.results) bot.lastResults = game.results[bot.uid];
    });
  };

  bot.answer = async ({ qIndex, hostUid }) => {
    // Un 5 % no responde y el resto acierta un 60 % de las veces.
    if (Math.random() < 0.05) return;
    const correct = correctByQuestion[qIndex];
    const choice = Math.random() < 0.6 ? correct : (correct + 1 + Math.floor(Math.random() * 3)) % 4;
    await sleep(100 + Math.random() * (LIMIT_SECONDS * 800));
    try {
      const sentAt = Date.now();
      await setDoc(doc(bot.db, "games", PIN, "answers", `${qIndex}_${bot.uid}`), {
        qIndex,
        uid: bot.uid,
        hostUid,
        choice,
        answeredAt: serverTimestamp(),
      });
      writes.answers += 1;
      const ackedAt = Date.now();
      writeLatencies.push(ackedAt - sentAt);
      ackedAnswers[qIndex].push({ uid: bot.uid, ackedAt });
    } catch (error) {
      failures.push(`${bot.nick} no pudo responder la pregunta ${qIndex}: ${error.code}`);
    }
  };

  return bot;
}

async function joinInBatches(bots) {
  for (let i = 0; i < bots.length; i += JOIN_CONCURRENCY) {
    await Promise.all(bots.slice(i, i + JOIN_CONCURRENCY).map((bot) => bot.join()));
    process.stdout.write(`\r  Jugadores dentro: ${Math.min(i + JOIN_CONCURRENCY, bots.length)}/${bots.length}`);
  }
  process.stdout.write("\n");
}

/* ---------- Anfitrión: mismas escrituras y mismos cálculos que js/host.js ---------- */

async function publish(gameRef, update) {
  phaseSentAt = Date.now();
  await updateDoc(gameRef, update);
  writes.state += 1;
}

async function run() {
  const startedRunAt = Date.now();
  console.log(`Simulando ${PLAYERS} jugadores, ${QUESTIONS} preguntas, ${LIMIT_SECONDS} s por pregunta (PIN ${PIN})`);

  const host = client();
  const hostUid = (await signInAnonymously(host.auth)).user.uid;
  const gameRef = doc(host.db, "games", PIN);
  await setDoc(gameRef, { hostUid, phase: "lobby", qIndex: -1, qTotal: QUESTIONS, createdAt: serverTimestamp() });
  writes.state += 1;

  const roster = new Map();
  const unsubscribeRoster = onSnapshot(
    query(collection(gameRef, "players"), where("hostUid", "==", hostUid)),
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        reads.hostRoster += 1;
        const data = change.doc.data();
        roster.set(change.doc.id, {
          uid: change.doc.id,
          nick: data.nick,
          joinedAtMs: data.joinedAt?.toMillis() ?? Date.now(),
        });
      }
    },
  );

  const bots = Array.from({ length: PLAYERS }, (_, i) => createBot(i));
  await joinInBatches(bots);
  await waitUntil(() => roster.size === PLAYERS, ACK_TIMEOUT_MS, "alta de jugadores en el anfitrión");

  let totals = {};
  const names = displayNames([...roster.values()]);

  for (let qIndex = 0; qIndex < QUESTIONS; qIndex += 1) {
    const question = {
      text: `Pregunta ${qIndex + 1}`,
      options: ["A", "B", "C", "D"],
      correct: correctByQuestion[qIndex],
      timeLimit: LIMIT_SECONDS,
    };

    const answers = new Map();
    const unsubscribeAnswers = onSnapshot(
      query(collection(gameRef, "answers"), where("qIndex", "==", qIndex), where("hostUid", "==", hostUid)),
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          reads.hostAnswers += 1;
          const data = change.doc.data();
          answers.set(data.uid, { uid: data.uid, choice: data.choice, answeredAtMs: data.answeredAt.toMillis() });
        }
      },
      (error) => failures.push(`Listener de respuestas: ${error.code}`),
    );

    await publish(gameRef, questionUpdate(question, qIndex, fv));
    const started = await getDocFromServer(gameRef);
    reads.hostStartedAt += 1;
    const startedAtMs = started.data().startedAt.toMillis();
    await waitUntil(() => seenPhase.get(`question:${qIndex}`) === PLAYERS, ACK_TIMEOUT_MS, `pregunta ${qIndex} a todos`);

    await sleep(LIMIT_SECONDS * 1000 + GRACE_MS);
    unsubscribeAnswers();
    closedRounds[qIndex] = { closedAt: Date.now(), received: new Set(answers.keys()) };

    const round = scoreRound({
      answers: [...answers.values()],
      correct: question.correct,
      startedAtMs,
      limitSeconds: LIMIT_SECONDS,
      roster,
      totals,
    });
    totals = round.totals;
    const ranking = rankPlayers(totals, names);
    await publish(
      gameRef,
      revealUpdate({
        correct: question.correct,
        votes: round.votes,
        top5: buildTop(ranking),
        results: buildResults(ranking, round.gains),
      }),
    );
    await waitUntil(() => seenPhase.get(`reveal:${qIndex}`) === PLAYERS, ACK_TIMEOUT_MS, `resultado ${qIndex} a todos`);

    for (const bot of bots) {
      if ((bot.lastResults?.s ?? -1) !== (totals[bot.uid] ?? 0)) {
        failures.push(`${bot.nick} recibió un total incorrecto en la pregunta ${qIndex}`);
      }
    }
    const scored = round.votes.reduce((sum, n) => sum + n, 0);
    console.log(`  Pregunta ${qIndex + 1}/${QUESTIONS}: ${answers.size} respuestas recibidas, ${scored} válidas`);
    if (scored !== answers.size) failures.push(`Pregunta ${qIndex}: se descartaron respuestas a tiempo`);
  }

  unsubscribeRoster();
  const finalRanking = rankPlayers(totals, names);
  await publish(gameRef, endUpdate({ top5: buildTop(finalRanking), results: buildResults(finalRanking, {}) }, fv));
  await waitUntil(() => seenPhase.get(`end:${QUESTIONS - 1}`) === PLAYERS, ACK_TIMEOUT_MS, "final a todos");

  const entries = Object.entries(totals).filter(([, score]) => score > 0);
  for (let i = 0; i < entries.length; i += 400) {
    const batch = writeBatch(host.db);
    for (const [uid, score] of entries.slice(i, i + 400)) {
      batch.update(doc(gameRef, "players", uid), { score });
      writes.scores += 1;
    }
    await batch.commit();
  }

  // Verificación final; estas lecturas son del test y no cuentan en el total.
  const playersSnap = await getDocs(query(collection(gameRef, "players"), where("hostUid", "==", hostUid)));
  for (const player of playersSnap.docs) {
    if (player.data().score !== (totals[player.id] ?? 0)) {
      failures.push(`Puntaje guardado incorrecto para ${player.data().nick}`);
    }
  }
  if (playersSnap.size !== PLAYERS) failures.push(`Hay ${playersSnap.size} jugadores en vez de ${PLAYERS}`);

  // Una respuesta confirmada mucho antes del cierre que el anfitrión no vio se perdió de verdad.
  // Las confirmadas justo al cierre, o después, simplemente llegaron tarde.
  let lateAnswers = 0;
  ackedAnswers.forEach((acked, qIndex) => {
    const { closedAt, received } = closedRounds[qIndex];
    for (const { uid, ackedAt } of acked) {
      if (received.has(uid)) continue;
      if (closedAt - ackedAt > 1000) failures.push(`Respuesta perdida en la pregunta ${qIndex}`);
      else lateAnswers += 1;
    }
  });

  /* ---------- Informe ---------- */

  const sortedWrites = [...writeLatencies].sort((a, b) => a - b);
  console.log(`Confirmación de respuestas: p50 ${percentile(sortedWrites, 0.5)} ms, p95 ${percentile(sortedWrites, 0.95)} ms, máx. ${sortedWrites.at(-1)} ms`);
  console.log(`Respuestas que llegaron tarde al cierre: ${lateAnswers}`);

  const totalReads = Object.values(reads).reduce((a, b) => a + b, 0);
  const totalWrites = Object.values(writes).reduce((a, b) => a + b, 0);
  const sorted = [...latencies].sort((a, b) => a - b);
  const gamesPerDay = Math.floor(Math.min(DAILY_READS / totalReads, DAILY_WRITES / totalWrites));

  console.log("\nLecturas");
  console.table(reads);
  console.log("Escrituras");
  console.table(writes);
  console.log(`Total: ${totalReads} lecturas, ${totalWrites} escrituras`);
  console.log(`Partidas completas al día dentro de la cuota gratuita: ${gamesPerDay}`);
  console.log(`Latencia de difusión a los jugadores: p50 ${percentile(sorted, 0.5)} ms, p95 ${percentile(sorted, 0.95)} ms, máx. ${sorted.at(-1)} ms`);
  console.log(`Duración de la simulación: ${Math.round((Date.now() - startedRunAt) / 1000)} s`);
  console.log("Nota: es un recuento en el cliente, sin reconexiones; el cobro real puede ser algo mayor.");

  for (const bot of bots) bot.unsubscribe?.();
  await Promise.allSettled([host.app, ...bots.map((b) => b.app)].map((app) => deleteApp(app)));

  if (failures.length > 0) {
    console.error(`\nFALLÓ con ${failures.length} problemas:`);
    for (const failure of [...new Set(failures)].slice(0, 20)) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nOK: sin filtraciones de la respuesta y con todos los puntajes correctos.");
  process.exit(0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
