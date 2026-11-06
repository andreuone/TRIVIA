// Editor de preguntas. Se guardan solo en este navegador: nunca suben a Firestore completas.
import { LIMITS, emptyQuestion, normalizeQuestions, normalizeTitle, validateQuestions } from "./questions.js";
import { $, SHAPES, el, store } from "./ui.js";

const STORAGE_KEY = "trivia:questions";
const TITLE_KEY = "trivia:title";

export function createEditor(onChange) {
  let questions = [];
  const list = $("editor-list");
  const titleInput = $("game-title-input");

  function setTitle(title) {
    titleInput.value = title;
    store.set(TITLE_KEY, title);
  }

  titleInput.addEventListener("input", () => store.set(TITLE_KEY, titleInput.value));
  const message = $("editor-message");

  function refreshStatus() {
    store.set(STORAGE_KEY, questions);
    const errors = validateQuestions(questions);
    $("editor-count").textContent = `Preguntas (${questions.length})`;
    $("editor-errors").replaceChildren(...errors.slice(0, 8).map((text) => el("li", { text })));
    onChange(errors.length === 0);
  }

  function field(labelText, input) {
    return el("label", { class: "editor-field" }, el("span", { text: labelText }), input);
  }

  function renderCard(question, index) {
    const radioName = `correct-${index}`;
    const options = question.options.map((option, i) =>
      el(
        "div",
        { class: "editor-option", dataset: { choice: i } },
        el("span", { class: "shape", text: SHAPES[i], ariaHidden: "true" }),
        el("input", {
          type: "text",
          value: option,
          maxLength: LIMITS.optionMax,
          placeholder: `Opción ${i + 1}`,
          ariaLabel: `Pregunta ${index + 1}, opción ${i + 1}`,
          oninput: (e) => {
            question.options[i] = e.target.value;
            refreshStatus();
          },
        }),
        el(
          "label",
          { class: "editor-correct" },
          el("input", {
            type: "radio",
            name: radioName,
            checked: question.correct === i,
            onchange: () => {
              question.correct = i;
              refreshStatus();
            },
          }),
          el("span", { text: "Correcta" }),
        ),
      ),
    );

    return el(
      "article",
      { class: "editor-card" },
      el(
        "header",
        { class: "editor-card-header" },
        el("strong", { text: `Pregunta ${index + 1}` }),
        el("button", {
          class: "btn btn-ghost btn-small",
          type: "button",
          text: "Eliminar",
          onclick: () => {
            questions.splice(index, 1);
            render();
          },
        }),
      ),
      field(
        "Texto",
        el("input", {
          type: "text",
          value: question.text,
          maxLength: LIMITS.textMax,
          oninput: (e) => {
            question.text = e.target.value;
            refreshStatus();
          },
        }),
      ),
      el("div", { class: "editor-options" }, ...options),
      el(
        "div",
        { class: "editor-row" },
        field(
          "Tiempo (segundos)",
          el("input", {
            type: "number",
            min: LIMITS.timeMin,
            max: LIMITS.timeMax,
            value: question.timeLimit,
            oninput: (e) => {
              question.timeLimit = Number(e.target.value);
              refreshStatus();
            },
          }),
        ),
        field(
          "Imagen (URL https, opcional)",
          el("input", {
            type: "url",
            value: question.imageUrl,
            placeholder: "https://…",
            oninput: (e) => {
              question.imageUrl = e.target.value.trim();
              refreshStatus();
            },
          }),
        ),
      ),
    );
  }

  function render() {
    list.replaceChildren(...questions.map(renderCard));
    refreshStatus();
  }

  async function loadSample() {
    const response = await fetch("data/ejemplo.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    questions = normalizeQuestions(data);
    setTitle(normalizeTitle(data));
    render();
  }

  $("editor-add").addEventListener("click", () => {
    questions.push(emptyQuestion());
    render();
    list.lastElementChild?.querySelector("input")?.focus();
  });

  $("editor-sample").addEventListener("click", async () => {
    if (questions.length > 0 && !confirm("Esto reemplazará tus preguntas actuales. ¿Continuar?")) return;
    try {
      await loadSample();
      message.textContent = "Ejemplo cargado.";
    } catch (error) {
      console.error(error);
      message.textContent = "No se pudo cargar el ejemplo.";
    }
  });

  $("editor-import").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      questions = normalizeQuestions(data);
      // Si el archivo no trae nombre, se conserva el que ya había.
      if (normalizeTitle(data)) setTitle(normalizeTitle(data));
      render();
      message.textContent = `Importadas ${questions.length} preguntas de ${file.name}.`;
    } catch (error) {
      message.textContent =
        error instanceof SyntaxError ? "El archivo no es un JSON válido." : error.message;
    }
  });

  $("editor-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ title: titleInput.value.trim(), questions }, null, 2)], { type: "application/json" });
    const link = el("a", { href: URL.createObjectURL(blob), download: "preguntas-trivia.json" });
    link.click();
    URL.revokeObjectURL(link.href);
  });

  const saved = store.get(STORAGE_KEY);
  const savedTitle = store.get(TITLE_KEY);
  if (typeof savedTitle === "string") titleInput.value = savedTitle;
  if (Array.isArray(saved) && saved.length > 0) {
    questions = saved;
    render();
  } else {
    loadSample().catch((error) => {
      console.error(error);
      render();
    });
  }

  return {
    getQuestions: () => questions,
    getTitle: () => titleInput.value.trim().slice(0, LIMITS.titleMax),
  };
}
