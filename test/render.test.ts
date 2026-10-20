// D1 — the thin HTML page and the text tree. The page check is the automatable half
// of manual test M1: every node in the fold appears exactly once, with the fold's
// state, drain, cursor and active flags, and the page carries the dump hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { canonicalJson, fold } from "../src/fold/fold.ts";
import { renderHtml } from "../src/render/html.ts";
import { streamView, textTree } from "../src/render/tree-view.ts";

const S = "tasktree-dash";

// dashboard{metrics_card{improve_visual{colors, font, tokens}}, table, filters}:
// improve_visual drains (done, cancelled, done); starting table is moving on, so tira
// closes improve_visual and then metrics_card; table is in progress (active); a START on
// filters is rejected by the one-active gate.
async function scenario() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const born = (id: string, parent_id?: string, extra: Record<string, unknown> = {}) =>
    wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: { ...(parent_id ? { parent_id } : {}), ...extra } });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}) =>
    wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  await born("dashboard");
  await born("metrics_card", "dashboard");
  await born("improve_visual", "metrics_card");
  for (const id of ["colors", "font"]) await born(id, "improve_visual");
  await born("table", "dashboard");
  await born("filters", "dashboard");
  await send("colors", "START");
  await send("colors", "COMPLETE", { evidenceRef: "palette.png" });
  await send("font", "CANCEL");
  await born("tokens", "improve_visual", { kind: "discovered", discovered_during: "colors" });
  await send("tokens", "START");
  await send("tokens", "COMPLETE", { evidenceRef: "token-spec.md" });
  await send("table", "START");
  await send("filters", "START"); // rejected: table is active
  await wp.submit({ stream: S, kind: "create", entity: { type: "idea", id: "7" } });
  const events = await store.readStream(S);
  return { r: fold(events, registry), events };
}

const attrs = (html: string) =>
  [...html.matchAll(/data-key="([^"]+)" data-state="([^"]+)" data-drained="(true|false)" data-cursor="(true|false)" data-active="(true|false)" data-depth="(\d+)"/g)]
    .map(([, key, state, drained, cursor, active, depth]) => ({ key, state, drained: drained === "true", cursor: cursor === "true", active: active === "true", depth: Number(depth) }));

test("M1 oracle: the page shows every fold node exactly once, with the fold's flags", async () => {
  const { r, events } = await scenario();
  const hash = createHash("sha256").update(canonicalJson(r)).digest("hex");
  const html = renderHtml(r, S, hash, events);
  const nodes = attrs(html);
  const tree = r.entities.filter((e) => e.stream === S && e.tree);
  assert.equal(nodes.length, tree.length);
  assert.equal(new Set(nodes.map((n) => n.key)).size, nodes.length);
  const summary = r.trees[S]?.node;
  for (const e of tree) {
    const n = nodes.find((x) => x.key === e.key);
    assert.ok(n, `missing ${e.key}`);
    assert.equal(n.state, e.regions.lifecycle, e.key);
    assert.equal(n.drained, r.derived[S]?.[e.key]?.drained === true, e.key);
    assert.equal(n.cursor, summary?.cursor === e.key, e.key);
    assert.equal(n.active, summary?.active.includes(e.key), e.key);
    assert.equal(n.depth, e.tree?.depth, e.key);
  }
  // the scenario exercises every flag, so none of the checks above is vacuous
  assert.deepEqual(nodes.filter((n) => n.drained).map((n) => n.key), ["node:metrics_card", "node:improve_visual"]);
  assert.deepEqual(nodes.filter((n) => n.active).map((n) => n.key), ["node:table"]);
  assert.deepEqual(nodes.filter((n) => n.cursor).map((n) => n.key), ["node:table"]);
  assert.match(html, /<b>2<\/b> drained<\/li>/);
  assert.match(html, /<span class="mark drained">drained<\/span>/);
  assert.match(html, new RegExp(`data-node-count="${tree.length}" data-fold-tree-count="${tree.length}"`));
  assert.match(html, new RegExp(`data-dump-hash="${hash}"`));
  assert.match(html, /one active task: node:table is already active/); // the rejection is shown
  // progress counts closed = done + cancelled, overall and per parent
  assert.match(html, /<div class="big" title="tasks closed, of all tasks">3<small>\/5<\/small><\/div>/); // tasks = the train's stops
  assert.match(html, /<b>2<\/b> left<\/li>/);
  // the train: closed stops fill the track; the train rides on the cursor
  const stops = [...html.matchAll(/<li class="(stop [^"]*)"[^>]*><a class="stop-link"[^>]*data-key="([^"]+)"/g)];
  assert.deepEqual(stops.filter((m) => m[1]?.split(" ").includes("closed")).map((m) => m[2]), ["node:colors", "node:font", "node:tokens"]);
  assert.match(html, /data-key="node:table"[^>]*><svg class="train"/);
  // one short line per parent: closed / total and what's left
  assert.match(html, /aria-label="dashboard: 1 of 3 closed"[^]*?<span class="ct">1\/3 <span class="left">· 2 left<\/span>/);
  assert.match(html, /aria-label="improve_visual: 3 of 3 closed"[^]*?<span class="ct">3\/3 <span class="left">· all closed<\/span>/);
  assert.match(html, /aria-label="improve_visual">[^]*?3\/3 children closed/);
  assert.match(html, /aria-label="dashboard">[^]*?1\/3 children closed/);
  // the board holds the work (leaves), with the cursor's card marked next; parents sit in the strip above
  assert.equal((html.match(/<a class="card[ "]/g) ?? []).length, 5);
  assert.match(html, /<a class="card is-next" href="#t\d+"[^>]*><span class="pin">◆ now<\/span><div class="t">table<\/div>/);
  // the halo marks the active task only; payloads read as words, not JSON
  assert.equal((html.match(/<li class="stop [^"]*is-active/g) ?? []).length, 1);
  assert.match(html, /<div class="ev-detail">under dashboard<\/div>/);
  assert.doesNotMatch(html, /\{&#34;parent_id&#34;/);
  assert.equal((html.match(/<a class="br" /g) ?? []).length, 3);
  assert.match(html, /idea:7/); // non-tree entities are listed too
});

test("proof 4: tira-closed parents carry a quiet mark; every node is one click from its history", async () => {
  const { r, events } = await scenario();
  const html = renderHtml(r, S, "h", events);
  const closed = [...html.matchAll(/data-key="([^"]+)"[^>]*data-closed-by-tira="true"/g)].map((m) => m[1]);
  assert.deepEqual(closed, ["node:metrics_card", "node:improve_visual"]);
  assert.equal((html.match(/<span class="tira-mark"/g) ?? []).length, 2); // a leaf on each, on its branch line
  assert.equal((html.match(/<span class="mark tira">closed by tira<\/span>/g) ?? []).length, 2); // and said in words in their drawers
  assert.match(html, /<b>2<\/b> by tira<\/li>/);
  // one click: every tree node links to a drawer that exists and holds its history
  const links = [...html.matchAll(/<a class="(?:stop-link|route)" href="#(t\d+)"/g)].map((m) => m[1] as string);
  assert.equal(links.length, r.entities.filter((e) => e.tree).length);
  for (const id of links) assert.match(html, new RegExp(`<section class="drawer" id="${id}"[^]*?history \\(\\d+\\)`));
  // every tree node has a history with at least its birth
  const histories = [...html.matchAll(/data-key="(node:[^"]+)"[^>]*data-history="(\d+)"/g)];
  assert.equal(histories.length, r.entities.filter((e) => e.tree).length);
  for (const [, key, n] of histories) assert.ok(Number(n) >= 1, `${key} has no history`);
  // tira's lines say why and cite the move; the refused START on filters is in filters' history
  const tableStart = events.find((e) => e.type === "node.start" && e.metadata.actor === "isha" && (e.data as { entity?: { id?: string } }).entity?.id === "table");
  assert.match(html, new RegExp(`<span class="ev-what">node\\.complete</span><span class="ev-who">tira</span><span class="ev-seq">seq \\d+</span></div><div class="ev-detail">work moved on \\(START node:table\\) · cites seq ${tableStart?.seq}</div>`));
  assert.match(html, /<span class="ev-what">rejected START<\/span><span class="ev-who">isha<\/span><span class="ev-seq">seq \d+<\/span><\/div><div class="ev-detail">gate: one active task: node:table is already active<\/div>/);
});

test("a finished-but-open parent is tagged: tira closes it when you move on", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "p" }, actor: "isha" });
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "c" }, actor: "isha", payload: { parent_id: "p" } });
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "q" }, actor: "isha" });
  await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "c" }, event: "CANCEL", actor: "isha" });
  const events = await store.readStream(S);
  const r = fold(events, registry);
  const html = renderHtml(r, S, "h", events);
  assert.match(html, /data-key="node:p"[^>]*data-awaiting-close="true"/);
  assert.match(html, /data-key="node:q"[^>]*data-awaiting-close="false"/);
  assert.equal((html.match(/<span class="mark wait">tira closes it when you move on<\/span>/g) ?? []).length, 1);
  assert.equal((html.match(/<span class="wait-ring"/g) ?? []).length, 1); // the dashed ring on its branch line
  assert.match(textTree(streamView(r, S)).join("\n"), /^p\s+unstarted\s+drained {2}\(tira closes when you move on\)$/m);
  // the tree marks the cursor (q), not the active task (none here), with ◆ next
  assert.equal((html.match(/<svg class="train"/g) ?? []).length, 1);
  assert.match(html, /data-key="node:q"[^>]*><svg class="train"[^]*?<span class="here">next<\/span>/);
});

test("render --at N shows nothing from after N; tira's mark only shows on closes that still stand", async () => {
  const { events } = await scenario();
  const registry = defaultRegistry();
  // folded to just before table's START: tira hasn't closed anything yet
  const firstTira = events.find((e) => e.metadata.actor === "tira")?.seq as number;
  const early = fold(events, registry, { upToSeq: firstTira - 1 });
  const html = renderHtml(early, S, "h", events);
  assert.doesNotMatch(html, /cites seq|ev-who">tira<|class="tira-mark"/);
  assert.match(html, /data-key="node:improve_visual"[^>]*data-awaiting-close="true"/);
  for (const [, n] of html.matchAll(/class="ev-seq">seq (\d+)</g)) assert.ok(Number(n) < firstTira, `history shows seq ${n}`);
  // tira closes p; then a person re-opens and completes it: the card no longer credits tira
  const store = new SqliteEventStore();
  const wp = new WritePath(store, registry);
  const node = (id: string, payload: Record<string, unknown> = {}) => wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}) => wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  await node("p");
  await node("c", { parent_id: "p" });
  await node("q");
  await send("c", "CANCEL");
  await send("q", "START"); // tira closes p
  const mid = await store.readStream(S);
  assert.match(renderHtml(fold(mid, registry), S, "h", mid), /data-key="node:p"[^>]*data-closed-by-tira="true"/);
  await send("q", "COMPLETE", { evidenceRef: "q.md" });
  await send("p", "REOPEN", { reason: "one more check" });
  await send("p", "COMPLETE", { evidenceRef: "checked" });
  const end = await store.readStream(S);
  const after = renderHtml(fold(end, registry), S, "h", end);
  assert.match(after, /data-key="node:p"[^>]*data-closed-by-tira="false"/);
  assert.doesNotMatch(after, /class="tira-mark"/);
});

test("only the active task pulses; long names are shortened on the train, full in the drawer", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const long = "a_really_long_task_name_for_the_tree_view";
  const node = (id: string, payload: Record<string, unknown> = {}) => wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload });
  const send = (id: string, event: string) => wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor: "isha" });
  await node("p");
  await node("c", { parent_id: "p" });
  await node(long, { parent_id: "p" });
  await send("p", "START"); // p is in progress...
  await send("c", "START"); // ...but c, below it, is the active task
  const events = await store.readStream(S);
  const html = renderHtml(fold(events, registry), S, "h", events);
  const pulsing = [...html.matchAll(/<li class="(stop [^"]*)"[^>]*><a class="stop-link"[^>]*data-key="([^"]+)"/g)].filter((m) => m[1]?.includes("is-active")).map((m) => m[2]);
  assert.deepEqual(pulsing, ["node:c"]); // p is in progress too, but c (below it) is the active task
  assert.match(html, /<span class="name" title="a_really_long_task_name_for_the_tree_view">a_really_long_task_na…<\/span>/);
  assert.match(html, new RegExp(`<h2>${long}</h2>`));
});

test("render is deterministic and escapes every user-supplied string", async () => {
  const { r, events } = await scenario();
  assert.equal(renderHtml(r, S, "h", events), renderHtml(r, S, "h", events));
  const X = `<script>x</script>`;
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const stream = `tasktree-${X}`;
  await wp.submit({ stream, kind: "create", entity: { type: "node", id: X }, actor: "isha" });
  await wp.submit({ stream, kind: "create", entity: { type: "node", id: `${X}2` }, actor: "isha", payload: { parent_id: X, kind: "discovered", discovered_during: X } });
  await wp.submit({ stream, kind: "event", entity: { type: "node", id: X }, event: "COMPLETE", actor: "isha" }); // rejection detail echoes the id
  await wp.submit({ stream, kind: "create", entity: { type: "idea", id: X }, actor: "isha" }); // other-entities table
  const log = await store.readStream(stream);
  const html = renderHtml(fold(log, registry), stream, "h", log);
  assert.ok(!html.includes("<script"), "an unescaped <script> reached the page");
  assert.ok(html.split("&#60;script&#62;").length - 1 >= 6); // id, title, stream, found-during, rejection, idea
});

test("text tree: nesting, markers, and the same flags as the page", async () => {
  const { r } = await scenario();
  const lines = textTree(streamView(r, S));
  const text = lines.join("\n");
  assert.match(lines[0] ?? "", /cursor node:table · active node:table$/);
  assert.match(text, /^├─ metrics_card\s+done\s+drained {2}closed by tira$/m);
  assert.match(text, /^│  └─ improve_visual\s+done\s+drained {2}closed by tira$/m);
  assert.match(text, /^│     ├─ font\s+cancelled$/m);
  assert.match(text, /^│     └─ tokens\s+done\s+found during colors$/m);
  assert.match(text, /^├─ table\s+in_progress ◆ cursor {2}● active$/m);
  const empty = textTree(streamView(r, "tasktree-none"));
  assert.match(empty.join("\n"), /no tree yet/);
});

// ---------- blind round 1: the faults the suite let through (2026-10-20) ----------

test("a quote in a task id can't break out of an attribute: every \" is escaped (blind fault 9)", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const id = `x" onmouseover="alert(1)`;
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha" });
  const events = await store.readStream(S);
  const html = renderHtml(fold(events, registry), S, "h", events);
  assert.ok(!html.includes('" onmouseover="'), "a raw quote reached the page");
  assert.match(html, /data-key="node:x&#34; onmouseover=&#34;alert\(1\)"/);
  assert.match(html, /aria-label="x&#34; onmouseover=&#34;alert\(1\)"/);
});
