// Utilidades de interfaz. Todo el texto de usuarios entra por textContent, nunca como HTML.

export const $ = (id) => document.getElementById(id);

export const SHAPES = ["▲", "◆", "●", "■"];
export const SHAPE_NAMES = ["triángulo rojo", "rombo azul", "círculo amarillo", "cuadrado verde"];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

export function showScreen(name) {
  for (const screen of document.querySelectorAll(".screen")) {
    screen.hidden = screen.id !== `screen-${name}`;
  }
  window.scrollTo(0, 0);
}

// localStorage puede fallar (modo privado); la partida debe seguir funcionando sin él.
export const store = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* sin almacenamiento: se pierde solo la recuperación tras recargar */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nada que limpiar */
    }
  },
};

export const formatNumber = (n) => n.toLocaleString("es");

export const joinedKey = (pin, uid) => `trivia:joined:${pin}:${uid}`;
export const answerKey = (pin, uid, qIndex) => `trivia:answer:${pin}:${uid}:${qIndex}`;
