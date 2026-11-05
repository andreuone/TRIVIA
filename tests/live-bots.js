// Bots que se unen a una partida real creada desde host.html, para probar con Firebase real.
//
// Uso, desde la carpeta tests:
//   node live-bots.js --pin=123456 --players=200
//
// Opciones:
//   --pin=NNNNNN     PIN de la partida (obligatorio). Créala antes desde host.html.
//   --players=200    Cuántos bots unir.
//   --emulator       Usar el emulador local en vez de tu proyecto real.
//
// Las cuentas anónimas de los bots se guardan en tests/.bot-accounts.json (excluido de git)
// y se reutilizan en cada ejecución. Así solo se crean cuentas nuevas la primera vez,
// lo que importa porque Firebase limita las cuentas nuevas por hora desde una misma IP.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, initializeAuth, signInAnonymously } from "firebase/auth";
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { emulator as emulatorConfig, firebaseConfig } from "../firebase-config.js";

/* ---------- Opciones ---------- */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [key, value] = a.replace(/^--/, "").split("=");
    return [key, value ?? true];
  }),
);
const PIN = String(args.pin ?? "");
const PLAYERS = Number(args.players ?? 200);
const USE_EMULATOR = Boolean(args.emulator);
const JOIN_CONCURRENCY = 10;

if (!/^\d{6}$/.test(PIN)) {
  console.error("Falta el PIN. Crea la partida en host.html y ejecuta: node live-bots.js --pin=123456");
  process.exit(1);
}
if (!USE_EMULATOR && firebaseConfig.apiKey.startsWith("TU_")) {
  console.error("firebase-config.js todavía tiene los valores de ejemplo.");
  process.exit(1);
}

const config = USE_EMULATOR
  ? {
      apiKey: "demo",
      projectId: emulatorConfig.projectId,
      authDomain: `${emulatorConfig.projectId}.firebaseapp.com`,
    }
  : firebaseConfig;

/* ---------- Cuentas guardadas ---------- */

const ACCOUNTS_FILE = new URL(
  USE_EMULATOR ? "./.bot-accounts.emulator.json" : "./.bot-accounts.json",
  import.meta.url,
);
const accountStore = existsSync(ACCOUNTS_FILE) ? JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8")) : {};
let saveTimer = null;

function saveAccountsNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const temp = new URL(`${ACCOUNTS_FILE.href}.tmp`);
  writeFileSync(temp, JSON.stringify(accountStore));
  renameSync(temp, ACCOUNTS_FILE);
}

function saveAccountsSoon() {
  if (!saveTimer) saveTimer = setTimeout(saveAccountsNow, 500);
}

// Persistencia en archivo para el SDK de Auth en Node. Cada bot es una app con nombre
// propio, así que el SDK guarda su sesión bajo una clave distinta.
class FilePersistence {
  static type = "LOCAL";
  type = "LOCAL";
  async _isAvailable() {
    return true;
  }
  async _set(key, value) {
    accountStore[key] = value;
    saveAccountsSoon();
  }
  async _get(key) {
    return accountStore[key] ?? null;
  }
  async _remove(key) {
    delete accountStore[key];
    saveAccountsSoon();
  }
  _addListener() {}
  _removeListener() {}
}

/* ---------- Medidas ---------- */

const stats = {
  newAccounts: 0,
  reusedAccounts: 0,
  joined: 0,
  joinFailures: {},
  reads: 0,
  writes: 0,
};
const rounds = new Map();
let stopCreatingAccounts = false;
let finished = false;

function round(qIndex) {
  if (!rounds.has(qIndex)) {
    rounds.set(qIndex, {
      arrivals: [],
      sent: 0,
      failed: 0,
      ackTimes: [],
      votesCounted: null,
      correctButZero: 0,
      revealArrivals: 0,
    });
  }
  return rounds.get(qIndex);
}

const percentile = (values, p) => {
  if (values.length === 0) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- Bots ---------- */

function createBot(index) {
  const number = String(index + 1).padStart(3, "0");
  const app = initializeApp(config, `bot-${number}`);
  const auth = initializeAuth(app, { persistence: FilePersistence });
  const db = getFirestore(app);
  if (USE_EMULATOR) {
    connectAuthEmulator(auth, `http://${emulatorConfig.host}:${emulatorConfig.authPort}`, {
      disableWarnings: true,
    });
    connectFirestoreEmulator(db, emulatorConfig.host, emulatorConfig.firestorePort);
  }
  return { nick: `Bot ${number}`, app, auth, db, uid: null, answered: new Set(), choices: new Map() };
}

async function signIn(bot) {
  await bot.auth.authStateReady();
  if (bot.auth.currentUser) {
    stats.reusedAccounts += 1;
    return bot.auth.currentUser.uid;
  }
  if (stopCreatingAccounts) throw Object.assign(new Error("límite"), { code: "auth/too-many-requests" });
  const credential = await signInAnonymously(bot.auth);
  stats.newAccounts += 1;
  return credential.user.uid;
}

async function join(bot) {
  try {
    bot.uid = await signIn(bot);
    const gameRef = doc(bot.db, "games", PIN);
    const gameSnap = await getDoc(gameRef);
    stats.reads += 1;
    if (!gameSnap.exists()) throw Object.assign(new Error("no existe"), { code: "partida-inexistente" });
    const { hostUid, phase } = gameSnap.data();
    if (phase === "end") throw Object.assign(new Error("terminada"), { code: "partida-terminada" });

    const playerRef = doc(bot.db, "games", PIN, "players", bot.uid);
    try {
      await setDoc(playerRef, { nick: bot.nick, hostUid, score: 0, joinedAt: serverTimestamp() });
    } catch (error) {
      // Ya estaba en esta partida de una ejecución anterior.
      if (error.code !== "permission-denied") throw error;
      await updateDoc(playerRef, { nick: bot.nick });
    }
    stats.writes += 1;
    stats.joined += 1;
    listen(bot, gameRef);
  } catch (error) {
    const code = error.code ?? error.message;
    stats.joinFailures[code] = (stats.joinFailures[code] ?? 0) + 1;
    if (code === "auth/too-many-requests") stopCreatingAccounts = true;
  }
}

function listen(bot, gameRef) {
  let lastKey = null;
  bot.unsubscribe = onSnapshot(
    gameRef,
    (snapshot) => {
      stats.reads += 1;
      const game = snapshot.data();
      const key = `${game.phase}:${game.qIndex}`;
      if (key === lastKey) return;
      lastKey = key;

      if (game.phase === "question") {
        // Se compara con el primer bot en recibirla, no con la hora del servidor, porque el
        // reloj del ordenador puede ir desfasado unas decenas de milisegundos.
        round(game.qIndex).arrivals.push(Date.now());
        answer(bot, game);
      } else if (game.phase === "reveal") {
        const r = round(game.qIndex);
        r.revealArrivals += 1;
        r.votesCounted = game.votes.reduce((sum, n) => sum + n, 0);
        const mine = game.results?.[bot.uid];
        if (bot.choices.get(game.qIndex) === game.correct && mine && mine.g === 0) r.correctButZero += 1;
      } else if (game.phase === "end") {
        bot.unsubscribe();
        bot.done = true;
      }
    },
    (error) => {
      stats.joinFailures[`escucha: ${error.code}`] = (stats.joinFailures[`escucha: ${error.code}`] ?? 0) + 1;
    },
  );
}

async function answer(bot, game) {
  const { qIndex, hostUid } = game;
  if (bot.answered.has(qIndex)) return;
  bot.answered.add(qIndex);

  // Responden en un momento aleatorio entre el 10 % y el 80 % del tiempo; un 5 % no responde.
  if (Math.random() < 0.05) return;
  const limitMs = game.question.timeLimit * 1000;
  await sleep(limitMs * (0.1 + Math.random() * 0.7));

  const choice = Math.floor(Math.random() * 4);
  bot.choices.set(qIndex, choice);
  const r = round(qIndex);
  r.sent += 1;
  const sentAt = Date.now();
  try {
    await setDoc(doc(bot.db, "games", PIN, "answers", `${qIndex}_${bot.uid}`), {
      qIndex,
      uid: bot.uid,
      hostUid,
      choice,
      answeredAt: serverTimestamp(),
    });
    stats.writes += 1;
    r.ackTimes.push(Date.now() - sentAt);
  } catch {
    r.failed += 1;
  }
}

/* ---------- Informe ---------- */

function report() {
  console.log("\n=== Resumen ===");
  console.log(`Bots dentro: ${stats.joined} de ${PLAYERS}`);
  console.log(`Cuentas: ${stats.newAccounts} nuevas, ${stats.reusedAccounts} reutilizadas`);
  const failures = Object.entries(stats.joinFailures);
  if (failures.length > 0) {
    console.log("No pudieron entrar o escuchar:");
    for (const [code, count] of failures) {
      const hint =
        code === "auth/too-many-requests"
          ? " (límite de cuentas nuevas por IP; vuelve a ejecutar en una hora y se reutilizarán las ya creadas)"
          : "";
      console.log(`  ${code}: ${count}${hint}`);
    }
  }

  const rows = [...rounds.entries()]
    .sort(([a], [b]) => a - b)
    .map(([qIndex, r]) => {
      const first = Math.min(...r.arrivals);
      const delays = r.arrivals.map((t) => t - first);
      return {
        Pregunta: qIndex + 1,
        "Bots que la recibieron": r.arrivals.length,
        "Retraso p95 (ms)": percentile(delays, 0.95),
        "Retraso máx. (ms)": delays.length > 0 ? Math.max(...delays) : "-",
        "Respuestas enviadas": r.sent,
        Fallidas: r.failed,
        "Confirmación p95 (ms)": percentile(r.ackTimes, 0.95),
        "Votos contados": r.votesCounted ?? "-",
        "Aciertos sin puntos": r.correctButZero,
      };
    });
  if (rows.length > 0) {
    console.log("\nPor pregunta:");
    console.table(rows);
    console.log("Retraso: cuánto después del primer bot recibió la pregunta cada uno de los demás.");
    console.log("Votos contados incluye a los jugadores humanos. Si es menor que las respuestas enviadas,");
    console.log(
      "algunas llegaron tarde. Aciertos sin puntos: respuestas correctas que llegaron fuera de tiempo.",
    );
  }

  console.log(`\nLecturas de los bots: ${stats.reads}. Escrituras de los bots: ${stats.writes}.`);
  console.log("No incluye lo que gasta el anfitrión; el total aproximado está en docs/estimacion-cuota.md.");
}

/* ---------- Ejecución ---------- */

async function main() {
  console.log(
    `Uniendo ${PLAYERS} bots a la partida ${PIN} en ${USE_EMULATOR ? "el emulador" : `el proyecto ${config.projectId}`}…`,
  );
  const bots = Array.from({ length: PLAYERS }, (_, i) => createBot(i));

  for (let i = 0; i < bots.length; i += JOIN_CONCURRENCY) {
    await Promise.all(bots.slice(i, i + JOIN_CONCURRENCY).map(join));
    process.stdout.write(`\r  Dentro: ${stats.joined}/${PLAYERS}`);
  }
  saveAccountsNow();
  process.stdout.write("\n");

  if (stats.joined === 0) {
    report();
    process.exit(1);
  }
  console.log("Bots listos. Empieza la partida en host.html; responderán solos.");
  console.log("Al llegar al podio se mostrará el resumen. Ctrl+C para salir antes.");

  const joinedBots = bots.filter((b) => b.unsubscribe);
  while (!joinedBots.every((b) => b.done)) await sleep(500);
  finish(0);
}

function finish(code) {
  if (finished) return;
  finished = true;
  saveAccountsNow();
  report();
  process.exit(code);
}

process.on("SIGINT", () => finish(0));

main().catch((error) => {
  console.error(error);
  finish(1);
});
