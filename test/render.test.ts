// D1 — the thin HTML page and the text tree. The page check is the automatable half
// of manual test M1: every node in the fold appears exactly once, with the fold's
// state, drain, cursor and active flags, and the page carries the dump hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli/cli.ts";
import { VERDICTS, type DivergenceReport } from "../src/divergence/divergence.ts";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { canonicalJson, fold } from "../src/fold/fold.ts";
import { CSS, divergenceHtml, renderHtml } from "../src/render/html.ts";
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

// Kanban's columns: title → the cards in it, in order
const kanbanColumns = (html: string) => Object.fromEntries((/<div class="bv bv-kanban">[^]*?<div class="bv bv-graph">/.exec(html)?.[0] ?? "").split('<div class="col">').slice(1)
  .map((col) => [/<\/span>([A-Za-z ]+)<span class="k">/.exec(col)?.[1] ?? "", [...col.matchAll(/<div class="t">((?:[^<]|<wbr>)+)<\/div>/g)].map((m) => m[1]?.replaceAll("<wbr>", ""))]));

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
  // in plain words on the page (the data-drained flag keeps the fold's name)
  assert.match(html, /<li title="parents whose every subtask is done or dropped"><b>2<\/b> parents finished<\/li>/);
  assert.match(html, /<span class="mark drained">all subtasks closed<\/span>/);
  assert.doesNotMatch(html, />drained</);
  assert.match(html, new RegExp(`data-node-count="${tree.length}" data-fold-tree-count="${tree.length}"`));
  assert.match(html, new RegExp(`data-dump-hash="${hash}"`));
  assert.match(html, /one active task: node:table is already active/); // the rejection is shown
  // progress counts closed = done + cancelled, overall and per parent
  assert.match(html, /<div class="big" title="tasks closed, of all tasks">3<small>\/5<\/small><\/div>/); // tasks = the leaves: the Kanban cards
  assert.match(html, /<b>2<\/b> left<\/li>/);
  // the graph: a line turns green once its child is closed; the ◆ pin rides on the cursor
  const green = [...html.matchAll(/<path class="e done[^"]*" data-from="[^"]+" data-to="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(green, ["node:metrics_card", "node:improve_visual", "node:colors", "node:font", "node:tokens"]);
  assert.match(html, /data-key="node:table"[^>]*><span class="here">◆ now<\/span>/);
  // each parent node: closed / total and what's left
  assert.match(html, /aria-label="dashboard, [a-z ]+, 1 of 3 subtasks closed"[^>]*>[^]*?<span class="gm">1\/3 closed · 2 left<\/span>/);
  assert.match(html, /aria-label="improve_visual, done, 3 of 3 subtasks closed"[^>]*>[^]*?<span class="gm"><span class="tira-mark"[^]*?<\/span>3\/3 closed<\/span>/);
  // tokens was found while working on colors, its sibling: a dotted line joins them, and its node says so
  assert.deepEqual([...html.matchAll(/<path class="e found" data-from="node:colors" data-found="([^"]+)"/g)].map((m) => m[1]), ["node:tokens"]);
  assert.match(html, /data-key="node:tokens"[^>]*>[^]*?<span class="gm">done · ✦ found<\/span>/);
  assert.match(html, /aria-label="improve_visual" role="dialog" aria-modal="true">[^]*?3 of 3 subtasks closed/);
  assert.match(html, /aria-label="dashboard" role="dialog" aria-modal="true">[^]*?1 of 3 subtasks closed/);
  // Kanban holds the work (leaves), with the cursor's card marked next; no strip of parents above
  // every ticket but an untouched grouping (dashboard: to do, with subtasks); tira's closes are Done cards;
  // the open idea waits in Ideas, first; Done is newest first (tira closed metrics_card last)
  assert.deepEqual(Object.keys(kanbanColumns(html))[0], "Ideas");
  assert.deepEqual(kanbanColumns(html), { Ideas: ["7"], "To do": ["filters"], "In progress": ["table"], Done: ["metrics_card", "improve_visual", "tokens", "colors"], Dropped: ["font"] });
  assert.match(html, /<div class="t">improve_<wbr>visual<\/div><div class="row"><span class="chip">metrics_card<\/span><span class="chip" data-subtasks>3\/3 subtasks<\/span>/);
  assert.match(html, /<a class="card is-next" href="#t\d+"[^>]*><span class="pin">◆ now<\/span><div class="t">table<\/div>/);
  // the halo marks the active task only; payloads read as words, not JSON
  assert.equal((html.match(/<a class="gn [^"]*is-active/g) ?? []).length, 1);
  assert.match(html, /<div class="ev-detail">under dashboard<\/div>/);
  assert.doesNotMatch(html, /\{&#34;parent_id&#34;/);
  assert.doesNotMatch(html, /class="strip"|<a class="br"/);
  assert.match(html, /idea:7/); // non-tree entities are listed too
});

test("proof 4: tira-closed parents carry a quiet mark; every node is one click from its history", async () => {
  const { r, events } = await scenario();
  const html = renderHtml(r, S, "h", events);
  const closed = [...html.matchAll(/data-key="([^"]+)"[^>]*data-closed-by-tira="true"/g)].map((m) => m[1]);
  assert.deepEqual(closed, ["node:metrics_card", "node:improve_visual"]);
  assert.equal((html.match(/<span class="tira-mark"/g) ?? []).length, 2); // tira's mark on each, on its graph node
  assert.equal((html.match(/<span class="mark tira">closed by tira<\/span>/g) ?? []).length, 2); // and said in words in their drawers
  assert.match(html, /<b>2<\/b> closed by tira<\/li>/);
  // one click: every tree node links to a drawer that exists and holds its history
  const links = [...html.matchAll(/<a class="gn[^"]*" href="#(t\d+)"/g)].map((m) => m[1] as string);
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
  assert.equal((html.match(/<span class="wait-ring"/g) ?? []).length, 1); // the dashed ring on its graph node
  assert.match(textTree(streamView(r, S)).join("\n"), /^p\s+unstarted\s+drained {2}\(tira closes when you move on\)$/m);
  // the tree marks the cursor (q), not the active task (none here), with ◆ next
  assert.equal((html.match(/<span class="here">/g) ?? []).length, 1);
  assert.match(html, /data-key="node:q"[^>]*><span class="here">◆ next<\/span>/);
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

test("only the active task is marked active; a long name shows in words on the graph (two lines at most), exact in its title and dialog", async () => {
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
  const pulsing = [...html.matchAll(/<a class="(gn [^"]*)"[^>]*data-key="([^"]+)"/g)].filter((m) => m[1]?.includes("is-active")).map((m) => m[2]);
  assert.deepEqual(pulsing, ["node:c"]); // p is in progress too, but c (below it) is the active task
  assert.match(html, /<span class="name" title="a_really_long_task_name_for_the_tree_view">a really long task name for the tree view<\/span>/);
  assert.match(CSS, /\.gn \.name,\.ghost \.name\{[^}]*-webkit-line-clamp:2;line-clamp:2;overflow:hidden/); // two lines, then …
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

test("needs attention: blocked work grouped by its reason, then the active task, each one click from its drawer", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const born = (id: string, parent_id?: string) => wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}) => wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  await born("app");
  for (const id of ["a", "b", "c", "d", "e"]) await born(id, "app");
  await send("b", "BLOCK", { reason: "waiting on tokens" }); // seq 7
  await send("a", "BLOCK", { reason: "waiting on review" }); // seq 8
  await send("c", "BLOCK", { reason: "waiting on tokens" }); // seq 9
  await send("c", "BLOCK"); // a no-op: still blocked since seq 9
  await send("d", "START"); // seq 11
  await send("d", "START"); // a no-op
  const events = await store.readStream(S);
  const html = renderHtml(fold(events, registry), S, "h", events);
  const section = /<section class="attention"[^>]*>(.*?)<\/section>/s.exec(html)?.[0] ?? "";
  assert.match(section, /data-attention-count="4"/);
  assert.match(section, /<h2><b>4<\/b>need you<\/h2><span class="sum">3 blocked · 1 in progress<\/span>/);
  // groups in the order they first blocked; rows in the order they blocked
  assert.deepEqual([...section.matchAll(/data-reason="([^"]*)"/g)].map((m) => m[1]), ["waiting on tokens", "waiting on review"]);
  assert.deepEqual([...section.matchAll(/data-attention-key="([^"]*)"/g)].map((m) => m[1]), ["node:b", "node:c", "node:a", "node:d"]);
  assert.deepEqual([...section.matchAll(/<span class="since">([^<]*)</g)].map((m) => m[1]), ["blocked at seq 7", "blocked at seq 9", "blocked at seq 8", "started at seq 11"]);
  // each row opens the same dialog as the task on the board
  for (const id of ["a", "b", "c", "d"]) {
    const href = new RegExp(`<a class="name" href="#(t\\d+)">${id}</a>`).exec(section)?.[1];
    assert.ok(href && html.includes(`<section class="drawer" id="${href}" aria-label="${id}" role="dialog" aria-modal="true">`), id);
  }
  // the M1 count is untouched: rows carry data-attention-key, never data-key
  assert.equal((html.match(/ data-key="/g) ?? []).length, 6);
  assert.match(html, /#v-lanes:checked~main \.attention,#v-log:checked~main \.attention\{display:none\}/);
  // unblocked and finished, nothing needs you; the next task is offered instead
  await send("d", "COMPLETE", { evidenceRef: "e" }); // one active task at a time: finish d before unblocking a
  await send("a", "UNBLOCK");
  await send("a", "COMPLETE", { evidenceRef: "e" });
  for (const id of ["b", "c"]) await send(id, "CANCEL");
  const later = await store.readStream(S);
  const calm = renderHtml(fold(later, registry), S, "h", later);
  assert.match(calm, /<section class="attention calm" data-attention-count="0"[^>]*><div class="att-head"><h2>Nothing needs you<\/h2><\/div><p>Next up: <a href="#t\d+">e<\/a><\/p><\/section>/);
});

test("needs attention lists the task being worked on, not the parents in progress above it", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "app" }, actor: "isha" });
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "a" }, actor: "isha", payload: { parent_id: "app" } });
  await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "app" }, event: "START", actor: "isha" });
  await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "a" }, event: "START", actor: "isha" });
  const events = await store.readStream(S);
  const html = renderHtml(fold(events, registry), S, "h", events);
  assert.deepEqual([...html.matchAll(/data-attention-key="([^"]*)"/g)].map((m) => m[1]), ["node:a"]);
});

test("needs attention reads only what replay applied: a refused block can't date or explain the row; a finished active parent leaves the count and stays in the tree", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  for (const id of ["a", "b"]) await wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha" });
  await store.append(S, [{ type: "node.block", data: { entity: { id: "b" }, payload: {} }, metadata: { actor: "old-writer", era: 2 } }]); // seq 3: no reason under today's rules, refused on replay
  await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "b" }, event: "BLOCK", actor: "isha", payload: { reason: "the real why" } }); // seq 4
  const events = await store.readStream(S);
  const r = fold(events, registry);
  assert.equal(r.anomalies.length, 1);
  const html = renderHtml(r, S, "h", events);
  assert.match(html, /data-reason="the real why"/);
  assert.match(html, /<span class="since">blocked at seq 4<\/span>/);
  // a started parent whose children are all done: active, finished, tira closes it on your next move
  const s2 = new SqliteEventStore();
  const w2 = new WritePath(s2, registry);
  await w2.submit({ stream: S, kind: "create", entity: { type: "node", id: "p" }, actor: "isha" });
  await w2.submit({ stream: S, kind: "create", entity: { type: "node", id: "c" }, actor: "isha", payload: { parent_id: "p" } });
  for (const [id, ev, payload] of [["p", "START", {}], ["c", "START", {}], ["c", "COMPLETE", { evidenceRef: "e" }]] as const) {
    await w2.submit({ stream: S, kind: "event", entity: { type: "node", id }, event: ev, actor: "isha", payload });
  }
  const e2 = await s2.readStream(S);
  const h2 = renderHtml(fold(e2, registry), S, "h", e2);
  // ruling 2026-10-20: not a decision for a person, so not in the count; tira closes it when work moves on
  assert.doesNotMatch(h2, /data-attention-key="node:p"/);
  assert.match(h2, /<section class="attention calm" data-attention-count="0"/);
  assert.match(h2, /data-key="node:p"[^>]*data-active="true"[^>]*data-awaiting-close="true"/); // still in the tree, waiting for tira
});

test("needs attention escapes reasons, labels a blank one, and is left out of a stream with no tree", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "x" }, actor: "isha" });
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "y" }, actor: "isha" });
  await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "x" }, event: "BLOCK", actor: "isha", payload: { reason: `<img src=x onerror="alert(1)">` } });
  // a blank reason can't be written any more (2026-10-20), but a legacy log can hold one
  assert.equal((await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "y" }, event: "BLOCK", actor: "isha", payload: { reason: "   " } })).status, "rejected");
  await store.append(S, [{ type: "node.block", data: { entity: { id: "y" }, payload: { reason: "   " } }, metadata: { actor: "isha" } }]);
  const events = await store.readStream(S);
  assert.deepEqual(fold(events, registry).anomalies, []); // legacy era: a blank reason was a reason then
  const html = renderHtml(fold(events, registry), S, "h", events);
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes('data-reason="&#60;img src=x onerror=&#34;alert(1)&#34;&#62;"'));
  assert.match(html, /<span class="why">no reason given<\/span>/);
  const factory = renderHtml(fold([], registry), "empty", "h", []);
  assert.ok(!factory.includes('class="attention'));
});

test("trust and reading aids: Help opens the guide; the fingerprint says what it is, in History (an audit, not the board's); lanes carry section labels", async () => {
  const { r, events } = await scenario();
  const html = renderHtml(r, S, "a".repeat(64), events);
  assert.match(html, /<div class="side-foot"><a class="help" href="#guide" title="How to read this page"><svg[^]*?<\/svg><span>Help<\/span><\/a>/);
  const history = /<section class="view view-log" aria-label="History">[^]*?<\/section>/.exec(html)?.[0] ?? "";
  assert.match(history, /<div class="log-top"><h3>Newest first · [^<]*<\/h3><a class="verify" href="#guide" title="sha256:a{64}: a fingerprint of this page \(compare with tira dump --hash\)"><span class="vl">fingerprint<\/span> seq \d+ · a{8}…a{6}<\/a><\/div>/);
  assert.equal((html.match(/class="verify"/g) ?? []).length, 1); // nowhere else: not in the sidebar, not on the board
  const guide = /<section class="drawer guide" id="guide"[^]*?<\/section>/.exec(html)?.[0] ?? "";
  assert.equal((guide.match(/<p>/g) ?? []).length, 3); // the brief: three short paragraphs
  for (const topic of ["The board.", "By tira.", "The fingerprint."]) assert.ok(guide.includes(`<b>${topic}</b>`), topic);
  assert.ok(guide.includes(`<code>${"a".repeat(64)}</code>`));
  // a factory stream: the lanes say what each block is
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const d = new (await import("../src/write/dispatcher.ts")).Dispatcher(store, registry);
  await d.submit({ stream: "f", kind: "create", entity: { type: "session", id: "s1" }, actor: "s1" });
  await d.submit({ stream: "f", kind: "create", entity: { type: "brief", id: "b", version: 1 }, actor: "orchestrator" });
  await d.submit({ stream: "f", kind: "event", entity: { type: "brief", id: "b", version: 1 }, event: "DISPATCHED", actor: "orchestrator" });
  const fe = await store.readStream("f");
  const lanes = renderHtml(fold(fe, registry), "f", "h", fe);
  assert.match(lanes, /<h3 class="lanes-label">briefs, one lane per dial: gate · claim · outcome<\/h3>/);
  assert.match(lanes, /<h3 class="lanes-label">Sessions, drops and other records<\/h3>/);
  assert.match(lanes, /<h3 class="lanes-label">Handoffs: 0 waiting, 1 done<\/h3>/);
});

test("the theme switch: System, Light and Dark in the sidebar; System by default; a picked theme beats the system's, on screen only", async () => {
  const { r, events } = await scenario();
  const html = renderHtml(r, S, "h", events);
  const radios = [...html.matchAll(/<input class="view-radio" type="radio" name="theme" id="th-(\w+)"( checked)? aria-label="\w+ theme" data-theme-choice="(\w+)">/g)];
  assert.deepEqual(radios.map((m) => [m[1], m[2] !== undefined, m[3]]), [["system", true, "system"], ["light", false, "light"], ["dark", false, "dark"]]);
  assert.ok(html.indexOf('id="th-dark"') < html.indexOf("<main"), "the radios come before <main>, which the CSS follows");
  assert.match(html, /<span class="theme" data-theme-switch><label for="th-system" title="System">[^]*?<label for="th-light" title="Light">[^]*?<label for="th-dark" title="Dark">[^]*?<\/span><\/div><\/nav>/);
  assert.match(CSS, /@media screen and \(prefers-color-scheme:dark\)\{:root\{--bg:#151517;/); // System: the computer's setting
  assert.match(CSS, /:root:has\(#th-light:checked\)\{color-scheme:light;--bg:#fcfcfd;/); // Light beats a dark system
  assert.match(CSS, /@media screen\{:root:has\(#th-dark:checked\)\{color-scheme:dark;--bg:#151517;/); // Dark, on screen only: print stays light
  assert.doesNotMatch(html + CSS, /th-living|--pollen/); // three choices, no more (Isha, 2026-10-21)
  assert.match(CSS, /@media \(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{transition:none!important;animation:none!important\}\}/);
  assert.ok(!html.includes("<script"), "the switch is CSS only: the rendered file has no script");
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

// --- the divergence panel (B3 watchdog PR-B) -------------------------------------------------
// The panel is a view of the report `tira divergence --json` emits: these tests take that
// report from the CLI itself, so the panel and the command can never be judged on different
// inputs. The fixture's answer key (manifest.json) pins the counts: 39 OK, 8 planted.

const B3 = fileURLToPath(new URL("../fixtures/b3/", import.meta.url));
const B3_FACTORY = join(B3, "factory-state.jsonl");
const B3_TIRA = join(B3, "tira-log.jsonl");
const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);

async function cliReport(factory: string, tiraLog: string): Promise<{ code: number; report: DivergenceReport | undefined; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "tira-panel-"));
  const code = await run(["--db", join(dir, "t.db"), "divergence", "--factory", factory, "--tira-log", tiraLog, "--json"], { out: (l) => out.push(l), err: (l) => err.push(l), env: { TIRA_DIVERGENCE_LOG: join(dir, "run-log.jsonl") } });
  return { code, report: code === 0 ? (JSON.parse(out.join("\n")) as DivergenceReport) : undefined, err: err.join("\n") };
}

// What the rendered section says, read back off its data-* attributes.
function panelOf(html: string) {
  const sec = html.match(/<section class="divergence[^"]*"[\s\S]*?<\/section>/)?.[0];
  assert.ok(sec !== undefined, "no divergence section rendered");
  return {
    sec,
    state: sec.match(/data-divergence-state="([^"]+)"/)?.[1],
    count: sec.match(/data-divergence-count="([^"]+)"/)?.[1],
    counts: Object.fromEntries([...sec.matchAll(/data-verdict="([A-Z-]+)" data-count="(\d+)"/g)].map(([, v, c]) => [v, Number(c)])),
    rows: [...sec.matchAll(/data-event-id="([^"]+)" data-verdict="([^"]+)"><span class="v">[^<]*<\/span><span class="id">[^<]*<\/span><span class="detail">([^<]*)<\/span>/g)].map(([, event_id, verdict, detail]) => ({ event_id, verdict, detail: detail ?? "" })),
  };
}
const unesc = (s: string) => s.replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)));
const page = (panel: Parameters<typeof divergenceHtml>[0]) => renderHtml(fold([], defaultRegistry()), "empty", "h", [], { divergence: panel });

test("divergence panel: on the fixture pair its counts and rows are the CLI's --json report, 39 OK / 8 by kind", async () => {
  const { code, report } = await cliReport(B3_FACTORY, B3_TIRA);
  assert.equal(code, 0);
  assert.ok(report);
  const p = panelOf(page({ report }));
  assert.equal(p.state, "divergent");
  assert.deepEqual(p.counts, report.counts);
  assert.deepEqual(p.rows.map((r) => ({ ...r, detail: unesc(r.detail) })), report.findings);
  assert.equal(p.count, String(report.findings.length));
  // the answer key: the scorer-verified verdict map
  const key = JSON.parse(readFileSync(join(B3, "manifest.json"), "utf8")) as { verdicts: { event_id: string; verdict: string }[] };
  const byKind = Object.fromEntries(VERDICTS.map((v) => [v, key.verdicts.filter((m) => m.verdict === v).length]));
  assert.deepEqual(p.counts, byKind);
  assert.equal(p.counts.OK, 39);
  assert.equal(p.rows.length, 8);
  assert.deepEqual(Object.fromEntries(p.rows.map((r) => [r.event_id, r.verdict])), Object.fromEntries(key.verdicts.filter((m) => m.verdict !== "OK").map((m) => [m.event_id, m.verdict])));
  // coordinates and population ride with the counts
  assert.match(p.sec, new RegExp(`data-factory-snapshot="${report.coordinates.factory.snapshot}" data-stream="factory-b3" data-at-seq="65"`));
  assert.match(p.sec, /data-factory-records="46" data-tira-fx-events="45" data-ids="47"/);
});

test("divergence panel: a clean pair renders an explicit '0 divergences', with its counts, coordinates and population", async () => {
  const { report: full } = await cliReport(B3_FACTORY, B3_TIRA);
  assert.ok(full);
  const ok = new Set(Object.entries(full.verdicts).filter(([, v]) => v === "OK").map(([id]) => id));
  const dir = mkdtempSync(join(tmpdir(), "tira-panel-clean-"));
  const fac = join(dir, "factory.jsonl");
  const tl = join(dir, "tira.jsonl");
  writeFileSync(fac, lines(B3_FACTORY).filter((r) => ok.has(r.event_id)).map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(tl, lines(B3_TIRA).filter((e) => !String(e.eventId).startsWith("fx:") || ok.has(e.eventId)).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const { code, report } = await cliReport(fac, tl);
  assert.equal(code, 0);
  assert.ok(report);
  assert.equal(report.findings.length, 0, "the filtered pair is clean by the CLI's own verdict");
  const p = panelOf(page({ report }));
  assert.equal(p.state, "clean");
  assert.equal(p.count, "0");
  assert.match(p.sec, /<h2>0 divergences<\/h2>/);
  assert.deepEqual(p.counts, report.counts);
  assert.equal(p.counts.OK, 39);
  assert.equal(p.rows.length, 0);
  assert.match(p.sec, /data-ids="39"/);
});

test("divergence panel: unreadable input renders UNEVALUABLE, never a blank and never a 0", async () => {
  const { code, err } = await cliReport(join(tmpdir(), "no-such-factory-file.jsonl"), B3_TIRA);
  assert.equal(code, 1);
  const p = panelOf(page({ unevaluable: err }));
  assert.equal(p.state, "unevaluable");
  assert.match(p.sec, /Divergence UNEVALUABLE/);
  assert.match(p.sec, /cannot read factory file/);
  assert.equal(p.count, undefined);
  assert.deepEqual(p.counts, {});
  assert.doesNotMatch(p.sec, /0 divergences|data-count=/);
  // a report without its coordinates or population is not a report
  const { report } = await cliReport(B3_FACTORY, B3_TIRA);
  assert.ok(report);
  const noCoords = { ...report, coordinates: { ...report.coordinates, factory: { ...report.coordinates.factory, snapshot: "" } } };
  const noPop = { ...report, population: undefined } as unknown as DivergenceReport;
  const offBy = { ...report, counts: { ...report.counts, OK: 38 } };
  for (const [bad, why] of [[noCoords, /no coordinates/], [noPop, /no population/], [offBy, /does not add up/]] as const) {
    const q = panelOf(page({ report: bad }));
    assert.equal(q.state, "unevaluable");
    assert.match(q.sec, why);
    assert.doesNotMatch(q.sec, /data-count=/);
  }
});

test("divergence panel: the renderer never diffs — html.ts takes the report and imports no differ", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/render/html.ts", import.meta.url)), "utf8");
  const imports = src.match(/^import [^;]*divergence\.ts";$/gm) ?? [];
  assert.deepEqual(imports, [`import { VERDICTS, type DivergenceReport } from "../divergence/divergence.ts";`]);
  assert.doesNotMatch(src, /\bdivergence\(/);
  // no input, no section: a page that was handed no pair claims nothing about one
  assert.doesNotMatch(renderHtml(fold([], defaultRegistry()), "empty", "h", []), /class="divergence/);
  // continuous-at-read: a different report renders differently — nothing remembered between renders
  const r1 = divergenceHtml({ unevaluable: "a" });
  assert.notEqual(r1, divergenceHtml({ unevaluable: "b" }));
});

// Spec assumption 3, the 1 s/read falsifier: one read (CLI parse + diff) plus one render at
// MVP scale. The fixture is replicated with every id suffixed, so verdicts do not collapse and
// the counts must scale exactly.
test("divergence panel: one read + render at ~2,800 tira events costs under 1 s", async () => {
  const K = 43;
  const fac = lines(B3_FACTORY);
  const tl = lines(B3_TIRA);
  const tag = (id: string, k: number) => {
    const at = id.indexOf("@");
    return at < 0 ? `${id}-r${k}` : `${id.slice(0, at)}-r${k}${id.slice(at)}`;
  };
  const facOut: string[] = [];
  const tlOut: string[] = [];
  let seq = 0;
  for (let k = 0; k < K; k++) {
    for (const r of fac) facOut.push(JSON.stringify({ ...r, event_id: `${r.event_id}-r${k}`, entity_id: tag(r.entity_id, k) }));
    for (const e of tl) {
      const d = structuredClone(e.data);
      if (d.entity && typeof d.entity.id === "string") d.entity.id = `${d.entity.id}-r${k}`;
      if (d.intent?.entity && typeof d.intent.entity.id === "string") d.intent.entity.id = `${d.intent.entity.id}-r${k}`;
      seq++;
      tlOut.push(JSON.stringify({ ...e, eventId: `${e.eventId}-r${k}`, seq, streamRevision: seq - 1, data: d }));
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "tira-panel-scale-"));
  writeFileSync(join(dir, "factory.jsonl"), facOut.join("\n") + "\n");
  writeFileSync(join(dir, "tira.jsonl"), tlOut.join("\n") + "\n");
  const { report: one } = await cliReport(B3_FACTORY, B3_TIRA);
  assert.ok(one);
  const t0 = performance.now();
  const { code, report } = await cliReport(join(dir, "factory.jsonl"), join(dir, "tira.jsonl"));
  assert.ok(report);
  const html = page({ report });
  const ms = performance.now() - t0;
  assert.equal(code, 0);
  assert.equal(tlOut.length, 2795);
  assert.deepEqual(panelOf(html).counts, Object.fromEntries(VERDICTS.map((v) => [v, one.counts[v] * K])));
  console.log(`divergence read+render: ${tlOut.length} tira events, ${facOut.length} factory records, ${report.population.ids} ids: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 1000, `read+render took ${ms.toFixed(1)} ms at ${tlOut.length} events: continuous-at-read is falsified`);
});

test("a task (or an idea) opens as a dialog over the page, never a side panel or a new page: centred box, dimmed page behind it that closes it, a close button", async () => {
  const { r, events } = await scenario();
  const html = renderHtml(r, S, "h", events);
  const dialogs = [...html.matchAll(/<section class="drawer( guide)?" id="([^"]+)"[^>]*>/g)];
  assert.ok(dialogs.length > 1);
  for (const [tag, , id] of dialogs) {
    assert.match(tag, /role="dialog" aria-modal="true"/, String(id));
    const body = new RegExp(`id="${id}"[^>]*><a class="scrim" href="#_" tabindex="-1" aria-hidden="true"></a><div class="modal-box"><a class="close" href="#_" aria-label="Close">×</a>`);
    assert.match(html, body, String(id));
  }
  // every way to a task (or an idea: #i) stays on the page: links to its dialog, no target, no other page
  const links = [...html.matchAll(/<a class="(?:gn[^"]*|ghost[^"]*|card[^"]*|name)" href="([^"]+)"/g)].map((m) => m[1] as string);
  assert.ok(links.length > 0 && links.every((h) => /^#[ti]\d+$/.test(h)), links.join(" "));
  assert.ok(links.includes("#i0"), "the idea's card and ghost open its dialog");
  assert.doesNotMatch(html, /target="_blank"/);
  // the box is centred over a dimmed page; the page behind doesn't scroll while it's open
  assert.match(html, /\.drawer\{position:fixed;inset:0;[^}]*display:grid;place-items:center/);
  assert.match(html, /body:has\(\.drawer:target\)\{overflow:hidden\}/);
  assert.doesNotMatch(html, /translateX\(100%\)/); // no side panel sliding in
});

test("a task's dialog lists its subtasks with their states, shows proof of work on a done task, and offers actions only on the live page", async () => {
  const { r, events } = await scenario();
  const html = renderHtml(r, S, "h", events);
  const dialog = (id: string, page = html) => new RegExp(`<section class="drawer" id="t\\d+" aria-label="${id}"[^]*?</section>`).exec(page)?.[0] ?? "";
  const parent = dialog("improve_visual");
  const kids = [...parent.matchAll(/<li><a href="#(t\d+)">([^<]+)<\/a><span class="state s-([a-z_]+)">/g)].map((m) => [m[2], m[3]]);
  assert.deepEqual(kids, [["colors", "done"], ["font", "cancelled"], ["tokens", "done"]]);
  for (const [, href] of parent.matchAll(/<li><a href="#(t\d+)">/g)) assert.match(html, new RegExp(`<section class="drawer" id="${href}"`));
  // proof: the evidence on the completion, for a done task; none for open work
  assert.match(dialog("colors"), /<div class="proof" data-proof><span class="proof-k">Proof of work<\/span><span class="proof-v">[^<]+<\/span><span class="ev-seq">isha · seq \d+<\/span><\/div>/);
  assert.doesNotMatch(dialog("table"), /data-proof/);
  // actions: none in a rendered file; live, by state
  assert.doesNotMatch(html, /data-dialog-acts/);
  const live = renderHtml(r, S, "h", events, { live: {} });
  const acts = (id: string) => [...(/data-dialog-acts>(.*?)<\/div>/.exec(dialog(id, live))?.[1] ?? "").matchAll(/data-act="([A-Z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(acts("table"), ["COMPLETE", "BLOCK", "ADD_SUBTASK", "CANCEL"]); // in progress
  assert.deepEqual(acts("colors"), ["REOPEN"]); // done
  assert.deepEqual(acts("filters"), ["START", "BLOCK", "ADD_SUBTASK", "CANCEL"]); // unstarted
});

test("Lanes shows only when the stream has something for it; the whole log is called History", async () => {
  const labels = (page: string) => [...page.matchAll(/<label for="v-(\w+)">([^<]+)<\/label>/g)].map((m) => m[2]);
  // a plain task tree: nothing for Lanes
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  await new WritePath(store, registry).submit({ stream: "plain", kind: "create", entity: { type: "node", id: "a" }, actor: "isha" });
  const pe = await store.readStream("plain");
  const tree = renderHtml(fold(pe, registry), "plain", "h", pe);
  assert.deepEqual(labels(tree), ["Board", "History"]);
  assert.doesNotMatch(tree, /id="v-lanes"|class="view view-lanes"/);
  assert.match(tree, /<section class="view view-log" aria-label="History">/);
  // a tree with an idea in its stream: the idea lives in Lanes, so the tab shows
  const { r, events } = await scenario();
  assert.deepEqual(labels(renderHtml(r, S, "h", events)), ["Board", "Lanes", "History"]);
  const d = new (await import("../src/write/dispatcher.ts")).Dispatcher(store, registry);
  await d.submit({ stream: "f", kind: "create", entity: { type: "session", id: "s1" }, actor: "s1" });
  const fe = await store.readStream("f");
  const factory = renderHtml(fold(fe, registry), "f", "h", fe);
  assert.deepEqual([...factory.matchAll(/<label for="v-(\w+)">([^<]+)<\/label>/g)].map((m) => m[2]), ["Board", "Lanes", "History"]);
});

test("one Board view, two styles: Kanban by default, Graph a click away, switched with CSS alone", async () => {
  const { r, events } = await scenario();
  const html = renderHtml(r, S, "h", events);
  assert.doesNotMatch(html, /v-train|view-train|Progress/); // no separate progress view
  const radios = [...html.matchAll(/<input class="view-radio" type="radio" name="board-style" id="bv-(\w+)"( checked)?/g)].map((m) => [m[1], m[2] !== undefined]);
  assert.deepEqual(radios, [["kanban", true], ["graph", false]]);
  assert.match(html, /<span class="seg" role="group" aria-label="Board style"><label for="bv-kanban">[^]*?Kanban<\/label><label for="bv-graph">[^]*?Graph<\/label><\/span>/);
  assert.match(html, /#bv-kanban:checked~\.bv-kanban,#bv-graph:checked~\.bv-graph\{display:block\}/);
  // the cards live in the Kanban style, every task's node in the Graph style
  const kanban = /<div class="bv bv-kanban">[^]*?<div class="bv bv-graph">/.exec(html)?.[0] ?? "";
  const graph = /<div class="bv bv-graph">[^]*?<\/section>/.exec(html)?.[0] ?? "";
  assert.equal((kanban.match(/<a class="card[ "]/g) ?? []).length, 8); // 5 leaf tasks, the 2 parents tira closed, and idea 7 (in Ideas)
  assert.equal((graph.match(/<a class="gn[ "]/g) ?? []).length, r.entities.filter((e) => e.tree).length);
  assert.doesNotMatch(kanban, /data-key=/); // the fold's flags are on the graph's nodes only (M1)
  // a parent sits a row above its children, centred over them; no two nodes on a row overlap
  const at = new Map([...graph.matchAll(/style="left:([\d.]+)px;top:(\d+)px"[^>]*data-key="([^"]+)"/g)].map((m) => [m[3], { left: Number(m[1]), top: Number(m[2]) }]));
  const pos = (k: string) => at.get(`node:${k}`) ?? { left: NaN, top: NaN };
  for (const kid of ["colors", "font", "tokens"]) assert.equal(pos(kid).top - pos("improve_visual").top, 104, kid);
  assert.equal(pos("improve_visual").left, pos("font").left); // the middle of three
  assert.equal(pos("dashboard").left, (pos("metrics_card").left + pos("filters").left) / 2);
  for (const row of new Set([...at.values()].map((p) => p.top))) {
    const xs = [...at].filter(([, p]) => p.top === row).map(([k, p]) => [k, p.left] as const);
    assert.deepEqual(xs.map(([, x]) => x), xs.map(([, x]) => x).sort((a, b) => a - b), `row ${row}: tree order, left to right`);
    for (let i = 1; i < xs.length; i++) assert.ok((xs[i]?.[1] ?? 0) - (xs[i - 1]?.[1] ?? 0) >= 168, `${xs[i]?.[0]} overlaps ${xs[i - 1]?.[0]}`);
  }
});

test("150+ tasks: every task on the graph once with the fold's flags, none overlapping, in a tree narrow enough to fit", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const node = (id: string, parent_id?: string) => wp.submit({ stream: "big", kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
  await node("root");
  for (let e = 0; e < 5; e++) {
    await node(`e${e}`, "root");
    for (let f = 0; f < 4; f++) {
      await node(`e${e}f${f}`, `e${e}`);
      for (let t = 0; t < 7; t++) await node(`e${e}f${f}t${t}`, `e${e}f${f}`);
    }
  }
  const events = await store.readStream("big");
  const r = fold(events, registry);
  const html = renderHtml(r, "big", "h", events);
  const tree = r.entities.filter((e) => e.stream === "big" && e.tree);
  assert.ok(tree.length > 150);
  assert.equal(attrs(html).length, tree.length);
  assert.equal(new Set(attrs(html).map((n) => n.key)).size, tree.length);
  const at = [...html.matchAll(/style="left:([\d.]+)px;top:(\d+)px"[^>]*data-key="([^"]+)"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), key: m[3] }));
  assert.equal(at.length, tree.length);
  for (let i = 0; i < at.length; i++) {
    for (let j = i + 1; j < at.length; j++) {
      const [a, b] = [at[i], at[j]] as [(typeof at)[0], (typeof at)[0]];
      assert.ok(Math.abs(a.x - b.x) >= 168 - 0.01 || Math.abs(a.y - b.y) >= 56, `${a.key} overlaps ${b.key}`);
    }
  }
  const width = Number(/<div class="graph" [^>]*style="width:([\d.]+)px/.exec(html)?.[1]);
  assert.ok(width < 140 * 168 / 4, `${width}px across for 140 leaf tasks`);
});

test("proof of work follows the task: a re-open clears it, the next completion's evidence replaces it", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const send = (event: string, payload: Record<string, unknown> = {}) => wp.submit({ stream: "p", kind: "event", entity: { type: "node", id: "x" }, event, actor: "isha", payload });
  await wp.submit({ stream: "p", kind: "create", entity: { type: "node", id: "x" }, actor: "isha" });
  const proof = async () => {
    const e = await store.readStream("p");
    return /<span class="proof-v">([^<]*)<\/span>/.exec(renderHtml(fold(e, registry), "p", "h", e))?.[1];
  };
  await send("START");
  await send("COMPLETE", { evidenceRef: "v1.md" });
  assert.equal(await proof(), "v1.md");
  await send("COMPLETE", { evidenceRef: "again.md" }); // a repeat on a done task changes nothing
  assert.equal(await proof(), "v1.md");
  await send("REOPEN", { reason: "the check was wrong" });
  assert.equal(await proof(), undefined); // in progress again: no proof shown
  await send("COMPLETE", { evidenceRef: "v2.md" });
  assert.equal(await proof(), "v2.md");
});

// --- the panel wired into `tira render` (B3 watchdog, the wiring slice) ----------------------
// The page's caller runs the differ in the same run, on the factory file and the events the
// page renders. Here the B3 tira log is loaded into a real store, so `tira render` and a live
// `tira divergence` read the same stream.

async function b3Store(dir: string): Promise<string> {
  const db = join(dir, "b3.db");
  const store = new SqliteEventStore({ path: db });
  try {
    for (const e of lines(B3_TIRA)) await store.append(e.stream, [{ eventId: e.eventId, type: e.type, data: e.data, metadata: e.metadata }]);
  } finally {
    store.close();
  }
  return db;
}

async function cli(argv: string[], env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("tira render: the page's divergence section is the report a live tira divergence computes on the same inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tira-render-wired-"));
  const db = await b3Store(dir);
  const env = { TIRA_DIVERGENCE_LOG: join(dir, "run-log.jsonl") };
  const live = await cli(["--db", db, "divergence", "--factory", B3_FACTORY, "--stream", "factory-b3", "--json"], env);
  assert.equal(live.code, 0, live.err);
  const report = JSON.parse(live.out) as DivergenceReport;
  const out = join(dir, "page.html");
  const r = await cli(["--db", db, "--stream", "factory-b3", "render", "--factory", B3_FACTORY, "--out", out], env);
  assert.equal(r.code, 0, r.err);
  const p = panelOf(readFileSync(out, "utf8"));
  assert.equal(p.state, "divergent");
  assert.deepEqual(p.counts, report.counts);
  assert.deepEqual(p.counts, { OK: 39, MISSING: 2, PHANTOM: 2, "WRONG-ENTITY": 2, DUPLICATE: 1, ORPHAN: 1 });
  assert.deepEqual(p.rows.map((x) => ({ ...x, detail: unesc(x.detail) })), report.findings);
  // coordinates and population: the live pin (sha256 of the bytes read), the stream at its last seq
  assert.equal(report.coordinates.factory.pin, "sha256");
  assert.match(p.sec, new RegExp(`data-factory-snapshot="${report.coordinates.factory.snapshot}" data-stream="factory-b3" data-at-seq="65"`));
  assert.match(p.sec, /data-factory-records="46" data-tira-fx-events="45" data-ids="47"/);
  // the same counts as the fixture run of the command (tira's side read from the log file)
  const { report: fixture } = await cliReport(B3_FACTORY, B3_TIRA);
  assert.deepEqual(p.counts, fixture?.counts);
  // TIRA_FACTORY is the flag's default, as $TIRA_STREAM is --stream's
  const viaEnv = join(dir, "env.html");
  assert.equal((await cli(["--db", db, "--stream", "factory-b3", "render", "--out", viaEnv], { ...env, TIRA_FACTORY: B3_FACTORY })).code, 0);
  assert.deepEqual(panelOf(readFileSync(viaEnv, "utf8")).counts, report.counts);
  // render --at N: the panel judges the events the page shows, not the whole log
  const at = join(dir, "at.html");
  assert.equal((await cli(["--db", db, "--stream", "factory-b3", "render", "--at", "30", "--factory", B3_FACTORY, "--out", at], env)).code, 0);
  assert.match(panelOf(readFileSync(at, "utf8")).sec, /data-at-seq="30"/);
});

test("tira render: no factory file, or one that cannot be read, renders the section UNEVALUABLE, never a blank or a 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tira-render-uneval-"));
  const db = await b3Store(dir);
  const env = { TIRA_DIVERGENCE_LOG: join(dir, "run-log.jsonl") };
  const bad = join(dir, "bad.jsonl");
  writeFileSync(bad, "{not json\n");
  const cases: [string[], RegExp][] = [
    [[], /no factory file: pass --factory FILE or set TIRA_FACTORY/],
    [["--factory", join(dir, "absent.jsonl")], /cannot read factory file/],
    [["--factory", bad], /line 1: not valid JSON/],
  ];
  for (const [flags, why] of cases) {
    const out = join(dir, "page.html");
    const r = await cli(["--db", db, "--stream", "factory-b3", "render", ...flags, "--out", out], env);
    assert.equal(r.code, 0, "an unevaluable panel is a page state, not a failed render");
    const p = panelOf(readFileSync(out, "utf8"));
    assert.equal(p.state, "unevaluable", flags.join(" "));
    assert.match(unesc(p.sec), why);
    assert.equal(p.count, undefined);
    assert.doesNotMatch(p.sec, /0 divergences|data-count=/);
  }
  // a stream with no events is no tira side to compare against
  const empty = join(dir, "empty.html");
  assert.equal((await cli(["--db", db, "--stream", "nothing-here", "render", "--factory", B3_FACTORY, "--out", empty], env)).code, 0);
  assert.match(panelOf(readFileSync(empty, "utf8")).sec, /stream nothing-here has no events/);
});

// ---------- the page at 100+ tasks (Isha, 2026-10-21: board up front, Kanban that fits) ----------

// a flat stream: `done` tasks completed in order (t0 first), `todo` untouched, `blocked` blocked
// on `reasons` (task i on reasons[i % n]), `dropped` cancelled, and one task in progress
async function flat(opts: { done?: number; todo?: number; dropped?: number; blocked?: number; reasons?: string[]; working?: boolean }) {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const born = (id: string) => wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha" });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}) => wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  for (let i = 0; i < (opts.done ?? 0); i++) { await born(`d${i}`); await send(`d${i}`, "START"); await send(`d${i}`, "COMPLETE", { evidenceRef: "e" }); }
  for (let i = 0; i < (opts.todo ?? 0); i++) await born(`t${i}`);
  for (let i = 0; i < (opts.dropped ?? 0); i++) { await born(`x${i}`); await send(`x${i}`, "CANCEL"); }
  const reasons = opts.reasons ?? ["waiting on review"];
  for (let i = 0; i < (opts.blocked ?? 0); i++) { await born(`b${i}`); await send(`b${i}`, "BLOCK", { reason: reasons[i % reasons.length] }); }
  if (opts.working) { await born("w"); await send("w", "START"); }
  const events = await store.readStream(S);
  return { r: fold(events, registry), events };
}

test("Kanban at 100+ tasks: the columns stay in one row; Done and Dropped show their newest 8, the rest behind 'N more'; the work columns show every card", async () => {
  assert.match(CSS, /\.cols\{display:grid;grid-auto-flow:column;grid-auto-columns:minmax\(172px,1fr\);[^}]*overflow-x:auto/); // never wraps a column under the others
  const { r, events } = await flat({ done: 12, todo: 10, dropped: 3 });
  const html = renderHtml(r, S, "h", events);
  const cols = kanbanColumns(html);
  // newest first: d11 was completed last
  assert.deepEqual(cols.Done, ["d11", "d10", "d9", "d8", "d7", "d6", "d5", "d4", "d3", "d2", "d1", "d0"]);
  const done = /<span class="dot" style="background:var\(--done\)"><\/span>Done[^]*?<\/div><div class="col">/.exec(html)?.[0] ?? "";
  const [shown, rest] = done.split('<details class="more"');
  assert.equal((shown?.match(/<a class="card/g) ?? []).length, 8);
  assert.match(done, /<details class="more" data-more="4"><summary><span class="m-show">Show 4 more<\/span><span class="m-hide">Show fewer<\/span><\/summary>/);
  assert.equal((rest?.match(/<a class="card/g) ?? []).length, 4); // the older four, a click away (no script)
  // To do holds the work: never folded, however long; Dropped (3) is under the cap
  assert.equal(cols["To do"]?.length, 10);
  assert.equal((html.match(/<details class="more"/g) ?? []).length, 1);
  // a card's title wraps after an underscore, never inside a word; its text is the exact id
  const { r: r2, events: e2 } = await scenario();
  assert.match(renderHtml(r2, S, "h", e2), /<div class="t">improve_<wbr>visual<\/div>/);
});

test("needs attention folds once more than 3 tasks need you: one line per blocked group (reason, names, count); the task being worked on never folds", async () => {
  const { r, events } = await flat({ blocked: 4, reasons: ["waiting on review", "waiting on tokens"], working: true });
  const html = renderHtml(r, S, "h", events);
  const groups = [...html.matchAll(/<details class="att-group blocked" data-group="blocked" data-reason="([^"]+)"( open)?><summary><span class="kind">Blocked<\/span><span class="why">([^<]+)<\/span><span class="names">([^<]+)<\/span><span class="k">(\d+)<\/span><\/summary>/g)];
  assert.deepEqual(groups.map((m) => [m[1], m[2] !== undefined, m[4], m[5]]), [["waiting on review", false, "b0, b2", "2"], ["waiting on tokens", false, "b1, b3", "2"]]);
  // the rows (with their actions, live) are inside, a click away
  assert.equal((html.match(/<li class="att-row[^"]*" data-attention-key="node:b\d"/g) ?? []).length, 4);
  assert.match(html, /<div class="att-group working" data-group="in_progress"><h3>In progress<span class="k">1<\/span><\/h3>/);
  // 3 or fewer: nothing folds
  const few = await flat({ blocked: 2, working: true });
  const calm = renderHtml(few.r, S, "h", few.events);
  assert.doesNotMatch(calm, /<details class="att-group/);
  assert.match(calm, /<div class="att-group blocked" data-group="blocked" data-reason="waiting on review"><h3>Blocked <span class="why">waiting on review<\/span>/);
  // the group holding what the last action changed opens by itself, and its row glows
  const live = renderHtml(r, S, "h", events, { live: { flash: { ok: true, text: "x", changed: ["node:b3"] } } });
  assert.match(live, /data-reason="waiting on tokens" open><summary>/);
  assert.match(live, /data-reason="waiting on review"><summary>/);
  assert.match(live, /<li class="att-row changed" data-attention-key="node:b3"/);
});

test("a divergence panel that can't be evaluated is one line: the state and why, never a count", () => {
  const sec = divergenceHtml({ unevaluable: "no factory file: pass --factory FILE or set TIRA_FACTORY" });
  assert.equal(sec, `<section class="divergence unevaluable" data-divergence-state="unevaluable" aria-label="Divergence"><div class="att-head" title="factory vs tira could not be compared, so no count is shown"><h2>Divergence UNEVALUABLE</h2><span class="sum why" data-unevaluable-reason>no factory file: pass --factory FILE or set TIRA_FACTORY</span></div></section>`);
});

test("live only: every task and idea dialog offers Show on graph, and what the last action changed glows once; the rendered file has neither", async () => {
  const { r, events } = await scenario();
  const file = renderHtml(r, S, "h", events);
  assert.doesNotMatch(file, /data-show-on-graph|class="[^"]*\bchanged\b/);
  const live = renderHtml(r, S, "h", events, { live: { flash: { ok: true, text: "Complete colors: done", changed: ["node:colors", "idea:7"] } } });
  // one button per dialog, naming its own task (or idea)
  const dialogs = [...live.matchAll(/<section class="drawer" id="([ti]\d+)"[^]*?<\/section>/g)];
  assert.ok(dialogs.length > 1);
  for (const [d, id] of dialogs) {
    const key = /data-show-on-graph="([^"]+)"/.exec(d)?.[1];
    assert.ok(key, `${id} has no Show on graph`);
    if (id?.startsWith("i")) assert.equal(key, "idea:7");
    else assert.match(live, new RegExp(`<a class="gn[^"]*" href="#${id}"[^>]*data-key="${key}"`), `${id}: its graph box is ${key}`);
  }
  // the changed task: its card, its graph box; the idea's card and ghost
  assert.match(live, /<a class="card changed" href="#t\d+"><div class="t">colors<\/div>/);
  assert.match(live, /<a class="gn st-done changed" href="#t\d+"[^>]*data-key="node:colors"/);
  assert.match(live, /<a class="card idea changed" href="#i0"/);
  assert.match(live, /<a class="ghost changed" href="#i0"/);
  assert.equal((live.match(/class="[^"]*\bchanged\b/g) ?? []).length, 4);
  assert.match(CSS, /\.changed\{animation:changed [^}]* 2\}/); // twice, then still
  assert.match(CSS, /@media \(prefers-reduced-motion:reduce\)\{\.changed\{outline:2px solid var\(--accent\)/); // no motion: a ring instead
});

test("after Linear: a sidebar; the project's mark and name in the header (no 'stream') with its numbers in one quiet row; audit parts in History; ideas tagged, not blue", async () => {
  const { r, events } = await scenario();
  const html = renderHtml(r, S, "h", events);
  assert.match(html, /<h1><span class="pav t\d" aria-hidden="true">T<\/span>tasktree-dash<\/h1><ul class="stats"><li title="tasks still open"><b>2<\/b> left<\/li><li title="parents tira closed by itself">[^]*?<b>2<\/b> closed by tira<\/li><li title="parents whose every subtask is done or dropped"><b>2<\/b> parents finished<\/li>/);
  assert.doesNotMatch(CSS, /content:"stream"/);
  assert.match(CSS, /\.t0\{--t:#5e6ad2\}/);
  // a sidebar on a wide screen (a top bar on a narrow one); the board page only, not a decision's page
  assert.match(CSS, /@media screen and \(min-width:900px\)\{\n:root\{--side:236px\}\nmain\[data-stream\]\{[^}]*\}\nmain\[data-stream\]>\.top\{position:fixed;z-index:6;left:0;top:0;bottom:0;width:var\(--side\);flex-direction:column/);
  // the audit parts live in History: the divergence check sits there, not over the board
  const withPanel = renderHtml(r, S, "h", events, { divergence: { unevaluable: "no factory file" } });
  assert.match(withPanel, /<section class="view view-log" aria-label="History"><section class="divergence unevaluable"/);
  assert.equal((withPanel.match(/<section class="divergence/g) ?? []).length, 1);
  // an idea is a plain card or box with its IDEA tag: no blue fill, no dashed border
  assert.match(CSS, /\.ghost\{position:absolute;[^}]*background:var\(--raised\);border:1px solid var\(--line-2\);/);
  assert.doesNotMatch(CSS, /\.card\.idea\{|dashed var\(--accent\)/);
  assert.match(html, /<a class="card idea" href="#i0"[^>]*><span class="tag">idea<\/span>/);
  assert.match(CSS, /\.stats li\{[^}]*border-left:1px solid var\(--line\)\}/); // dividers, not boxes
});
