// The graph's layout (src/serve/layout.mjs), shared by the rendered page and the live canvas:
// every shown task gets a place and none overlap, at any size, with any branches folded;
// big trees stay narrow; the canvas's zoom keeps the point under the pointer still.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { G, STACK, centreOn, finishedBranches, fitView, foundPath, fx, layout, subtree, treePath, zoomAt, type LayoutNode, type Point } from "../src/serve/layout.mjs";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { fold } from "../src/fold/fold.ts";
import { renderHtml } from "../src/render/html.ts";

// A random tree in preorder (a seeded generator, so a failure replays), up to `depth` deep.
function randomTree(seed: number, count: number, depth = 5): LayoutNode[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: LayoutNode[] = [];
  const grow = (parent: string | undefined, d: number) => {
    const n = d === 0 ? 1 + Math.floor(rnd() * 3) : Math.floor(rnd() * (d < depth ? 7 : 0));
    for (let i = 0; i < n && out.length < count; i++) {
      const key = `node:n${out.length}`;
      out.push(parent === undefined ? { key } : { key, parent });
      grow(key, d + 1);
    }
  };
  while (out.length < count) grow(undefined, 0);
  return out;
}

// The tree of a real build: 6 epics × 4 features × 5 tasks, some tasks with 3 steps.
function buildTree(): LayoutNode[] {
  const out: LayoutNode[] = [{ key: "node:platform" }];
  for (const [ei, e] of ["auth", "billing", "search", "reports", "mobile", "admin"].entries()) {
    out.push({ key: `node:${e}`, parent: "node:platform" });
    for (const f of ["api", "ui", "data", "tests"]) {
      out.push({ key: `node:${e}_${f}`, parent: `node:${e}` });
      for (let t = 1; t <= 5; t++) {
        out.push({ key: `node:${e}_${f}_${t}`, parent: `node:${e}_${f}` });
        if ((ei * 20 + t) % 7 === 0) for (let s = 1; s <= 3; s++) out.push({ key: `node:${e}_${f}_${t}_${s}`, parent: `node:${e}_${f}_${t}` });
      }
    }
  }
  return out;
}

const hiddenBy = (nodes: LayoutNode[], folded: ReadonlySet<string>) => new Set([...folded].flatMap((k) => subtree(nodes, k)));

// Nodes never overlap, with at least the gap between neighbours side by side.
function assertApart(at: Map<string, Point>, label: string) {
  const ps = [...at];
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const [ka, a] = ps[i] as [string, Point];
      const [kb, b] = ps[j] as [string, Point];
      const side = Math.abs(a.x - b.x) >= G.node + G.gap - 0.01;
      const above = a.y + G.box <= b.y || b.y + G.box <= a.y;
      assert.ok(side || above, `${label}: ${ka} overlaps ${kb}`);
    }
  }
}

test("every shown task gets a place, nothing under a fold does, and no two overlap: random trees up to 250 tasks", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const nodes = randomTree(seed, 10 + ((seed * 37) % 240));
    const folded = new Set(nodes.filter((_, i) => (i * seed) % 11 === 3).map((n) => n.key));
    for (const folds of [new Set<string>(), folded]) {
      const L = layout(nodes, folds);
      const hidden = hiddenBy(nodes, folds);
      for (const n of nodes) assert.equal(L.at.has(n.key), !hidden.has(n.key), `seed ${seed}: ${n.key}`);
      assertApart(L.at, `seed ${seed}${folds.size > 0 ? " folded" : ""}`);
      for (const p of L.at.values()) {
        assert.ok(p.x - G.node / 2 >= G.side - 0.01 && p.x + G.node / 2 <= L.width - G.side + 0.01, `seed ${seed}: inside the width`);
        assert.ok(p.y >= G.top && p.y + G.box <= L.height - G.bottom, `seed ${seed}: inside the height`);
      }
      assert.deepEqual(layout(nodes, folds), L, "the same tree and folds give the same places");
    }
  }
});

test("a parent sits one row above its children, centred over the first and last; a small tree is never stacked", () => {
  const nodes: LayoutNode[] = [
    { key: "d" }, { key: "m", parent: "d" }, { key: "f", parent: "m" }, { key: "v", parent: "m" },
    { key: "c", parent: "v" }, { key: "l", parent: "v" }, { key: "o", parent: "v" }, { key: "t", parent: "d" }, { key: "x", parent: "d" },
  ];
  const { at } = layout(nodes);
  const p = (k: string) => at.get(k) as Point;
  for (const n of nodes) {
    if (n.parent === undefined) continue;
    assert.equal(p(n.key).y - p(n.parent).y, G.level, n.key);
    assert.equal(p(n.key).stack, undefined, n.key);
  }
  assert.equal(p("v").x, (p("c").x + p("o").x) / 2);
  assert.equal(p("d").x, (p("m").x + p("x").x) / 2);
  assert.deepEqual(["c", "l", "o"].map((k) => p(k).x), ["c", "l", "o"].map((k) => p(k).x).sort((a, b) => a - b)); // in order
  // a short branch packs beside a deep one's lower rows: t sits closer than one slot per leaf
  assert.ok(p("t").x - p("m").x < 2 * (G.node + G.gap));
});

test("folding a branch hides everything in it and frees its room; the folded task stays", () => {
  const nodes = buildTree();
  const open = layout(nodes);
  const folded = layout(nodes, new Set(["node:auth"]));
  assert.ok(folded.at.has("node:auth"));
  for (const k of subtree(nodes, "node:auth")) assert.ok(!folded.at.has(k), k);
  assert.equal(folded.at.size, open.at.size - subtree(nodes, "node:auth").length);
  assert.ok(folded.width < open.width);
});

test("100+ tasks stay readable: big trees hang their lowest branches as columns, so the tree grows down, not across", () => {
  const nodes = buildTree();
  assert.ok(nodes.length > 200);
  const L = layout(nodes);
  const leaves = nodes.filter((n) => !nodes.some((c) => c.parent === n.key)).length;
  assert.ok(L.width < 5200, `${L.width}px across`);
  assert.ok(L.width * 4 < leaves * (G.node + G.gap), "at least 4x narrower than a slot per leaf");
  assertApart(L.at, "the build");
  // a column: each task a pitch below the last, indented under its parent, joined by a bracket
  const ui = ["node:search_ui_1", "node:search_ui_2", "node:search_ui_3"].map((k) => L.at.get(k) as Point);
  assert.ok(ui.every((p) => p.stack === true));
  assert.equal((ui[1] as Point).y - (ui[0] as Point).y, STACK.pitch);
  const parent = L.at.get("node:search_ui") as Point;
  assert.equal((ui[0] as Point).x - parent.x, STACK.dx);
  assert.match(treePath(parent, ui[0] as Point), new RegExp(`^M${(parent.x - STACK.spine).toFixed(1)} ${parent.y + G.box}V`));
  // epics and features stay a tree above the columns
  assert.equal((L.at.get("node:search") as Point).stack, undefined);
  // any tree: six or more leaf subtasks under one parent stack
  const fan: LayoutNode[] = [{ key: "p" }, ...[1, 2, 3, 4, 5, 6].map((i) => ({ key: `k${i}`, parent: "p" }))];
  assert.ok([...layout(fan).at.values()].filter((p) => p.stack).length === 6);
  assert.ok([...layout(fan.slice(0, 6)).at.values()].every((p) => p.stack === undefined));
});

test("lines: a parent's runs from its bottom to the child's top; a found-while arc rises above both", () => {
  const a = { x: 100, y: 26 };
  const b = { x: 300, y: 130 };
  assert.equal(treePath(a, b), `M100.0 ${26 + G.box}C100.0 ${(26 + G.box + 130) / 2} 300.0 ${(26 + G.box + 130) / 2} 300.0 130`);
  assert.match(foundPath(a, b), new RegExp(`^M100\\.0 ${26 + G.box / 2}Q200\\.0 ${26 + G.box / 2 - G.box} 300\\.0 ${130 + G.box / 2}$`));
});

test("subtree and finished branches", () => {
  const nodes: LayoutNode[] = [{ key: "a" }, { key: "b", parent: "a" }, { key: "c", parent: "b" }, { key: "d", parent: "a" }, { key: "e" }, { key: "f", parent: "e" }];
  assert.deepEqual(subtree(nodes, "a"), ["b", "c", "d"]);
  assert.deepEqual(subtree(nodes, "c"), []);
  const closed = new Set(["c", "f"]);
  assert.deepEqual(finishedBranches(nodes, (k) => closed.has(k)), ["b", "e"]);
});

test("the canvas: zoom keeps the point under the pointer still and stays within 10%–250%; fit never enlarges; centring", () => {
  const view = { x: -200, y: 40, s: 0.5 };
  const worldAt = (v: typeof view, cx: number, cy: number) => [(cx - v.x) / v.s, (cy - v.y) / v.s];
  const zoomed = zoomAt(view, 1.6, 300, 200);
  assert.equal(zoomed.s, 0.8);
  assert.deepEqual(worldAt(zoomed, 300, 200).map((v) => v.toFixed(6)), worldAt(view, 300, 200).map((v) => v.toFixed(6)));
  assert.equal(zoomAt(view, 100, 0, 0).s, 2.5);
  assert.equal(zoomAt(view, 0.001, 0, 0).s, 0.1);
  const small = fitView(400, 300, 1200, 600);
  assert.equal(small.s, 1); // a small tree is shown life size, centred
  assert.equal(small.x, 400);
  const big = fitView(4000, 1000, 1200, 600);
  assert.ok(big.s < 1 && 4000 * big.s <= 1200 - 48 + 0.01 && 1000 * big.s <= 600 - 48 + 0.01);
  const c = centreOn({ x: 1000, y: 500 }, 1, 1200, 600);
  assert.equal(c.x + 1000, 600);
  assert.equal(c.y + 500 + G.box / 2, 200);
});

// ---------- one numeric formatter (convention fx-display-format, conventions/conventions.jsonl) ----------

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [join(dir, e.name)] : []));

test("fx-display-format: layout.mjs fx is the one numeric formatter; nothing else in src calls toFixed", () => {
  const calls = sources(join(ROOT, "src")).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\.toFixed\(/g)].map(() => relative(ROOT, f)));
  assert.deepEqual(calls, ["src/serve/layout.mjs"]);
  assert.equal(fx(12.345), "12.3");
  // the rendered page, the live canvas and the palette each take it from there
  for (const f of ["src/render/html.ts", "src/serve/graph.mjs", "src/serve/app.mjs"]) {
    assert.match(readFileSync(join(ROOT, f), "utf8"), /import \{[^}]*\bfx\b[^}]*\} from "(?:\.\.\/serve\/|\.\/)layout\.mjs";/, f);
  }
});

test("fx-display-format: the rendered graph prints its layout through fx (node places, canvas size, every line)", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const born = (id: string, parent_id?: string) => wp.submit({ stream: "fx", kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
  await born("root");
  for (const [id, up] of [["a", "root"], ["b", "root"], ["c", "root"], ["a1", "a"], ["a2", "a"], ["b1", "b"]] as const) await born(id, up);
  const events = await store.readStream("fx");
  const html = renderHtml(fold(events, registry), "fx", "h", events);
  // the tree as the page lists it (preorder, with each node's parent), laid out again here
  const placed = [...html.matchAll(/<a class="gn[^"]*" href="#t\d+" style="left:([^;]+)px;top:(\d+)px"[^>]*?(?: data-parent="([^"]+)")? data-key="([^"]+)"/g)]
    .map((m) => ({ left: m[1] as string, top: Number(m[2]), parent: m[3], key: m[4] as string }));
  assert.equal(placed.length, 7);
  const L = layout(placed.map((n) => (n.parent === undefined ? { key: n.key } : { key: n.key, parent: n.parent })));
  for (const n of placed) {
    const p = L.at.get(n.key) as Point;
    assert.equal(n.left, fx(p.x), n.key);
    assert.equal(n.top, p.y, n.key);
  }
  assert.ok(html.includes(`aria-label="Tasks as a tree" style="width:${fx(L.width)}px;height:${L.height}px"`), "the canvas size");
  for (const n of placed.filter((x) => x.parent !== undefined)) {
    const d = treePath(L.at.get(n.parent as string) as Point, L.at.get(n.key) as Point);
    assert.ok(html.includes(`data-to="${n.key}" d="${d}"`), `${n.key}: ${d}`);
  }
});
