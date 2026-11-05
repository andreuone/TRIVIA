// Validación de preguntas, sin DOM, compartida por el editor y las pruebas.

export const LIMITS = {
  textMax: 300,
  optionMax: 120,
  timeMin: 5,
  timeMax: 120,
  defaultTime: 20,
};

export function emptyQuestion() {
  return { text: "", options: ["", "", "", ""], correct: 0, timeLimit: LIMITS.defaultTime, imageUrl: "" };
}

// Acepta una lista o un objeto { questions: [...] } y conserva solo los campos conocidos.
export function normalizeQuestions(data) {
  const list = Array.isArray(data) ? data : data?.questions;
  if (!Array.isArray(list)) throw new Error("El JSON debe ser una lista de preguntas o tener un campo \"questions\".");
  return list.map((q) => ({
    text: typeof q?.text === "string" ? q.text : "",
    options: Array.isArray(q?.options) ? q.options.map((o) => String(o ?? "")) : [],
    correct: q?.correct,
    timeLimit: q?.timeLimit ?? LIMITS.defaultTime,
    imageUrl: typeof q?.imageUrl === "string" ? q.imageUrl : "",
  }));
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Devuelve una lista de errores en español; vacía si todo está bien.
export function validateQuestions(questions) {
  const errors = [];
  if (questions.length === 0) errors.push("Añade al menos una pregunta.");

  questions.forEach((q, i) => {
    const label = `Pregunta ${i + 1}`;
    if (!q.text.trim()) errors.push(`${label}: falta el texto.`);
    if (q.text.length > LIMITS.textMax) errors.push(`${label}: el texto supera ${LIMITS.textMax} caracteres.`);
    if (q.options.length !== 4) {
      errors.push(`${label}: debe tener exactamente 4 opciones.`);
    } else {
      if (q.options.some((o) => !o.trim())) errors.push(`${label}: hay opciones vacías.`);
      if (q.options.some((o) => o.length > LIMITS.optionMax)) {
        errors.push(`${label}: alguna opción supera ${LIMITS.optionMax} caracteres.`);
      }
    }
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) {
      errors.push(`${label}: la respuesta correcta debe ser un índice de 0 a 3.`);
    }
    if (!Number.isInteger(q.timeLimit) || q.timeLimit < LIMITS.timeMin || q.timeLimit > LIMITS.timeMax) {
      errors.push(`${label}: el tiempo debe ser de ${LIMITS.timeMin} a ${LIMITS.timeMax} segundos.`);
    }
    if (q.imageUrl && !isHttpsUrl(q.imageUrl)) errors.push(`${label}: la imagen debe ser una URL https.`);
  });
  return errors;
}
