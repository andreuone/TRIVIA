// Lógica pura de la partida, sin DOM ni Firebase, para probarla y compartirla con los bots.

// Margen tras el fin del tiempo para compensar la latencia de quien respondió a última hora.
export const GRACE_MS = 1500;

// De 1000 puntos (al instante) a 500 (justo al acabar el tiempo).
export function computePoints(elapsedMs, limitSeconds) {
  const limitMs = limitSeconds * 1000;
  const t = Math.min(Math.max(elapsedMs, 0), limitMs);
  return Math.round(1000 * (1 - t / (2 * limitMs)));
}

// Una respuesta cuenta si es de un jugador conocido, tiene una opción válida
// y se recibió dentro del tiempo. Ambos instantes vienen del servidor.
export function isAnswerValid(answer, { startedAtMs, limitSeconds, roster }) {
  if (roster && !roster.has(answer.uid)) return false;
  if (!Number.isInteger(answer.choice) || answer.choice < 0 || answer.choice > 3) return false;
  const elapsed = answer.answeredAtMs - startedAtMs;
  return elapsed >= 0 && elapsed <= limitSeconds * 1000 + GRACE_MS;
}

// answers: [{ uid, choice, answeredAtMs }]. No modifica `totals`.
export function scoreRound({ answers, correct, startedAtMs, limitSeconds, roster, totals }) {
  const gains = {};
  const votes = [0, 0, 0, 0];
  const newTotals = { ...totals };

  for (const answer of answers) {
    if (!isAnswerValid(answer, { startedAtMs, limitSeconds, roster })) continue;
    votes[answer.choice] += 1;
    if (answer.choice === correct) {
      const points = computePoints(answer.answeredAtMs - startedAtMs, limitSeconds);
      gains[answer.uid] = points;
      newTotals[answer.uid] = (newTotals[answer.uid] ?? 0) + points;
    }
  }
  return { gains, votes, totals: newTotals };
}

// Apodos únicos para mostrar: el segundo "Ana" en entrar se ve como "Ana (2)".
// players: [{ uid, nick, joinedAtMs }]. Devuelve { uid: nombre }.
export function displayNames(players) {
  const ordered = [...players].sort(
    (a, b) => a.joinedAtMs - b.joinedAtMs || a.uid.localeCompare(b.uid),
  );
  const seen = new Map();
  const names = {};
  for (const { uid, nick } of ordered) {
    const key = nick.trim().toLocaleLowerCase("es");
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    names[uid] = count === 1 ? nick : `${nick} (${count})`;
  }
  return names;
}

// Empates con la misma posición (1, 1, 3). `names` es { uid: nombre } e incluye a quien
// aún no tiene puntos. Devuelve [{ uid, nick, score, rank }] de mayor a menor.
export function rankPlayers(totals, names) {
  const rows = Object.keys(names)
    .map((uid) => ({ uid, nick: names[uid], score: totals[uid] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.nick.localeCompare(b.nick, "es"));

  let rank = 0;
  return rows.map((row, i) => {
    if (i === 0 || row.score !== rows[i - 1].score) rank = i + 1;
    return { ...row, rank };
  });
}

// El mapa que permite a cada móvil conocer sus puntos y su posición con una sola lectura.
export function buildResults(ranking, gains) {
  const results = {};
  for (const { uid, score, rank } of ranking) {
    results[uid] = { g: gains[uid] ?? 0, s: score, r: rank };
  }
  return results;
}

export function buildTop(ranking, size = 5) {
  return ranking.slice(0, size).map(({ nick, score, rank }) => ({ nick, score, rank }));
}

// Lo único de la pregunta que se publica: se copia campo a campo para que `correct`
// no pueda colarse nunca en el documento de estado.
export function publicQuestion(question) {
  const result = {
    text: question.text,
    options: [...question.options],
    timeLimit: question.timeLimit,
  };
  if (question.imageUrl) result.imageUrl = question.imageUrl;
  return result;
}

// Actualizaciones del documento de estado. `fv` aporta serverTimestamp y deleteField
// del SDK correspondiente, para que la app y los bots escriban exactamente lo mismo.
export function questionUpdate(question, qIndex, fv) {
  return {
    phase: "question",
    qIndex,
    question: publicQuestion(question),
    startedAt: fv.serverTimestamp(),
    correct: fv.deleteField(),
    votes: fv.deleteField(),
    top5: fv.deleteField(),
    results: fv.deleteField(),
  };
}

export function revealUpdate({ correct, votes, top5, results }) {
  return { phase: "reveal", correct, votes, top5, results };
}

export function endUpdate({ top5, results }, fv) {
  return {
    phase: "end",
    top5,
    results,
    question: fv.deleteField(),
    correct: fv.deleteField(),
    votes: fv.deleteField(),
  };
}
