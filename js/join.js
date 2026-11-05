import {
  db,
  doc,
  ensureUser,
  friendlyError,
  getDoc,
  isConfigured,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "./firebase.js";
import { $, joinedKey, store } from "./ui.js";

const form = $("join-form");
const pinInput = $("pin");
const nickInput = $("nick");
const button = $("join-button");
const status = $("join-status");

const urlPin = new URLSearchParams(location.search).get("pin");
if (urlPin && /^\d{6}$/.test(urlPin)) {
  pinInput.value = urlPin;
  nickInput.focus();
}
const savedNick = store.get("trivia:nick");
if (typeof savedNick === "string") nickInput.value = savedNick;

if (!isConfigured) {
  status.textContent = "Falta configurar Firebase en firebase-config.js. Revisa el README.";
  button.disabled = true;
}

pinInput.addEventListener("input", () => {
  pinInput.value = pinInput.value.replace(/\D/g, "");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = pinInput.value.trim();
  const nick = nickInput.value.trim();

  if (!/^\d{6}$/.test(pin)) {
    status.textContent = "El PIN tiene 6 dígitos.";
    pinInput.focus();
    return;
  }
  if (!nick) {
    status.textContent = "Escribe un apodo.";
    nickInput.focus();
    return;
  }

  button.disabled = true;
  status.textContent = "Entrando…";
  try {
    const uid = await ensureUser();
    const gameSnap = await getDoc(doc(db, "games", pin));
    if (!gameSnap.exists()) {
      status.textContent = "No existe ninguna partida con ese PIN.";
      return;
    }
    const game = gameSnap.data();
    if (game.phase === "end") {
      status.textContent = "Esa partida ya terminó.";
      return;
    }

    const playerRef = doc(db, "games", pin, "players", uid);
    try {
      await setDoc(playerRef, { nick, hostUid: game.hostUid, score: 0, joinedAt: serverTimestamp() });
    } catch (error) {
      // Ya estaba dentro (volvió a entrar): las reglas rechazan recrearlo, solo cambia el apodo.
      if (error.code !== "permission-denied") throw error;
      await updateDoc(playerRef, { nick });
    }

    store.set("trivia:nick", nick);
    store.set(joinedKey(pin, uid), true);
    location.assign(`play.html?pin=${pin}`);
  } catch (error) {
    console.error(error);
    status.textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
});
