// The graph's layout, shared by the page renderer (the rendered file: every task shown) and
// the live canvas (graph.mjs, after a fold): a tidy top-down tree. Each branch is laid out on
// its own, then siblings are packed left to right as close as their outlines allow, row by
// row, so a short branch can sit beside a deep one's lower rows; a parent is centred over its
// first and last child. Pure and deterministic: the same tree and folds give the same
// numbers. Plain JS so the browser runs it as is; its types are in layout.d.mts.

// px: a node's width and height, the space between neighbours, row to row, the margins
export const G = { node: 148, box: 56, gap: 20, level: 104, top: 26, side: 24, bottom: 24 };

const kidsOf = (nodes) => {
  const kids = new Map(nodes.map((n) => [n.key, []]));
  const roots = [];
  for (const n of nodes) ((n.parent === undefined ? undefined : kids.get(n.parent)) ?? roots).push(n.key);
  return { kids, roots };
};

// Siblings' outlines (each row's left and right edge, relative to the sibling's centre)
// packed left to right: each one goes as far left as every row it shares allows.
function pack(keys, shapes) {
  const left = [];
  const right = [];
  const offs = [];
  for (const k of keys) {
    const s = shapes.get(k);
    let off = 0;
    if (offs.length > 0) {
      off = -Infinity;
      for (let d = 0; d < Math.min(right.length, s.left.length); d++) off = Math.max(off, right[d] - s.left[d] + G.gap);
    }
    offs.push(off);
    for (let d = 0; d < s.left.length; d++) {
      if (d < left.length) right[d] = s.right[d] + off; // it sits right of everything on this row
      else { left.push(s.left[d] + off); right.push(s.right[d] + off); }
    }
  }
  return { left, right, offs };
}

// Big trees hang their lowest branches as indented columns under the parent (a bracket joins
// each task to its parent, steps indented under their task, like a file tree), so the tree
// grows down instead of tens of thousands of pixels across. In a tree of more than COMPACT
// shown tasks: a branch of FEW or more tasks with one level below it, or with two and at
// most MOST tasks (a bigger one keeps its children side by side, each its own column); in
// any tree: a parent of MANY or more leaf tasks.
export const STACK = { dx: 20, top: 24, pitch: 72, spine: 64, compact: 40, few: 3, most: 10, many: 6 };

/**
 * nodes: in preorder (a parent before its children, siblings in order), each { key, parent? }.
 * folded: keys whose subtasks are hidden. Returns each shown node's centre x and top y (px),
 * stack: true for a task in a column, and the size of the whole.
 */
export function layout(nodes, folded = new Set()) {
  const { kids, roots } = kidsOf(nodes);
  const shownKids = (k) => (folded.has(k) ? [] : kids.get(k) ?? []);
  const shown = shownOf(nodes, kids, folded);
  const compact = shown.size > STACK.compact;
  const { shapes, rel, columns } = outlines(nodes, shownKids, compact);
  const top = pack(roots, shapes);
  roots.forEach((k, i) => rel.set(k, top.offs[i]));
  return framed(place(nodes, shown, rel, columns));
}

// what shows: every task not under a fold
function shownOf(nodes, kids, folded) {
  const shown = new Set();
  for (const n of nodes) {
    if (n.parent === undefined || !kids.has(n.parent) || (shown.has(n.parent) && !folded.has(n.parent))) shown.add(n.key);
  }
  return shown;
}

// a column's tasks, depth first, each [key, x and y from the column's parent]; returns the next y
function hang(shownKids, k, dx, y, out) {
  for (const c of shownKids(k)) {
    out.push([c, dx + STACK.dx, y]);
    y = hang(shownKids, c, dx + STACK.dx, y + STACK.pitch, out);
  }
  return y;
}

// does this branch hang as a column? (see STACK)
const hangs = (compact, h, tasks, kidCount) => (compact ? tasks >= STACK.few && (h === 1 || (h === 2 && tasks <= STACK.most)) : h === 1 && kidCount >= STACK.many);

// children before parents: every branch's height, size, outline and children's offsets
function outlines(nodes, shownKids, compact) {
  const half = G.node / 2;
  const height = new Map();
  const size = new Map();
  const columns = new Map();
  const shapes = new Map();
  const rel = new Map();
  for (const n of [...nodes].reverse()) {
    const ks = shownKids(n.key);
    height.set(n.key, ks.length === 0 ? 0 : 1 + Math.max(...ks.map((k) => height.get(k) ?? 0)));
    size.set(n.key, ks.reduce((t, k) => t + 1 + (size.get(k) ?? 0), 0));
    if (ks.length === 0) {
      shapes.set(n.key, { left: [-half], right: [half] });
    } else if (hangs(compact, height.get(n.key) ?? 0, size.get(n.key) ?? 0, ks.length)) {
      // a column under the parent, the bracket's spine to its left: it covers every row it reaches
      const col = [];
      const end = hang(shownKids, n.key, 0, G.box + STACK.top, col);
      columns.set(n.key, col);
      const rows = Math.floor((end - STACK.pitch + G.box - 1) / G.level); // every row the column reaches
      const right = Math.max(...col.map(([, dx]) => dx)) + half;
      shapes.set(n.key, { left: [-half, ...new Array(rows).fill(-STACK.spine - 2)], right: [half, ...new Array(rows).fill(right)] });
    } else {
      const p = pack(ks, shapes);
      const centre = (p.offs[0] + p.offs.at(-1)) / 2;
      ks.forEach((k, i) => rel.set(k, p.offs[i] - centre));
      shapes.set(n.key, { left: [-half, ...p.left.map((v) => v - centre)], right: [half, ...p.right.map((v) => v - centre)] });
    }
  }
  return { shapes, rel, columns };
}

// parents before children: absolute places, for the shown nodes only
function place(nodes, shown, rel, columns) {
  const at = new Map();
  for (const n of nodes) {
    if (!shown.has(n.key) || at.has(n.key)) continue; // hidden, or placed in its column
    const up = n.parent === undefined ? undefined : at.get(n.parent);
    const p = { x: (up?.x ?? 0) + (rel.get(n.key) ?? 0), y: up === undefined ? G.top : up.y + G.level };
    at.set(n.key, p);
    for (const [k, dx, dy] of columns.get(n.key) ?? []) at.set(k, { x: p.x + dx, y: p.y + dy, stack: true });
  }
  return at;
}

// shifted so the leftmost node sits at the side margin; the size of the whole
function framed(at) {
  if (at.size === 0) return { at, width: 0, height: 0 };
  const half = G.node / 2;
  let min = Infinity;
  let max = -Infinity;
  let low = 0;
  for (const p of at.values()) {
    min = Math.min(min, p.x - half);
    max = Math.max(max, p.x + half);
    low = Math.max(low, p.y);
  }
  const shift = G.side - min;
  for (const p of at.values()) p.x += shift;
  return { at, width: max - min + 2 * G.side, height: low + G.box + G.bottom };
}

// The one numeric formatter for every drawn number: positions, sizes, line coordinates
// and bar widths, on the rendered page and on the live canvas alike (convention
// fx-display-format). One decimal, so the same layout always prints the same bytes.
export const fx = (n) => n.toFixed(1);
// a parent's line down to its child; to a stacked child, down the bracket and in from the left
export const treePath = (p, c) => {
  const y1 = p.y + G.box;
  if (c.stack) {
    const sx = p.x - STACK.spine;
    const cy = c.y + G.box / 2;
    return `M${fx(sx)} ${y1}V${cy - 6}Q${fx(sx)} ${cy} ${fx(sx + 6)} ${cy}H${fx(c.x - G.node / 2)}`;
  }
  const ym = (y1 + c.y) / 2;
  return `M${fx(p.x)} ${y1}C${fx(p.x)} ${ym} ${fx(c.x)} ${ym} ${fx(c.x)} ${c.y}`;
};
// the dotted line from where a task was found to the task, arcing above both
export const foundPath = (a, b) => {
  const y1 = a.y + G.box / 2;
  const y2 = b.y + G.box / 2;
  return `M${fx(a.x)} ${y1}Q${fx((a.x + b.x) / 2)} ${Math.min(y1, y2) - G.box} ${fx(b.x)} ${y2}`;
};

// Every task under key, at any depth.
export function subtree(nodes, key) {
  const { kids } = kidsOf(nodes);
  const out = [];
  const stack = [...(kids.get(key) ?? [])].reverse();
  while (stack.length > 0) {
    const k = stack.pop();
    out.push(k);
    stack.push(...[...(kids.get(k) ?? [])].reverse());
  }
  return out;
}

// The parents whose whole branch is finished: every task under them is closed.
export function finishedBranches(nodes, isClosed) {
  const { kids } = kidsOf(nodes);
  return nodes.filter((n) => (kids.get(n.key)?.length ?? 0) > 0 && subtree(nodes, n.key).every((k) => isClosed(k))).map((n) => n.key);
}

// ---------- the canvas's view: where the world sits and how big ----------

export const ZOOM = { min: 0.1, max: 2.5 };
const clamp = (s) => Math.min(ZOOM.max, Math.max(ZOOM.min, s));

// Zoom by factor, keeping the point (cx, cy) of the viewport where it is.
export function zoomAt(view, factor, cx, cy) {
  const s = clamp(view.s * factor);
  const k = s / view.s;
  return { x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, s };
}

// The whole graph in the viewport, never bigger than life size.
export function fitView(width, height, vw, vh, pad = 24) {
  const s = clamp(Math.min(1, (vw - 2 * pad) / width, (vh - 2 * pad) / height));
  return { x: (vw - width * s) / 2, y: Math.max(pad, (vh - height * s) / 2), s };
}

// A node at the middle across and a third of the way down, at scale s.
export const centreOn = (p, s, vw, vh) => ({ x: vw / 2 - p.x * s, y: vh / 3 - (p.y + G.box / 2) * s, s: clamp(s) });

// ---------- reading a big tree zoomed out ----------

// Below FAR the boxes turn into tiles coloured by state and each branch gets a label at a
// readable size (the live canvas, like Figma zoomed out).
export const FAR = 0.5;
export const isFar = (s) => s < FAR;

// Each parent's branch, across: from its leftmost shown box's left edge to its rightmost's
// right edge (px, the layout's). Only parents with a shown child.
export function branchSpans(nodes, at) {
  const { kids } = kidsOf(nodes);
  const half = G.node / 2;
  const spans = new Map();
  for (const n of [...nodes].reverse()) {
    const p = at.get(n.key);
    if (!p) continue;
    let lo = p.x - half;
    let hi = p.x + half;
    for (const k of kids.get(n.key) ?? []) {
      const c = spans.get(k);
      if (c) { lo = Math.min(lo, c[0]); hi = Math.max(hi, c[1]); }
    }
    spans.set(n.key, [lo, hi]);
  }
  return new Map([...spans].filter(([k]) => (kids.get(k) ?? []).some((c) => at.has(c))));
}

// A branch's label shows when it has room on screen (LABEL.min px across); below LABEL.deep
// only the top two levels are labelled, so rows of labels never stack on each other.
export const LABEL = { min: 72, deep: 0.22 };
export const labelFits = (span, s, depth) => (span[1] - span[0]) * s >= LABEL.min && (depth <= 1 || s >= LABEL.deep);

// ---------- the minimap ----------

export const MINI = { w: 168, h: 96 };
// the scale that fits the whole layout in at most maxW × maxH
export const miniScale = (width, height, maxW = MINI.w, maxH = MINI.h) => (width > 0 && height > 0 ? Math.min(maxW / width, maxH / height) : 1);
// the part of the layout a viewport of vw × vh shows
export const viewRect = (view, vw, vh) => ({ x: -view.x / view.s, y: -view.y / view.s, w: vw / view.s, h: vh / view.s });
// the view that puts layout point (x, y) in the middle, at scale s
export const centreAt = (x, y, s, vw, vh) => ({ x: vw / 2 - x * s, y: vh / 2 - y * s, s: clamp(s) });

// ---------- motion ----------

// GSAP's power3.out: quick, then settling. t past 0..1 is held at the ends.
export const ease = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
const lerp = (a, b, k) => a + (b - a) * k;

// The camera part way from view a to view b (t from 0 to 1, eased): the point in the middle
// of the viewport travels in a straight line while the scale changes evenly (geometrically),
// so a zoom never swings sideways.
export function viewBetween(a, b, t, vw, vh) {
  const k = ease(t);
  const s = a.s * (b.s / a.s) ** k;
  const cx = lerp((vw / 2 - a.x) / a.s, (vw / 2 - b.x) / b.s, k);
  const cy = lerp((vh / 2 - a.y) / a.s, (vh / 2 - b.y) / b.s, k);
  return { x: vw / 2 - cx * s, y: vh / 2 - cy * s, s };
}

// Places part way from one layout to the next (a fold opening or closing): a box shown in
// both moves from its old place to its new one; one appearing grows out of its nearest
// ancestor's old place; one going moves into its nearest ancestor's new place and is gone at
// the end. `fade` is how much of each box shows (0 to 1).
export function placesBetween(nodes, from, to, t) {
  const parentOf = new Map(nodes.map((n) => [n.key, n.parent]));
  const anchor = (key, map) => {
    for (let k = parentOf.get(key); k !== undefined; k = parentOf.get(k)) if (map.has(k)) return map.get(k);
    return undefined;
  };
  const k = ease(t);
  const at = new Map();
  const fade = new Map();
  for (const n of nodes) {
    const was = from.get(n.key);
    const will = to.get(n.key);
    if (!was && !will) continue;
    if (!will && k >= 1) continue;
    const a = was ?? anchor(n.key, from);
    const b = will ?? anchor(n.key, to);
    if (!a || !b) continue;
    at.set(n.key, { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), ...((will ?? was)?.stack ? { stack: true } : {}) });
    fade.set(n.key, was && will ? 1 : was ? 1 - k : k);
  }
  return { at, fade };
}
