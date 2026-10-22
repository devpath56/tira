// The live graph, under `tira serve` only (a rendered file scrolls instead): the Board's
// Graph style as a canvas you move like Figma or Excalidraw, and a tree you fold.
// - Move: drag anywhere (a click on a task still opens it), scroll or swipe to pan, pinch
//   or ⌘/Ctrl + scroll to zoom around the pointer. The corner tools zoom, fit the whole
//   tree, go to the next task and go full screen (Esc leaves). With the canvas focused,
//   arrows pan, + and − zoom, 0 is life size and 1 fits.
// - Fold: the button under a parent hides its whole branch (its subtasks and their lines)
//   and says how many tasks are inside; the parent stays where it was on screen. "Collapse
//   done" folds every finished branch, "Expand all" opens everything, and the found-while
//   lines can be hidden.
// - Ideas: an open idea's dashed ghost moves and folds with the task it was proposed under.
// Folds are remembered per browser and stream, the view per tab, so both survive the reload
// after every action. Places come from layout.mjs, the code the page was rendered with.
import { G, fx, layout, treePath, foundPath, subtree, finishedBranches, zoomAt, fitView, centreOn } from "./layout.mjs";

const read = (area, key, fallback) => {
  try {
    const v = area.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback; // storage blocked or garbled: start fresh
  }
};
const write = (area, key, value) => {
  try {
    area.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: it lasts until the page is left
  }
};

const ICONS = {
  full: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>',
  fit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5.5 8h5M8 5.5v5"/></svg>',
};

const wrap = document.querySelector("[data-graph]");
if (wrap) canvas(wrap);

function canvas(wrap) {
  const world = wrap.querySelector(".graph");
  const svg = world.querySelector("svg.edges");
  const stream = document.querySelector("main")?.dataset.stream ?? "";
  const FOLDS = `tira-folds:${stream}`;
  const VIEW = `tira-view:${stream}`;
  const nodes = [...world.querySelectorAll("a.gn, a.ghost")].map((el) => ({ key: el.dataset.key ?? el.dataset.idea, parent: el.dataset.parent, el }));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const inside = new Map();
  for (const n of nodes) if (n.parent !== undefined && byKey.has(n.parent) && !inside.has(n.parent)) inside.set(n.parent, subtree(nodes, n.parent));
  const lines = [...svg.querySelectorAll("path")];
  const folded = new Set(read(localStorage, FOLDS, []).filter((k) => inside.has(k)));
  let showFound = read(localStorage, "tira-found-lines", true) !== false;
  const saved = read(sessionStorage, VIEW, null);
  let view = { x: 0, y: 0, s: 1 };
  let full = saved?.full === true;
  let last = layout(nodes);
  let placed = false; // the first view is set (by the first layout, or by a move before it)

  wrap.classList.add("canvas");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Task graph: drag or scroll to move, pinch or Ctrl and scroll to zoom");

  // ---------- tools ----------
  const tool = (label, title, onClick, cls = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `tool ${cls}`.trim();
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  };
  const group = (...items) => {
    const g = document.createElement("span");
    g.className = "tool-group";
    g.append(...items);
    return g;
  };
  const size = () => [wrap.clientWidth, wrap.clientHeight];
  const middle = () => [wrap.clientWidth / 2, wrap.clientHeight / 2];
  const zoomLabel = tool("100%", "Back to life size", () => setView(zoomAt(view, 1 / view.s, ...middle())), "zoom");
  const foundBtn = tool("Found links", "Show or hide the dotted found-while lines", () => {
    showFound = !showFound;
    write(localStorage, "tira-found-lines", showFound);
    draw();
  });
  const fullBtn = tool("", "Full screen", () => setFull(!full), "icon");
  fullBtn.innerHTML = ICONS.full; // a fixed icon, no page text
  const fitBtn = tool("", "Fit the whole tree", () => setView(fitView(last.width, last.height, ...size())), "icon");
  fitBtn.innerHTML = ICONS.fit;
  const nextBtn = tool("◆ Next", "Go to the next task", goToNext);
  const tools = document.createElement("div");
  tools.className = "canvas-tools";
  tools.dataset.canvasTools = "";
  tools.append(
    group(tool("Collapse done", "Fold every finished branch", foldDone), tool("Expand all", "Open every folded branch", () => { folded.clear(); saveFolds(); draw(); }), foundBtn),
    group(tool("−", "Zoom out", () => setView(zoomAt(view, 1 / 1.25, ...middle()))), zoomLabel, tool("+", "Zoom in", () => setView(zoomAt(view, 1.25, ...middle()))), fitBtn),
    group(nextBtn, fullBtn),
  );
  const hint = document.createElement("div");
  hint.className = "canvas-hint";
  hint.textContent = "Drag to move · pinch or Ctrl + scroll to zoom";
  wrap.append(tools, hint);
  if (!nodes.some((n) => n.el.classList.contains("is-next"))) nextBtn.disabled = true;

  // Full screen hides the page's result banner: repeat it on the canvas.
  const flash = document.querySelector("[data-flash]");
  if (flash) {
    const toast = document.createElement("div");
    toast.className = "canvas-flash";
    toast.classList.add(flash.classList.contains("no") ? "no" : "ok");
    toast.setAttribute("role", "status");
    toast.textContent = flash.textContent;
    wrap.append(toast);
  }

  // ---------- folds ----------
  const folds = new Map();
  for (const key of inside.keys()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fold";
    b.dataset.fold = key;
    b.addEventListener("click", () => toggle(key));
    world.append(b);
    folds.set(key, b);
  }
  const nameOf = (key) => byKey.get(key)?.el.querySelector(".name")?.getAttribute("title") ?? key;
  function saveFolds() { write(localStorage, FOLDS, [...folded]); }
  // fold or open one branch, keeping its parent still on screen
  function toggle(key) {
    const before = last.at.get(key);
    if (folded.has(key)) folded.delete(key);
    else folded.add(key);
    saveFolds();
    draw();
    const after = last.at.get(key);
    if (before && after) setView({ x: view.x + (before.x - after.x) * view.s, y: view.y + (before.y - after.y) * view.s, s: view.s });
  }
  // only the outermost finished branches: opening one shows everything in it
  function foldDone() {
    const closed = (k) => ["done", "cancelled"].includes(byKey.get(k)?.el.dataset.state ?? "");
    const done = new Set(finishedBranches(nodes, closed));
    const outer = (k) => {
      for (let up = byKey.get(k)?.parent; up !== undefined; up = byKey.get(up)?.parent) {
        if (done.has(up)) return false;
      }
      return true;
    };
    for (const k of done) {
      if (outer(k)) folded.add(k);
    }
    saveFolds();
    draw();
  }

  // ---------- drawing ----------
  function draw() {
    last = layout(nodes, folded);
    world.style.width = `${last.width}px`;
    world.style.height = `${last.height}px`;
    svg.setAttribute("viewBox", `0 0 ${fx(last.width)} ${last.height}`);
    drawNodes();
    drawLines();
    wrap.classList.toggle("hide-found", !showFound);
    foundBtn.setAttribute("aria-pressed", String(showFound));
    for (const [key, b] of folds) drawFold(key, b);
  }
  function drawNodes() {
    for (const n of nodes) {
      const p = last.at.get(n.key);
      n.el.hidden = p === undefined;
      n.el.classList.toggle("folded", folded.has(n.key));
      if (p) { n.el.style.left = `${fx(p.x)}px`; n.el.style.top = `${p.y}px`; }
    }
  }
  function drawLines() {
    for (const line of lines) {
      // arcs: found-while (can be hidden) and a blocker elsewhere in the tree (always shown)
      const found = line.dataset.found !== undefined;
      const arc = found || line.dataset.blocks !== undefined;
      const a = last.at.get(line.dataset.from);
      const b = last.at.get(line.dataset.found ?? line.dataset.blocks ?? line.dataset.to);
      const shown = a !== undefined && b !== undefined && (!found || showFound);
      line.style.display = shown ? "" : "none";
      if (shown) line.setAttribute("d", arc ? foundPath(a, b) : treePath(a, b));
    }
  }
  // the fold button under a parent: "−" open, "+N" folded (red when a blocked task is inside)
  function drawFold(key, b) {
    const p = last.at.get(key);
    b.hidden = p === undefined;
    if (!p) return;
    b.style.left = `${fx(p.x)}px`;
    b.style.top = `${p.y + G.box}px`;
    const isFolded = folded.has(key);
    const kids = inside.get(key) ?? [];
    const has = (test) => isFolded && kids.some((k) => test(byKey.get(k)?.el));
    const tasks = kids.length === 1 ? "task" : "tasks";
    const label = `${isFolded ? "Expand" : "Collapse"} ${nameOf(key)}: ${kids.length} ${tasks} inside`;
    b.textContent = isFolded ? `+${kids.length}` : "−";
    b.setAttribute("aria-expanded", String(!isFolded));
    b.setAttribute("aria-label", label);
    b.title = label;
    b.classList.toggle("is-folded", isFolded);
    b.classList.toggle("has-blocked", has((el) => el?.dataset.state === "blocked"));
    b.classList.toggle("has-next", has((el) => el?.classList.contains("is-next")));
  }

  // ---------- the view ----------
  function setView(v, remember = true) {
    placed = true;
    view = { x: v.x, y: v.y, s: v.s };
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    wrap.style.setProperty("--gx", `${view.x}px`);
    wrap.style.setProperty("--gy", `${view.y}px`);
    let grid = 24 * view.s;
    while (grid < 12) grid *= 4; // zoomed out, the dots thin out instead of turning grey
    wrap.style.setProperty("--gs", `${grid}px`);
    zoomLabel.textContent = `${Math.round(view.s * 100)}%`;
    if (remember) write(sessionStorage, VIEW, { ...view, full });
  }
  // the first view: the whole tree if it reads at that size, else the next task up close
  function firstView() {
    const fit = fitView(last.width, last.height, ...size());
    if (fit.s >= 0.75) return fit;
    const next = nodes.find((n) => n.el.classList.contains("is-next") && !n.el.hidden) ?? nodes.find((n) => !n.el.hidden);
    const p = next && last.at.get(next.key);
    return p ? centreOn(p, 0.85, ...size()) : fit;
  }
  function goToNext() {
    const next = nodes.find((n) => n.el.classList.contains("is-next"));
    if (!next) return;
    let opened = false;
    for (let up = next.parent; up !== undefined; up = byKey.get(up)?.parent) if (folded.delete(up)) opened = true;
    if (opened) { saveFolds(); draw(); }
    const p = last.at.get(next.key);
    if (p) setView(centreOn(p, Math.max(view.s, 0.85), ...size()));
  }
  function setFull(on) {
    const [cx, cy] = middle();
    const at = { x: (cx - view.x) / view.s, y: (cy - view.y) / view.s }; // the world point in the middle
    full = on;
    wrap.classList.toggle("full", on);
    fullBtn.title = on ? "Leave full screen (Esc)" : "Full screen";
    fullBtn.setAttribute("aria-pressed", String(on));
    const [nx, ny] = middle();
    setView({ x: nx - at.x * view.s, y: ny - at.y * view.s, s: view.s });
  }

  // ---------- moving ----------
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let swallowClick = false;
  const local = (e) => {
    const r = wrap.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  wrap.addEventListener("pointerdown", (e) => {
    swallowClick = false;
    if (e.button !== 0 || (e.target instanceof Element && e.target.closest(".canvas-tools, .fold"))) return;
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) drag = { start: local(e), from: view, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], from: view };
      for (const id of pointers.keys()) wrap.setPointerCapture(id);
      if (drag) drag.moved = true;
    }
  });
  wrap.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const v = zoomAt(pinch.from, Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d, ...pinch.mid);
      setView({ x: v.x + mid[0] - pinch.mid[0], y: v.y + mid[1] - pinch.mid[1], s: v.s });
      return;
    }
    if (!drag) return;
    const [x, y] = local(e);
    const dx = x - drag.start[0];
    const dy = y - drag.start[1];
    if (!drag.moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag
    if (!drag.moved) { drag.moved = true; wrap.setPointerCapture(e.pointerId); wrap.classList.add("panning"); }
    setView({ x: drag.from.x + dx, y: drag.from.y + dy, s: view.s });
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      if (drag?.moved) swallowClick = true; // the drag ended over a task: don't open it
      drag = null;
      wrap.classList.remove("panning");
    }
  };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);
  wrap.addEventListener("click", (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  wrap.addEventListener("dragstart", (e) => e.preventDefault()); // links would drag their address
  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    const unit = [1, 16, wrap.clientHeight][e.deltaMode] ?? 1; // pixels, lines, pages
    if (e.ctrlKey || e.metaKey) {
      const dy = Math.max(-60, Math.min(60, e.deltaY * unit)); // a pinch sends small steps, a wheel big ones
      setView(zoomAt(view, Math.exp(-dy * 0.01), ...local(e)));
    } else {
      const sideways = e.shiftKey && e.deltaX === 0;
      setView({ x: view.x - (sideways ? e.deltaY : e.deltaX) * unit, y: view.y - (sideways ? 0 : e.deltaY) * unit, s: view.s });
    }
  }, { passive: false });
  wrap.addEventListener("keydown", (e) => {
    const onTool = e.target instanceof Element && e.target.closest(".canvas-tools, .fold") !== null;
    if (onTool && !e.key.startsWith("Arrow")) return; // Enter and Space press the button
    const pan = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[e.key];
    if (pan) setView({ x: view.x + pan[0], y: view.y + pan[1], s: view.s });
    else if (e.key === "+" || e.key === "=") setView(zoomAt(view, 1.25, ...middle()));
    else if (e.key === "-" || e.key === "_") setView(zoomAt(view, 1 / 1.25, ...middle()));
    else if (e.key === "0") setView(zoomAt(view, 1 / view.s, ...middle()));
    else if (e.key === "1") setView(fitView(last.width, last.height, ...size()));
    else return;
    e.preventDefault();
  });
  // Esc leaves full screen, unless a dialog or the palette is open (then Esc closes that)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !full || e.defaultPrevented) return;
    if (document.querySelector(".drawer:target, dialog[open]") || document.getElementById("palette")?.hidden === false) return;
    setFull(false);
    e.preventDefault();
  });
  // focus never scrolls the canvas box (the view moves instead): bring a focused task into view
  wrap.addEventListener("scroll", () => { wrap.scrollLeft = 0; wrap.scrollTop = 0; });
  wrap.addEventListener("focusin", (e) => {
    const box = e.target instanceof Element ? e.target.closest("a.gn, a.ghost") : null;
    const n = box ? byKey.get(box.dataset.key ?? box.dataset.idea ?? "") : undefined;
    const p = n && last.at.get(n.key);
    if (!p) return;
    const [vw, vh] = size();
    const sx = view.x + p.x * view.s;
    const sy = view.y + p.y * view.s;
    if (sx < 0 || sx > vw || sy < 0 || sy + G.box * view.s > vh) setView(centreOn(p, view.s, vw, vh));
  });

  // ---------- start ----------
  draw();
  if (full) { wrap.classList.add("full"); fullBtn.setAttribute("aria-pressed", "true"); fullBtn.title = "Leave full screen (Esc)"; }
  else fullBtn.setAttribute("aria-pressed", "false");
  // The canvas has no size while Kanban shows: place the view once it first does.
  const place = () => {
    if (placed || wrap.clientWidth === 0) return;
    placed = true;
    setView(saved && Number.isFinite(saved.s) ? saved : firstView(), saved !== null);
  };
  new ResizeObserver(place).observe(wrap);
  place();
}
