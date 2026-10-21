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
import { CSS, renderHtml } from "../src/render/html.ts";
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
  assert.match(html, /<div class="big" title="tasks closed, of all tasks">3<small>\/5<\/small><\/div>/); // tasks = the progress line's stops
  assert.match(html, /<b>2<\/b> left<\/li>/);
  // the progress line: closed stops fill the track; the marker rides on the cursor
  const stops = [...html.matchAll(/<li class="(stop [^"]*)"[^>]*><a class="stop-link"[^>]*data-key="([^"]+)"/g)];
  assert.deepEqual(stops.filter((m) => m[1]?.split(" ").includes("closed")).map((m) => m[2]), ["node:colors", "node:font", "node:tokens"]);
  assert.match(html, /data-key="node:table"[^>]*><svg class="marker"/);
  // one short line per parent: closed / total and what's left
  assert.match(html, /aria-label="dashboard: 1 of 3 closed"[^]*?<span class="ct">1 of 3 tasks closed <span class="left">· 2 left<\/span>/);
  assert.match(html, /aria-label="improve_visual: 3 of 3 closed"[^]*?<span class="ct">3 of 3 tasks closed <span class="left">· all closed<\/span>/);
  assert.match(html, /aria-label="improve_visual">[^]*?3 of 3 children closed/);
  assert.match(html, /aria-label="dashboard">[^]*?1 of 3 children closed/);
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
  assert.equal((html.match(/<span class="tira-mark"/g) ?? []).length, 2); // tira's mark on each, on its branch line
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
  assert.equal((html.match(/<svg class="marker"/g) ?? []).length, 1);
  assert.match(html, /data-key="node:q"[^>]*><svg class="marker"[^]*?<span class="here">next<\/span>/);
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

test("only the active task is marked active; long names are shortened on the progress line, full in the drawer", async () => {
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
  // each row opens the same drawer as the task on the progress line
  for (const id of ["a", "b", "c", "d"]) {
    const href = new RegExp(`<a class="name" href="#(t\\d+)">${id}</a>`).exec(section)?.[1];
    assert.ok(href && html.includes(`<section class="drawer" id="${href}" aria-label="${id}">`), id);
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

test("trust and reading aids: the hash chip says what it is and opens the guide; lanes carry section labels", async () => {
  const { r, events } = await scenario();
  const html = renderHtml(r, S, "a".repeat(64), events);
  assert.match(html, /<a class="how" href="#guide">How to read this page<\/a><a class="verify" href="#guide" title="sha256:a{64}: a fingerprint of this page \(compare with tira dump --hash\)"><span class="vl">fingerprint<\/span> seq \d+ · a{8}…a{6}<\/a>/);
  const guide = /<section class="drawer guide" id="guide"[^]*?<\/section>/.exec(html)?.[0] ?? "";
  assert.equal((guide.match(/<p>/g) ?? []).length, 3); // the brief: three short paragraphs
  for (const topic of ["The progress line.", "By tira.", "The hash."]) assert.ok(guide.includes(`<b>${topic}</b>`), topic);
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

test("the theme switch: System, Light and Dark at the top right; System by default; a picked theme beats the system's, on screen only", async () => {
  const { r, events } = await scenario();
  const html = renderHtml(r, S, "h", events);
  const radios = [...html.matchAll(/<input class="view-radio" type="radio" name="theme" id="th-(\w+)"( checked)? aria-label="\w+ theme" data-theme-choice="(\w+)">/g)];
  assert.deepEqual(radios.map((m) => [m[1], m[2] !== undefined, m[3]]), [["system", true, "system"], ["light", false, "light"], ["dark", false, "dark"]]);
  assert.ok(html.indexOf('id="th-dark"') < html.indexOf("<main"), "the radios come before <main>, which the CSS follows");
  assert.match(html, /<span class="theme" data-theme-switch><label for="th-system" title="System">[^]*?<label for="th-light" title="Light">[^]*?<label for="th-dark" title="Dark">[^]*?<\/span><\/nav>/);
  assert.match(CSS, /@media screen and \(prefers-color-scheme:dark\)\{:root\{--bg:#1f1f21;/); // System: the computer's setting
  assert.match(CSS, /:root:has\(#th-light:checked\)\{color-scheme:light;--bg:#ffffff;/); // Light beats a dark system
  assert.match(CSS, /@media screen\{:root:has\(#th-dark:checked\)\{color-scheme:dark;--bg:#1f1f21;/); // Dark, on screen only: print stays light
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
