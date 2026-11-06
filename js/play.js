// Vista del jugador. Solo escucha games/{pin}: cada escritura del anfitrión es una lectura aquí.
import {
  db,
  doc,
  ensureUser,
  friendlyError,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "./firebase.js";
import { launchConfetti } from "./confetti.js";
import { $, SHAPE_NAMES, SHAPES, answerKey, el, formatNumber, joinedKey, showScreen, store } from "./ui.js";

const pin = new URLSearchParams(location.search).get("pin") ?? "";

let uid = null;
let game = null;
let lastKey = null;
let firstSnapshot = true;
let timerId = null;
let submitted = false;

function setBackground(kind) {
  document.body.dataset.result = kind ?? "";
}

function stopTimer() {
  clearInterval(timerId);
  timerId = null;
}

function renderError(message) {
  stopTimer();
  setBackground();
  $("error-text").textContent = message;
  showScreen("error");
}

// En vivo cuenta desde que llega la pregunta, para no depender del reloj del móvil.
// Si se recarga a mitad de pregunta no hay otra referencia que startedAt.
function remainingStart(limitMs) {
  if (!firstSnapshot || !game.startedAt) return limitMs;
  const elapsed = Date.now() - game.startedAt.toMillis();
  return Math.min(limitMs, Math.max(0, limitMs - elapsed));
}

function startCountdown(limitMs) {
  const deadline = Date.now() + remainingStart(limitMs);
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    $("play-timer").style.width = `${(left / limitMs) * 100}%`;
    $("play-seconds").textContent = `${Math.ceil(left / 1000)} s`;
    if (left === 0) {
      stopTimer();
      if (!submitted) showScreen("timeout");
    }
  };
  stopTimer();
  tick();
  if (deadline > Date.now()) timerId = setInterval(tick, 200);
}

async function submitAnswer(choice) {
  if (submitted) return;
  submitted = true;
  const { qIndex, hostUid } = game;
  const key = answerKey(pin, uid, qIndex);

  store.set(key, choice);
  $("sent-shape").textContent = SHAPES[choice];
  $("sent-shape").dataset.choice = choice;
  showScreen("sent");

  try {
    await setDoc(doc(db, "games", pin, "answers", `${qIndex}_${uid}`), {
      qIndex,
      uid,
      hostUid,
      choice,
      answeredAt: serverTimestamp(),
    });
  } catch (error) {
    // permission-denied significa que esta pregunta ya estaba respondida.
    if (error.code === "permission-denied") return;
    console.error(error);
    store.remove(key);
    if (game.phase === "question" && game.qIndex === qIndex) {
      submitted = false;
      $("play-error").textContent = friendlyError(error);
      showScreen("question");
    }
  }
}

function renderQuestion() {
  setBackground();
  const { question, qIndex, qTotal } = game;
  submitted = store.get(answerKey(pin, uid, qIndex)) !== null;

  $("play-counter").textContent = `Pregunta ${qIndex + 1} de ${qTotal}`;
  $("play-text").textContent = question.text;
  $("play-error").textContent = "";
  $("play-options").replaceChildren(
    ...question.options.map((option, i) =>
      el(
        "button",
        {
          class: "play-option",
          type: "button",
          dataset: { choice: i },
          ariaLabel: `${SHAPE_NAMES[i]}: ${option}`,
          onclick: () => submitAnswer(i),
        },
        el("span", { class: "shape", text: SHAPES[i], ariaHidden: "true" }),
        el("span", { class: "play-option-text", text: option }),
      ),
    ),
  );

  if (submitted) {
    const choice = store.get(answerKey(pin, uid, qIndex));
    $("sent-shape").textContent = SHAPES[choice];
    $("sent-shape").dataset.choice = choice;
    showScreen("sent");
  } else {
    showScreen("question");
  }
  startCountdown(question.timeLimit * 1000);
}

function renderReveal() {
  stopTimer();
  const mine = game.results?.[uid];
  const choice = store.get(answerKey(pin, uid, game.qIndex));
  const total = Object.keys(game.results ?? {}).length;

  let title;
  let kind;
  if (mine?.g > 0) {
    title = "¡Correcto!";
    kind = "correct";
  } else if (choice === null) {
    title = "Sin respuesta";
    kind = "none";
  } else if (choice === game.correct) {
    title = "Llegó tarde";
    kind = "none";
  } else {
    title = "Incorrecto";
    kind = "wrong";
  }

  setBackground(kind);
  $("result-title").textContent = title;
  $("result-points").textContent = mine ? `+${formatNumber(mine.g)} puntos` : "";
  $("result-detail").textContent = mine
    ? `${formatNumber(mine.s)} puntos en total · Posición ${mine.r} de ${total}`
    : "Entrarás en la clasificación en la próxima pregunta.";
  $("result-correct").textContent = kind === "correct" ? "" : `Era: ${game.question.options[game.correct]}`;
  showScreen("result");
}

function renderEnd() {
  stopTimer();
  setBackground();
  launchConfetti();
  const mine = game.results?.[uid];
  const total = Object.keys(game.results ?? {}).length;
  $("end-position").textContent = mine ? `Posición ${mine.r} de ${total}` : "Gracias por jugar";
  $("end-score").textContent = mine ? `${formatNumber(mine.s)} puntos` : "";
  showScreen("end");
}

function showTitle(title = "") {
  $("waiting-title").textContent = title;
  $("end-title").textContent = title;
  document.title = title ? `${title}: jugar` : "Trivia: jugar";
}

function render() {
  switch (game.phase) {
    case "lobby":
      setBackground();
      $("waiting-nick").textContent = store.get("trivia:nick") ?? "";
      showScreen("waiting");
      break;
    case "question":
      renderQuestion();
      break;
    case "reveal":
      renderReveal();
      break;
    case "end":
      renderEnd();
      break;
    default:
      renderError("La partida está en un estado desconocido.");
  }
}

// Mantener la pantalla encendida evita reconexiones, y cada una cuesta una lectura.
let wakeLock = null;
async function keepAwake() {
  if (wakeLock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    /* no disponible: la partida funciona igual */
  }
}
document.addEventListener("visibilitychange", keepAwake);

async function main() {
  if (!/^\d{6}$/.test(pin)) {
    location.replace("index.html");
    return;
  }
  try {
    uid = await ensureUser();
  } catch (error) {
    console.error(error);
    renderError(friendlyError(error));
    return;
  }
  if (!store.get(joinedKey(pin, uid))) {
    location.replace(`index.html?pin=${pin}`);
    return;
  }

  keepAwake();
  onSnapshot(
    doc(db, "games", pin),
    (snapshot) => {
      if (!snapshot.exists()) {
        renderError("Esta partida ya no existe.");
        return;
      }
      game = snapshot.data();
      showTitle(game.title);
      const key = `${game.phase}:${game.qIndex}`;
      if (key !== lastKey) {
        lastKey = key;
        render();
      }
      firstSnapshot = false;
    },
    (error) => {
      console.error(error);
      renderError(friendlyError(error));
    },
  );
}

main();
