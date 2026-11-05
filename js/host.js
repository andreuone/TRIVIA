// Pantalla del anfitrión. Calcula los puntajes y publica el estado.
// Regla de oro para la cuota: cada escritura en games/{pin} se multiplica por el número de
// jugadores, así que el temporizador, el conteo en vivo y el top 5 se quedan en esta pantalla.
import { createEditor } from "./editor.js";
import {
  collection,
  db,
  deleteField,
  doc,
  ensureUser,
  friendlyError,
  getDocFromServer,
  isConfigured,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "./firebase.js";
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
} from "./scoring.js";
import { $, SHAPES, el, formatNumber, showScreen, store } from "./ui.js";
import qrcode from "./vendor/qrcode.js";

const STORAGE_KEY = "trivia:hostGame";
const MAX_CHIPS = 120;
const FLUSH_BATCH_SIZE = 400;
const fieldValues = { serverTimestamp, deleteField };

let uid = null;
let pin = null;
let gameRef = null;
let questions = [];
let totals = {};
let qIndex = -1;
let phase = null;
let view = null;
let startedAtMs = 0;
let lastTop = [];

const roster = new Map();
let names = {};
const answers = new Map();
let unsubscribePlayers = null;
let unsubscribeAnswers = null;
let timerId = null;
let graceId = null;
let closingRound = false;

const editor = createEditor((isValid) => {
  $("create-button").disabled = !isValid;
});

function showBanner(message) {
  const banner = $("host-banner");
  banner.textContent = message ?? "";
  banner.hidden = !message;
}

function reportError(error) {
  console.error(error);
  showBanner(friendlyError(error));
}

function persist() {
  store.set(STORAGE_KEY, { pin, hostUid: uid, questions, totals, qIndex, phase, view });
}

function setView(name) {
  view = name;
  showScreen(name);
  persist();
}

/* ---------- Jugadores ---------- */

function renderLobbyPlayers() {
  const players = [...roster.values()].sort((a, b) => b.joinedAtMs - a.joinedAtMs);
  $("lobby-count").textContent = formatNumber(players.length);
  $("start-button").disabled = players.length === 0;
  const chips = players.slice(0, MAX_CHIPS).map((p) => el("li", { text: names[p.uid] }));
  if (players.length > MAX_CHIPS) {
    chips.push(el("li", { class: "chip-more", text: `y ${players.length - MAX_CHIPS} más` }));
  }
  $("lobby-players").replaceChildren(...chips);
}

// Sin coste durante el juego: el documento de un jugador no cambia hasta el final,
// y entonces el anfitrión ya ha dejado de escuchar.
function watchPlayers() {
  const playersQuery = query(collection(gameRef, "players"), where("hostUid", "==", uid));
  return new Promise((resolve) => {
    unsubscribePlayers = onSnapshot(
      playersQuery,
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          const data = change.doc.data();
          roster.set(change.doc.id, {
            uid: change.doc.id,
            nick: data.nick,
            joinedAtMs: data.joinedAt?.toMillis() ?? Date.now(),
          });
        }
        names = displayNames([...roster.values()]);
        if (view === "lobby") renderLobbyPlayers();
        if (view === "question") onAnswersChanged();
        resolve();
      },
      (error) => {
        reportError(error);
        resolve();
      },
    );
  });
}

/* ---------- Sala ---------- */

function randomPin() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 900000;
  return String(100000 + value);
}

async function createGame() {
  $("create-button").disabled = true;
  showBanner(null);
  try {
    uid = await ensureUser();
    questions = structuredClone(editor.getQuestions());

    // Sin lecturas: si el PIN ya existe, las reglas rechazan la escritura y se prueba con otro.
    for (let attempt = 0; ; attempt += 1) {
      pin = randomPin();
      gameRef = doc(db, "games", pin);
      try {
        await setDoc(gameRef, {
          hostUid: uid,
          phase: "lobby",
          qIndex: -1,
          qTotal: questions.length,
          createdAt: serverTimestamp(),
        });
        break;
      } catch (error) {
        if (error.code !== "permission-denied" || attempt >= 4) throw error;
      }
    }

    phase = "lobby";
    totals = {};
    qIndex = -1;
    showLobby();
    watchPlayers();
  } catch (error) {
    reportError(error);
    $("create-button").disabled = false;
  }
}

function showLobby() {
  const joinUrl = new URL(`index.html?pin=${pin}`, location.href);
  $("lobby-url").textContent = joinUrl.host + joinUrl.pathname.replace(/index\.html$/, "");
  $("lobby-pin").textContent = `${pin.slice(0, 3)} ${pin.slice(3)}`;

  const qr = qrcode(0, "M");
  qr.addData(joinUrl.href);
  qr.make();
  $("lobby-qr").innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });

  setView("lobby");
  renderLobbyPlayers();
}

/* ---------- Pregunta ---------- */

function renderOptions(container, question) {
  container.replaceChildren(
    ...question.options.map((option, i) =>
      el(
        "div",
        { class: "host-option", dataset: { choice: i } },
        el("span", { class: "shape", text: SHAPES[i], ariaHidden: "true" }),
        el("span", { text: option }),
      ),
    ),
  );
}

// Una respuesta puede llegar antes que el alta de su jugador, así que se guardan todas
// y solo se cuentan las de jugadores conocidos. scoreRound aplica el mismo filtro.
function renderAnswerCount() {
  const count = [...answers.keys()].filter((id) => roster.has(id)).length;
  $("answer-count").textContent = `${formatNumber(count)} / ${formatNumber(roster.size)}`;
  return count;
}

function onAnswersChanged() {
  const count = renderAnswerCount();
  if (roster.size > 0 && count >= roster.size) closeRound();
}

function showQuestion(question) {
  $("question-counter").textContent = `Pregunta ${qIndex + 1} de ${questions.length}`;
  $("question-text").textContent = question.text;
  const image = $("question-image");
  image.hidden = !question.imageUrl;
  if (question.imageUrl) image.src = question.imageUrl;
  else image.removeAttribute("src");
  renderOptions($("question-options"), question);
  setView("question");
  renderAnswerCount();
}

function clearRoundTimers() {
  clearInterval(timerId);
  clearTimeout(graceId);
  timerId = null;
  graceId = null;
}

function startTimer(deadline, limitMs) {
  clearRoundTimers();
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    $("host-timer").style.width = `${(left / limitMs) * 100}%`;
    $("host-seconds").textContent = Math.ceil(left / 1000);
    if (left === 0) {
      clearInterval(timerId);
      graceId = setTimeout(closeRound, GRACE_MS);
    }
  };
  timerId = setInterval(tick, 200);
  tick();
}

function watchAnswers(index) {
  unsubscribeAnswers?.();
  answers.clear();
  const answersQuery = query(
    collection(gameRef, "answers"),
    where("qIndex", "==", index),
    where("hostUid", "==", uid),
  );
  unsubscribeAnswers = onSnapshot(
    answersQuery,
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        const data = change.doc.data();
        if (data.answeredAt) {
          answers.set(data.uid, {
            uid: data.uid,
            choice: data.choice,
            answeredAtMs: data.answeredAt.toMillis(),
          });
        }
      }
      onAnswersChanged();
    },
    reportError,
  );
}

async function startQuestion(index) {
  showBanner(null);
  const question = questions[index];
  await updateDoc(gameRef, questionUpdate(question, index, fieldValues));
  // startedAt lo fija el servidor, así que hay que leerlo: una lectura por pregunta.
  const snapshot = await getDocFromServer(gameRef);
  startedAtMs = snapshot.data().startedAt.toMillis();

  qIndex = index;
  phase = "question";
  closingRound = false;
  answers.clear();
  showQuestion(question);
  watchAnswers(index);
  const limitMs = question.timeLimit * 1000;
  startTimer(Date.now() + limitMs, limitMs);
}

/* ---------- Resultado ---------- */

async function closeRound() {
  if (closingRound || phase !== "question") return;
  closingRound = true;
  clearRoundTimers();
  unsubscribeAnswers?.();
  unsubscribeAnswers = null;

  const question = questions[qIndex];
  const round = scoreRound({
    answers: [...answers.values()],
    correct: question.correct,
    startedAtMs,
    limitSeconds: question.timeLimit,
    roster,
    totals,
  });
  names = displayNames([...roster.values()]);
  const ranking = rankPlayers(round.totals, names);
  const top5 = buildTop(ranking);

  try {
    await updateDoc(
      gameRef,
      revealUpdate({
        correct: question.correct,
        votes: round.votes,
        top5,
        results: buildResults(ranking, round.gains),
      }),
    );
  } catch (error) {
    reportError(error);
    showRetry("Reintentar", () => {
      closingRound = false;
      closeRound();
    });
    return;
  }

  showBanner(null);
  totals = round.totals;
  phase = "reveal";
  lastTop = top5;
  showReveal(question, round.votes);
}

// Si Firebase falla, los botones de avance se sustituyen por un reintento.
function showRetry(label, action) {
  const button = $("skip-button");
  button.textContent = label;
  button.disabled = false;
  button.onclick = () => {
    button.textContent = "Terminar ya";
    button.onclick = closeRound;
    action();
  };
}

function showReveal(question, votes) {
  $("reveal-text").textContent = question.text;
  const totalVotes = votes.reduce((sum, n) => sum + n, 0);
  const maxVotes = Math.max(...votes, 1);
  $("reveal-bars").replaceChildren(
    ...question.options.map((option, i) => {
      const bar = el("div", { class: "reveal-bar-fill" });
      bar.style.height = `${(votes[i] / maxVotes) * 100}%`;
      return el(
        "div",
        {
          class: `reveal-bar ${i === question.correct ? "is-correct" : "is-wrong"}`,
          dataset: { choice: i },
        },
        el("span", { class: "reveal-count", text: formatNumber(votes[i]) }),
        el("div", { class: "reveal-bar-track" }, bar),
        el(
          "div",
          { class: "reveal-label" },
          el("span", { class: "shape", text: i === question.correct ? "✓" : SHAPES[i], ariaHidden: "true" }),
          el("span", { text: option }),
        ),
      );
    }),
  );
  $("reveal-summary").textContent = `${formatNumber(totalVotes)} de ${formatNumber(roster.size)} respondieron`;
  setView("reveal");
}

function renderTopList(list, rows) {
  list.replaceChildren(
    ...rows.map((row) =>
      el(
        "li",
        {},
        el("span", { class: "top-rank", text: row.rank }),
        el("span", { class: "top-nick", text: row.nick }),
        el("span", { class: "top-score", text: formatNumber(row.score) }),
      ),
    ),
  );
}

function showLeaderboard() {
  renderTopList($("top-list"), lastTop);
  const isLast = qIndex + 1 >= questions.length;
  $("next-button").textContent = isLast ? "Ver podio" : "Siguiente pregunta";
  setView("leaderboard");
}

/* ---------- Final ---------- */

async function flushScores(finalTotals) {
  const entries = Object.entries(finalTotals).filter(([, score]) => score > 0);
  for (let i = 0; i < entries.length; i += FLUSH_BATCH_SIZE) {
    const batch = writeBatch(db);
    for (const [playerId, score] of entries.slice(i, i + FLUSH_BATCH_SIZE)) {
      batch.update(doc(gameRef, "players", playerId), { score });
    }
    await batch.commit();
  }
}

async function finishGame() {
  unsubscribePlayers?.();
  unsubscribePlayers = null;
  const ranking = rankPlayers(totals, names);
  const top5 = buildTop(ranking);

  await updateDoc(
    gameRef,
    endUpdate({ top5, results: buildResults(ranking, {}) }, fieldValues),
  );
  phase = "end";
  showEnd(top5);
  store.remove(STORAGE_KEY);

  // El podio ya está publicado: si esto falla, solo se pierde la copia en players.
  try {
    await flushScores(totals);
  } catch (error) {
    console.error(error);
    showBanner("La partida terminó, pero no se guardaron los puntajes individuales.");
  }
}

function showEnd(top5) {
  const places = [1, 0, 2];
  $("podium").replaceChildren(
    ...places
      .filter((i) => top5[i])
      .map((i) =>
        el(
          "div",
          { class: `podium-step podium-${i + 1}` },
          el("span", { class: "podium-nick", text: top5[i].nick }),
          el("span", { class: "podium-score", text: formatNumber(top5[i].score) }),
          el("span", { class: "podium-rank", text: top5[i].rank }),
        ),
      ),
  );
  renderTopList($("end-rest"), top5.slice(3));
  view = "end";
  showScreen("end");
}

/* ---------- Avance y recuperación tras recargar ---------- */

async function runGuarded(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    reportError(error);
  } finally {
    button.disabled = false;
  }
}

function advance() {
  if (qIndex + 1 < questions.length) return startQuestion(qIndex + 1);
  return finishGame();
}

async function resumeGame(saved) {
  try {
    pin = saved.pin;
    gameRef = doc(db, "games", pin);
    questions = saved.questions;
    totals = saved.totals ?? {};
    qIndex = saved.qIndex;

    const snapshot = await getDocFromServer(gameRef);
    if (!snapshot.exists()) throw new Error("La partida ya no existe.");
    const data = snapshot.data();
    phase = data.phase;
    qIndex = data.qIndex;

    // Si la recarga pilló justo tras publicar, el documento manda sobre lo guardado.
    if (data.results) {
      totals = Object.fromEntries(Object.entries(data.results).map(([id, r]) => [id, r.s]));
    }
    await watchPlayers();

    if (phase === "lobby") {
      showLobby();
    } else if (phase === "question") {
      const question = questions[qIndex];
      const limitMs = question.timeLimit * 1000;
      startedAtMs = data.startedAt.toMillis();
      closingRound = false;
      showQuestion(question);
      watchAnswers(qIndex);
      startTimer(startedAtMs + limitMs, limitMs);
    } else if (phase === "reveal") {
      lastTop = data.top5 ?? [];
      if (saved.view === "leaderboard") showLeaderboard();
      else showReveal(questions[qIndex], data.votes);
    } else {
      unsubscribePlayers?.();
      showEnd(data.top5 ?? []);
      store.remove(STORAGE_KEY);
    }
  } catch (error) {
    console.error(error);
    showBanner(error.code ? friendlyError(error) : error.message);
    showScreen("setup");
  }
}

/* ---------- Inicio ---------- */

$("create-button").addEventListener("click", createGame);
$("start-button").addEventListener("click", (e) => runGuarded(e.currentTarget, () => startQuestion(0)));
$("skip-button").onclick = closeRound;
$("to-top-button").addEventListener("click", showLeaderboard);
$("next-button").addEventListener("click", (e) => runGuarded(e.currentTarget, advance));

window.addEventListener("beforeunload", (event) => {
  if (phase && phase !== "end") event.preventDefault();
});

async function main() {
  if (!isConfigured) {
    showBanner("Falta configurar Firebase en firebase-config.js. Revisa el README.");
    $("create-button").hidden = true;
    return;
  }
  try {
    uid = await ensureUser();
  } catch (error) {
    reportError(error);
    return;
  }

  const saved = store.get(STORAGE_KEY);
  if (saved?.pin && saved.hostUid === uid && saved.phase !== "end") {
    $("resume-text").textContent = `Tienes una partida en curso con el PIN ${saved.pin}.`;
    $("resume-box").hidden = false;
    $("resume-button").onclick = () => resumeGame(saved);
    $("discard-button").onclick = () => {
      store.remove(STORAGE_KEY);
      $("resume-box").hidden = true;
    };
  }
}

main();
