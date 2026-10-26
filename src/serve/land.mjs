// The way-in pages' background (welcome.ts; Isha, 2026-10-26): a task tree that grows behind the
// card, softly lit, as tira's work branches. Trunks rise from the foot of the page and branch out;
// each branch ends in a small glowing task (mostly green, done; some blue, under way; now and then
// amber, blocked), and pollen-like light drifts up through it. The tree grows for a few seconds,
// rests, fades and grows again from a new seed. It takes tira's colours, light or dark, as they
// change; it stays still, fully grown, for anyone who asks for less motion; and it rests while its
// tab is hidden. A canvas, drawn by tira alone: no library, nothing from the network.
const GROW_MS = 11000; // the whole tree, from the first trunk to the last task
const REST_MS = 15000;
const FADE_MS = 2500;
const CYCLE_MS = GROW_MS + REST_MS + FADE_MS;

function scene(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let w = 0;
  let h = 0;
  let dpr = 1;
  let colors = readColors();
  let seed = 1 + Math.floor(Math.random() * 1e6);
  let tree = [];
  let pollen = [];
  let started = performance.now();
  let frame = 0;

  const size = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tree = grow(w, h, seed);
    pollen = drift(w, h, seed);
  };

  const paint = (now) => {
    const t = still.matches ? GROW_MS + 1 : (now - started) % CYCLE_MS;
    // a new seed for each new cycle
    if (!still.matches && now - started >= CYCLE_MS) {
      started = now - t;
      seed += 1;
      tree = grow(w, h, seed);
    }
    const fade = t > GROW_MS + REST_MS ? 1 - (t - GROW_MS - REST_MS) / FADE_MS : 1;
    ctx.clearRect(0, 0, w, h);
    drawTree(ctx, tree, t, fade, colors);
    drawPollen(ctx, pollen, still.matches ? 0 : now / 1000, h, colors);
  };

  const loop = (now) => {
    paint(now);
    frame = still.matches || document.hidden ? 0 : requestAnimationFrame(loop);
  };
  const resume = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (still.matches) paint(performance.now());
    else if (!document.hidden) frame = requestAnimationFrame(loop);
  };

  let resizing = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizing);
    resizing = window.setTimeout(() => { size(); resume(); }, 150);
  });
  document.addEventListener("visibilitychange", resume);
  still.addEventListener("change", resume);
  // the theme: the computer's, or the one picked in Account settings (theme.mjs)
  const recolor = () => { colors = readColors(); if (still.matches) paint(performance.now()); };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", recolor);
  for (const r of document.querySelectorAll('input[name="theme"]')) r.addEventListener("change", recolor);

  size();
  resume();
}

// ---------- the tree ----------
// a small, repeatable random: the same seed grows the same tree
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every branch: where it starts and ends, the bend between, when it starts growing and for how
// long, how deep it is, and the task at its end.
function grow(w, h, seed) {
  const rnd = random(seed);
  const between = (a, b) => a + (b - a) * rnd();
  const out = [];
  const up = -Math.PI / 2;
  const trunk = Math.min(Math.max(h * 0.2, 110), 260);
  const deepest = w < 600 ? 4 : 5;
  const branch = (x, y, angle, length, depth, birth) => {
    const ex = x + Math.cos(angle) * length;
    const ey = y + Math.sin(angle) * length;
    const bend = between(-0.25, 0.25) * length;
    const cx = (x + ex) / 2 + Math.cos(angle + Math.PI / 2) * bend;
    const cy = (y + ey) / 2 + Math.sin(angle + Math.PI / 2) * bend;
    const dur = 700 + length * 7;
    const roll = rnd();
    const state = roll < 0.55 ? "done" : roll < 0.85 ? "doing" : roll < 0.93 ? "blocked" : "todo";
    out.push({ x, y, cx, cy, ex, ey, depth, birth, dur, state });
    if (depth >= deepest || birth + dur > GROW_MS) return;
    // near the trunk it forks; further out it often just carries on
    const kids = depth < 2 ? (rnd() < 0.3 ? 3 : 2) : rnd() < 0.45 ? 1 : 2;
    for (let i = 0; i < kids; i++) {
      const side = kids === 1 ? (rnd() < 0.5 ? -1 : 1) * 0.4 : i % 2 === 0 ? -1 : 1;
      let next = angle + side * between(0.32, 0.72) + between(-0.1, 0.1);
      next += (up - next) * 0.1; // reaching for the light
      branch(ex, ey, next, length * between(0.72, 0.86), depth + 1, birth + dur + between(0, 400));
    }
  };
  // trunks from the foot of the page: one each side, leaning in, and a quieter one in the middle
  branch(w * between(0.06, 0.16), h + 8, up + between(0.1, 0.28), trunk, 0, 0);
  branch(w * between(0.84, 0.94), h + 8, up - between(0.1, 0.28), trunk, 0, 400);
  if (w >= 700) branch(w * between(0.42, 0.58), h + 8, up + between(-0.1, 0.1), trunk * 0.8, 1, 1200);
  return out;
}

const ease = (p) => 1 - (1 - p) ** 3;
// a point a share p along a branch's bend
const along = (b, p) => {
  const q = 1 - p;
  return [q * q * b.x + 2 * q * p * b.cx + p * p * b.ex, q * q * b.y + 2 * q * p * b.cy + p * p * b.ey];
};

function drawTree(ctx, tree, t, fade, c) {
  ctx.lineCap = "round";
  for (const b of tree) {
    const p = Math.min(Math.max((t - b.birth) / b.dur, 0), 1);
    if (p <= 0) continue;
    const k = ease(p);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    for (let i = 1; i <= 10; i++) {
      const [x, y] = along(b, (k * i) / 10);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba(c.branch, (c.dark ? 0.42 : 0.3) * fade * (1 - b.depth * 0.11));
    ctx.lineWidth = Math.max(3.4 - b.depth * 0.55, 0.7);
    ctx.stroke();
  }
  // the tasks, once their branch has reached them: a soft glow and a bright middle
  for (const b of tree) {
    const shown = (t - b.birth - b.dur) / 500;
    if (shown <= 0) continue;
    const bloom = ease(Math.min(shown, 1));
    const r = Math.max(4.2 - b.depth * 0.45, 1.8) * bloom;
    const col = c[b.state];
    const glow = ctx.createRadialGradient(b.ex, b.ey, 0, b.ex, b.ey, r * 5);
    glow.addColorStop(0, rgba(col, (c.dark ? 0.45 : 0.3) * fade));
    glow.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(b.ex, b.ey, r * 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba(col, (c.dark ? 0.95 : 0.8) * fade);
    ctx.beginPath();
    ctx.arc(b.ex, b.ey, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- the pollen ----------
function drift(w, h, seed) {
  const rnd = random(seed * 7 + 3);
  const n = Math.min(Math.round((w * h) / 24000), 70);
  return Array.from({ length: n }, () => ({ x: rnd() * w, y: rnd() * h, r: 0.8 + rnd() * 1.8, rise: 6 + rnd() * 14, sway: 6 + rnd() * 18, phase: rnd() * Math.PI * 2, a: 0.25 + rnd() * 0.5, green: rnd() < 0.6 }));
}

function drawPollen(ctx, pollen, s, h, c) {
  for (const d of pollen) {
    const y = (((d.y - d.rise * s) % (h + 20)) + h + 20) % (h + 20) - 10;
    const x = d.x + Math.sin(s * 0.6 + d.phase) * d.sway;
    const col = d.green ? c.pollen : c.doing;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, d.r * 4);
    glow.addColorStop(0, rgba(col, d.a * (c.dark ? 0.9 : 0.6)));
    glow.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, d.r * 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- tira's colours, as the page has them now ----------
function readColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name, fallback) => parse(css.getPropertyValue(name).trim()) ?? parse(fallback);
  const bg = get("--bg", "#ffffff");
  const dark = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 < 0.5;
  return {
    dark,
    branch: get(dark ? "--loz-done" : "--done", dark ? "#b3df72" : "#216e4e"),
    done: get(dark ? "--loz-done" : "--done", "#4bce97"),
    doing: get("--accent", "#1868db"),
    blocked: get("--warn", "#a54800"),
    todo: get("--dim", "#6b6e76"),
    pollen: get(dark ? "--loz-done" : "--done", "#4bce97"),
  };
}

// #rgb, #rrggbb or rgb(r, g, b), as [r, g, b]; anything else: undefined
function parse(v) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const s = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000})`;

// last: everything above is ready by now
const canvas = document.querySelector("canvas[data-land-scene]");
if (canvas instanceof HTMLCanvasElement) scene(canvas);
