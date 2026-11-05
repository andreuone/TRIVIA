// Pega aquí la configuración de tu proyecto (consola de Firebase > Configuración del
// proyecto > Tus apps > App web). Estos valores no son secretos: identifican el proyecto,
// y lo que protege los datos son las reglas de firestore.rules.
export const firebaseConfig = {
  apiKey: "AIzaSyCFmQPmNcGEzqTvAavwbGv-F4h8idDwVUQ",
  authDomain: "trivia-34128.firebaseapp.com",
  projectId: "trivia-34128",
  appId: "1:983566535660:web:23dea9a070677feb984ec9",
};

// En localhost la app usa siempre el emulador y nunca toca tu proyecto real.
export const emulator = {
  enabled: ["localhost", "127.0.0.1"].includes(location.hostname),
  host: "127.0.0.1",
  authPort: 9099,
  firestorePort: 8080,
  projectId: "demo-trivia",
};
