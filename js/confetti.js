// Confeti para el podio: un canvas temporal encima de todo, sin librerías.
const COLORS = ["#ffffff", "#c8102e", "#1560bd", "#f2b705", "#1f7a0f", "#ffd1a8"];

export function launchConfetti({ durationMs = 5000 } = {}) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");

  let width = 0;
  let height = 0;
  const resize = () => {
    const ratio = window.devicePixelRatio || 1;
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  // Menos piezas en pantallas pequeñas para que vaya fluido en móviles.
  const count = Math.round(Math.min(220, Math.max(80, width / 6)));
  const random = (min, max) => min + Math.random() * (max - min);
  const pieces = Array.from({ length: count }, () => ({
    x: random(0, width),
    // Repartidas justo encima de la pantalla, para que el confeti se vea desde el primer segundo.
    y: random(-height * 0.35, -10),
    w: random(6, 12),
    h: random(8, 16),
    vx: random(-1.5, 1.5),
    vy: random(3, 6),
    angle: random(0, Math.PI * 2),
    spin: random(-0.2, 0.2),
    sway: random(0, Math.PI * 2),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  }));

  const start = performance.now();
  function frame(now) {
    const elapsed = now - start;
    // Tras la duración ya no reaparecen piezas arriba; el confeti termina de caer solo.
    const recycling = elapsed < durationMs;
    ctx.clearRect(0, 0, width, height);
    let visible = 0;

    for (const p of pieces) {
      p.sway += 0.05;
      p.x += p.vx + Math.sin(p.sway) * 0.8;
      p.y += p.vy;
      p.angle += p.spin;
      if (p.y > height + 20) {
        if (!recycling) continue;
        p.y = random(-40, -10);
        p.x = random(0, width);
      }
      visible += 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      // El coseno del giro simula que la pieza da vueltas en el aire.
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.angle)));
      ctx.restore();
    }

    if (visible > 0) {
      requestAnimationFrame(frame);
    } else {
      window.removeEventListener("resize", resize);
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}
