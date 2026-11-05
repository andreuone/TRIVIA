// Único punto de contacto con el SDK. La versión se cambia aquí y en tests/package.json.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  browserSessionPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  connectFirestoreEmulator,
  initializeFirestore,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { emulator, firebaseConfig } from "../firebase-config.js";

export {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocFromServer,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

export const isConfigured = emulator.enabled || !firebaseConfig.apiKey.startsWith("TU_");

const app = initializeApp(
  emulator.enabled
    ? { apiKey: "demo", projectId: emulator.projectId, authDomain: `${emulator.projectId}.firebaseapp.com` }
    : firebaseConfig,
);

export const auth = getAuth(app);
// Safari en iPhone retiene o corta a veces la conexión de streaming que Firestore usa por
// defecto, y las actualizaciones llegan con retraso. Long polling funciona en todos los
// navegadores y no cambia el consumo de lecturas.
export const db = initializeFirestore(app, { experimentalForceLongPolling: true });

if (emulator.enabled) {
  connectAuthEmulator(auth, `http://${emulator.host}:${emulator.authPort}`, { disableWarnings: true });
  connectFirestoreEmulator(db, emulator.host, emulator.firestorePort);
}

// Devuelve el uid, reutilizando la sesión guardada para no crear cuentas de más
// (Firebase limita a 100 cuentas nuevas por hora desde una misma IP).
export async function ensureUser() {
  // En el emulador, cada pestaña es un usuario distinto para poder probar con varios jugadores.
  if (emulator.enabled) await setPersistence(auth, browserSessionPersistence);
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser.uid;
  const credential = await signInAnonymously(auth);
  return credential.user.uid;
}

export function friendlyError(error) {
  switch (error?.code) {
    case "auth/too-many-requests":
      return "Se alcanzó el límite de jugadores nuevos desde esta red. Prueba a entrar con datos móviles.";
    case "auth/operation-not-allowed":
    case "auth/admin-restricted-operation":
    case "auth/configuration-not-found":
      return "La autenticación anónima no está activada en Firebase. Revisa el README.";
    case "auth/unauthorized-domain":
      return "Este dominio no está autorizado en Firebase Authentication. Revisa el README.";
    case "auth/api-key-not-valid":
    case "auth/invalid-api-key":
    case "auth/api-key-not-valid.-please-pass-a-valid-api-key.":
      return "La configuración de Firebase no es válida. Revisa firebase-config.js.";
    case "auth/network-request-failed":
    case "unavailable":
      return "No hay conexión. Comprueba tu internet e inténtalo de nuevo.";
    case "permission-denied":
      return "Firebase rechazó la operación. Revisa que las reglas estén publicadas.";
    case "resource-exhausted":
      return "Se agotó la cuota gratuita de hoy. Se reinicia hacia la medianoche, hora del Pacífico.";
    default:
      return "Algo salió mal. Inténtalo de nuevo.";
  }
}
