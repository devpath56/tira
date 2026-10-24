// Ideas to tickets (build plan D5, "S5 · The Vapor Catch"): an agent pushes an idea in a
// sentence, tira drafts its file and, once a person approves the file, proposes its parent;
// a person approves the placement and the task is born. Covers where the parent comes from
// (fold/ideas.ts), tira's two writes (handoffs V1, V2) and their replay check, `tira idea`,
// the board (Ideas column, ghost cards, the idea dialog) and the approvals under `tira serve`.
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { freshDb, freshStore } from "./stores.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { Dispatcher } from "../src/write/dispatcher.ts";
import { canonicalJson, fold } from "../src/fold/fold.ts";
import { makeView } from "../src/fold/view.ts";
import { ideaId, ideaRows, mentioned, placement } from "../src/fold/ideas.ts";
import { renderHtml } from "../src/render/html.ts";
import { tiraServer } from "../src/serve/server.ts";
import { ideaBriefFor, ideaRefusal } from "../src/serve/brief.ts";
import { parseCommand } from "../src/serve/command.ts";
import { run } from "../src/cli/cli.ts";
import { sqliteFile } from "./test-stores.ts";

const S = "tasktree-dash";

// The dashboard every scenario starts from, with fetch_metrics done.
async function world() {
  const store = freshStore(); // SQLite, or Postgres under ideas-postgres.test.ts
  const registry = defaultRegistry();
  const d = new Dispatcher(store, registry);
  const born = (id: string, parent_id?: string) => d.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
  const send = (type: string, id: string, event: string, payload: Record<string, unknown> = {}, actor = "isha") =>
    d.submit({ stream: S, kind: "event", entity: { type, id }, event, actor, payload });
  const idea = (id: string, payload: Record<string, unknown>, actor = "claude") => d.submit({ stream: S, kind: "create", entity: { type: "idea", id }, actor, payload });
  await born("dashboard");
  await born("metrics_card", "dashboard");
  await born("fetch_metrics", "metrics_card");
  await born("improve_visual", "metrics_card");
  await born("table", "dashboard");
  await born("filters", "dashboard");
  await send("node", "fetch_metrics", "START");
  await send("node", "fetch_metrics", "COMPLETE", { evidenceRef: "pr-12" });
  const state = async () => {
    const events = await store.readStream(S);
    const r = fold(events, registry);
    return { events, r, view: makeView(new Map(r.entities.map((e) => [e.key, e]))) };
  };
  return { store, registry, d, born, send, idea, state };
}

test("where an idea goes: the task it was declared under and the tasks its text names, together; when they disagree or give nothing usable, a person picks", async () => {
  const w = await world();
  const { view } = await w.state();
  const at = (summary: string, under?: string, why?: string) => placement(view, w.registry, { summary, ...(why ? { why } : {}) }, under);
  // the text names one task
  assert.deepEqual(at("pagination would be good in table"), { parent: "table", candidates: ["table"], basis: "its text names table" });
  // declared under it, and the text agrees; or only declared
  assert.deepEqual(at("pagination would be good in table", "table"), { parent: "table", candidates: ["table"], basis: "declared under table, and its text names table too" });
  assert.deepEqual(at("sort by column", "table"), { parent: "table", candidates: ["table"], basis: "declared under table" });
  // they disagree: no parent, both candidates
  assert.deepEqual(at("pagination would be good in table", "filters"), { candidates: ["filters", "table"], basis: "needs you: it was declared under filters, but its text names table" });
  // the text names two tasks
  assert.deepEqual(at("saved views for filters and the table"), { candidates: ["filters", "table"], basis: "needs you: its text names filters and table" });
  // most specific only: dashboard drops out when the table under it is named too
  assert.deepEqual(at("the dashboard table needs paging").parent, "table");
  assert.deepEqual(mentioned(view, "the dashboard table and the metrics card"), ["metrics_card", "table"]);
  // a plural names the task; a name inside a longer word doesn't
  assert.deepEqual(mentioned(view, "all tables should page"), ["table"]);
  assert.deepEqual(mentioned(view, "a tablet layout"), []);
  // declared under a task that isn't there, or can't take one: never proposed
  assert.deepEqual(at("export to csv", "nowhere"), { candidates: [], basis: "needs you: it was declared under nowhere, but there is no task nowhere" });
  assert.deepEqual(at("retry the fetch metrics call", "fetch_metrics"), { candidates: [], basis: "needs you: it was declared under fetch_metrics, but fetch_metrics is done: it can't take a new task" });
  // the text names only a closed task: a person picks, told why
  assert.deepEqual(at("retry the fetch metrics call"), { candidates: [], basis: "needs you: fetch_metrics is done: it can't take a new task" });
  // nothing named anywhere
  assert.deepEqual(at("dark mode"), { candidates: [], basis: "needs you: it names no task, and it wasn't declared under one" });
  // the why counts only when the summary names nothing
  assert.deepEqual(at("dark mode", undefined, "the table glares at night").parent, "table");
  assert.deepEqual(at("dark mode for filters", undefined, "the table glares at night").parent, "filters");
});

test("a short or filler task name is never matched in the text", async () => {
  const w = await world();
  await w.born("a", "dashboard");
  await w.born("in", "dashboard");
  await w.born("ui", "dashboard");
  const { view } = await w.state();
  assert.deepEqual(mentioned(view, "a nicer ui in the table"), ["table"]);
});

test("an idea's id comes from its summary: no filler, not its parent's name, free as an idea and as a task", async () => {
  const w = await world();
  const { view } = await w.state();
  assert.equal(ideaId(view, "pagination would be good in table", "table"), "pagination");
  assert.equal(ideaId(view, "Table needs server-side pagination.", "table"), "server_side_pagination");
  assert.equal(ideaId(view, "should we?"), "idea");
  // a task already has the name: the task the idea becomes keeps its id, so the id moves on
  await w.born("pagination", "filters");
  await w.idea("pagination_2", {});
  assert.equal(ideaId((await w.state()).view, "pagination would be good in table", "table"), "pagination_3");
});

test("tira drives the idea between your two approvals: it drafts the file, then proposes the parent; the task is born under the one you approve, and replay checks every write", async () => {
  const w = await world();
  const pushed = await w.idea("pagination", { summary: "pagination would be good in table", why: "long tables scroll forever" });
  assert.equal(pushed.result.status, "appended");
  assert.deepEqual(pushed.handoffs.map((h) => `${h.rule} ${h.event}`), ["V1 idea.draft-file"]);
  let { events, r } = await w.state();
  const drafted = events.at(-1);
  assert.deepEqual([drafted?.type, drafted?.metadata.actor, drafted?.data.payload], ["idea.draft-file", "dispatcher", { summary: "pagination would be good in table", why: "long tables scroll forever" }]);
  assert.equal(drafted?.metadata.correlationId, events.at(-2)?.eventId); // the pair: the declaration, then the draft
  assert.equal(r.entities.find((e) => e.key === "idea:pagination")?.regions.lifecycle, "file_pending");
  // nothing more until a person approves the file
  const filed = await w.send("idea", "pagination", "APPROVE_FILE", {}, "claude"); // anyone may approve, the declarer too
  assert.deepEqual(filed.handoffs.map((h) => `${h.rule} ${h.event}`), ["V2 idea.propose-node"]);
  ({ events, r } = await w.state());
  assert.deepEqual(events.at(-1)?.data.payload, { parent_id: "table", candidates: ["table"], basis: "its text names table" });
  assert.equal(events.at(-1)?.metadata.correlationId, events.at(-2)?.eventId);
  assert.equal(r.entities.find((e) => e.key === "idea:pagination")?.regions.lifecycle, "node_pending");
  const placed = await w.send("idea", "pagination", "APPROVE_NODE", { parent_id: "table" });
  assert.deepEqual(placed.handoffs.map((h) => `${h.rule} ${h.event}`), ["F1 node.born"]);
  ({ events, r } = await w.state());
  const task = r.entities.find((e) => e.key === "node:pagination");
  assert.deepEqual([task?.regions.lifecycle, task?.tree?.parent, task?.tree?.kind], ["unstarted", "node:table", "planned"]);
  // every write was called for, and the log replays to the same bytes
  assert.deepEqual(r.anomalies, []);
  assert.deepEqual(r.handoffs[S] ?? [], []);
  assert.equal(canonicalJson(fold(events, w.registry)), canonicalJson(fold([...events].reverse(), w.registry)));
  const row = ideaRows(r, events, S).find((i) => i.id === "pagination");
  assert.deepEqual([row?.stage, row?.summary, row?.why, row?.declaredBy, row?.proposal?.parent, row?.placedUnder], ["materialized", "pagination would be good in table", "long tables scroll forever", "claude", "table", "table"]);
});

test("the proposal is made on the tree as it is when the file is approved, and a disagreement goes to a person", async () => {
  const w = await world();
  await w.idea("csv", { summary: "export the table to csv", why: "share it" });
  await w.idea("views", { summary: "saved views", why: "people rebuild them daily", under: "filters" });
  await w.idea("views2", { summary: "saved views for the table", why: "people rebuild them daily", under: "filters" });
  // the table is closed before csv's file is approved: tira no longer proposes it
  await w.send("node", "table", "CANCEL");
  await w.send("idea", "csv", "APPROVE_FILE");
  await w.send("idea", "views", "APPROVE_FILE");
  await w.send("idea", "views2", "APPROVE_FILE");
  const { events, r } = await w.state();
  const rows = new Map(ideaRows(r, events, S).map((i) => [i.id, i.proposal]));
  assert.deepEqual(rows.get("csv"), { candidates: [], basis: "needs you: table is cancelled: it can't take a new task", seq: rows.get("csv")?.seq });
  assert.equal(rows.get("views")?.parent, "filters");
  // declared under filters, its text names the cancelled table: only filters can take it, so no conflict
  assert.deepEqual([rows.get("views2")?.parent, rows.get("views2")?.basis], ["filters", "declared under filters"]);
  assert.deepEqual(r.anomalies, []);
});

test("an idea declared without a summary is driven by hand, as the engine scenario does it", async () => {
  const w = await world();
  const bare = await w.idea("7", {});
  assert.deepEqual(bare.handoffs, []); // no file to draft from
  await w.send("idea", "7", "DRAFT_FILE");
  const filed = await w.send("idea", "7", "APPROVE_FILE");
  assert.deepEqual(filed.handoffs, []); // a file with no text: nothing to place by
  assert.equal(fold(await w.store.readStream(S), w.registry).entities.find((e) => e.key === "idea:7")?.regions.lifecycle, "filed");
});

test("replay refuses a draft or a proposal the dispatcher wrote when no rule called for it", async () => {
  const w = await world();
  await w.idea("7", {});
  // forged: a draft under the dispatcher's name for an idea that said nothing
  await w.store.append(S, [{ type: "idea.draft-file", data: { entity: { id: "7" }, payload: { summary: "made up" } }, metadata: { actor: "dispatcher", correlationId: "x", era: w.registry.era } }]);
  const { r } = await w.state();
  assert.deepEqual(r.anomalies.map((a) => a.problem), ["the dispatcher wrote idea.draft-file on idea:7, but no handoff rule called for it"]);
});

// ---------- the agent's command ----------

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "tira-idea-"));
  const db = freshDb(dir);
  const tira = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    // a throwaway SQLite file, or (under ideas-postgres) a Postgres schema of its own, opened as live
    const code = await run(["--db", db, ...argv], { out: (l) => out.push(l), err: (l) => err.push(l), env: {}, ...(db.startsWith("postgres") ? {} : { openStore: sqliteFile }) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { tira, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("tira idea: one sentence from an agent becomes a declared idea with its file drafted, and says where it would go and what happens next", async () => {
  const s = sandbox();
  try {
    await s.tira("create", "node", "dashboard");
    await s.tira("create", "node", "table", "--parent", "dashboard");
    await s.tira("create", "node", "filters", "--parent", "dashboard");
    const pushed = await s.tira("idea", "pagination would be good in table", "--why", "long tables scroll forever", "--actor", "claude");
    assert.equal(pushed.code, 0, pushed.err);
    assert.match(pushed.out, /appended\s+seq 4\s+idea:pagination\s+created/);
    assert.match(pushed.out, /^ {2}\+ dispatcher idea\.draft-file on idea:pagination \(V1, seq 5\)$/m);
    assert.match(pushed.out, /^parent: table \(its text names table\)$/m);
    assert.match(pushed.out, /^next: a person approves the file; tira then proposes it under table, and a person approves that$/m);
    // a disagreement: no parent, the candidates, a person picks
    const split = await s.tira("idea", "saved views for filters", "--why", "daily rebuilds", "--under", "table", "--actor", "claude", "--json");
    const j = JSON.parse(split.out);
    assert.deepEqual([j.status, j.id, j.placement], ["appended", "saved_views_filters", { candidates: ["table", "filters"], basis: "needs you: it was declared under table, but its text names filters" }]);
    assert.match(j.next, /picks where it goes when approving the placement \(candidates: table, filters\)/);
    // what it needs, said plainly
    const noWhy = await s.tira("idea", "dark mode", "--actor", "claude");
    assert.equal(noWhy.code, 1);
    assert.match(noWhy.err, /an idea's file is its summary and why: add --why/);
    assert.match((await s.tira("idea", "dark mode", "--why", "night")).err, /tira idea needs --actor NAME/);
    assert.match((await s.tira("idea", "x", "--why", "y", "--id", "table", "--actor", "claude")).err, /table is taken/);
    const list = await s.tira("ideas");
    assert.match(list.out, /2 idea\(s\), 2 open/);
    assert.match(list.out, /pagination\s+file to approve\s+pagination would be good in table\s+claude/);
    const sent = await s.tira("send", "idea", "pagination", "APPROVE_FILE", "--actor", "isha");
    assert.match(sent.out, /\+ dispatcher idea\.propose-node on idea:pagination \(V2, seq \d+\)/);
    assert.match((await s.tira("ideas")).out, /pagination\s+placement to approve\s+table/);
  } finally {
    s.done();
  }
});

// ---------- the board ----------

test("on the board an open idea is a dashed card in the Ideas column and a ghost on the Graph, under the task tira proposed; never a task", async () => {
  const w = await world();
  await w.idea("pagination", { summary: "pagination would be good in table", why: "long tables scroll forever" });
  await w.idea("views", { summary: "saved views for filters and the table", why: "daily rebuilds" });
  await w.idea("csv", { summary: "export to csv", why: "share it" });
  await w.idea("gone", { summary: "a dropped idea", why: "no" });
  await w.send("idea", "pagination", "APPROVE_FILE");
  await w.send("idea", "views", "APPROVE_FILE");
  await w.send("idea", "gone", "REJECT_FILE", { reason: "not worth it" });
  const { events, r } = await w.state();
  const html = renderHtml(r, S, "h", events);
  // Kanban: the Ideas column first, open ideas only
  const kanban = /<div class="bv bv-kanban">[^]*?<div class="bv bv-graph">/.exec(html)?.[0] ?? "";
  assert.match(kanban, /<div class="cols"><div class="col"><div class="ch"><span class="dot" style="background:var\(--accent\)"><\/span>Ideas<span class="k">3<\/span>/);
  assert.deepEqual([...kanban.matchAll(/data-idea-card="([^"]+)" data-stage="([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`), ["idea:pagination node_pending", "idea:views node_pending", "idea:csv file_pending"]);
  assert.match(kanban, /<span class="tag">idea<\/span><div class="t">pagination would be good in table<\/div><div class="row"><span class="chip stage">placement to approve<\/span><span class="chip">under table<\/span>/);
  assert.match(kanban, /<span class="chip stage loose">needs a parent<\/span>/);
  assert.doesNotMatch(html, /a dropped idea<\/div>/);
  // Graph: a ghost under its proposed parent, joined by a dashed line; the others on the top row
  const graph = /<div class="bv bv-graph">[^]*?<\/section>/.exec(html)?.[0] ?? "";
  assert.match(graph, /<a class="ghost" href="#i0" style="left:[\d.]+px;top:(\d+)px" aria-label="idea pagination: pagination would be good in table, placement to approve, proposed under table" data-parent="node:table" data-idea="idea:pagination" data-stage="node_pending"/);
  assert.match(graph, /<path class="e idea" data-from="node:table" data-to="idea:pagination" d="/);
  assert.match(graph, /<a class="ghost loose" href="#i1" [^>]*aria-label="[^"]*needs a parent" data-idea="idea:views"/);
  assert.match(graph, /<a class="ghost" href="#i2" [^>]*aria-label="[^"]*not placed yet" data-idea="idea:csv"/);
  assert.match(graph, /data-idea="idea:pagination"[^>]*><span class="tag">idea<\/span>/);
  const top = (attr: string) => Number(new RegExp(`top:(\\d+)px"[^>]*${attr}`).exec(graph)?.[1]);
  assert.ok(top('data-idea="idea:pagination"') > top('data-key="node:table"'), "under its parent");
  assert.equal(top('data-idea="idea:csv"'), top('data-key="node:dashboard"'), "unplaced: the top row");
  // never a task: no data-key, not in the counts
  assert.equal((html.match(/ data-key="/g) ?? []).length, r.entities.filter((e) => e.tree).length);
  assert.match(html, /data-node-count="6" data-fold-tree-count="6"/);
  // its dialog: what it says, where it goes and why, what's next; a static page has no actions
  assert.match(html, /<section class="drawer" id="i0" aria-label="idea pagination" role="dialog" aria-modal="true" data-idea-dialog="idea:pagination">/);
  assert.match(html, /<dt>Why<\/dt><dd>long tables scroll forever<\/dd><dt>Goes under<\/dt><dd>table: its text names table \(tira&#39;s proposal, seq \d+\)<\/dd>/);
  assert.match(html, /<dt>Goes under<\/dt><dd>needs you: its text names filters and table \(candidates: filters, table\)<\/dd><dt>Next<\/dt><dd>Pick its parent when you approve the placement/);
  assert.match(html, /<dt>Goes under<\/dt><dd>not proposed yet: tira proposes it once the file is approved<\/dd>/);
  assert.doesNotMatch(html, /data-dialog-acts>[^]*?APPROVE/);
  // live: each dialog offers its stage's approvals
  const live = renderHtml(r, S, "h", events, { live: {} });
  assert.match(live, /id="i0"[^]*?<a class="act" href="\/confirm\?type=idea&#38;id=pagination&#38;event=APPROVE_NODE" data-act="APPROVE_NODE">Approve placement<\/a><a class="act" href="[^"]*REJECT_NODE" data-act="REJECT_NODE">Reject placement<\/a>/);
  assert.match(live, /id="i2"[^]*?data-act="APPROVE_FILE">Approve file<\/a>[^]*?data-act="REJECT_FILE">Reject file<\/a>/);
});

// ---------- the approvals, live ----------

async function serving() {
  const w = await world();
  const server = tiraServer({ store: w.store, registry: w.registry, stream: S, actor: "isha", token: "k" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const http = (method: string, path: string, body?: string) => new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}) }));
    });
    req.on("error", reject);
    req.end(body);
  });
  // as the dialog posts it: what it opened, the seq it saw, your command
  const run = async (id: string, event: string, command: string) => {
    const seen = String((await w.store.readStream(S)).at(-1)?.seq);
    return http("POST", "/act", new URLSearchParams({ token: "k", type: "idea", id, event, command, fragment: "1", seen }).toString());
  };
  const flash = async (r: { body: string }) => ((await http("GET", /data-go="([^"]+)"/.exec(r.body)?.[1] ?? "/")).body.match(/data-flash>([^<]+)</)?.[1] ?? "").replaceAll("&#39;", "'");
  return { ...w, http, run, flash, done: () => new Promise<void>((r) => server.close(() => r())) };
}

test("approving an idea goes through the decision dialog: the work in a nutshell, then the command, filled in; file first, then the placement tira proposed, and the task is born", async () => {
  const s = await serving();
  try {
    await s.idea("pagination", { summary: "pagination would be good in table", why: "long tables scroll forever" });
    const fileDecision = (await s.http("GET", "/confirm?type=idea&id=pagination&event=APPROVE_FILE&fragment=1")).body;
    assert.match(fileDecision, /<h1>Approve file pagination\?<\/h1>/);
    assert.match(fileDecision, /<b>Decision:<\/b> Idea pagination: &#34;pagination would be good in table&#34;\. Why: &#34;long tables scroll forever&#34;\. Declared by claude at seq \d+\. Its file \(the summary and why\) waits for approval\. Approving files it; tira then proposes where it goes, and asks you again\. Recorded as isha\./);
    assert.match(fileDecision, /<p class="verdict ok">tira&#39;s check: allowed\.<\/p>/);
    assert.doesNotMatch(fileDecision, /data-command|data-you-part/); // nothing to fill in: approve it, or not
    assert.match(fileDecision, /<button class="act primary" type="submit">Approve file<\/button>/);
    const filed = await s.run("pagination", "APPROVE_FILE", "tira send idea pagination APPROVE_FILE");
    assert.equal(await s.flash(filed), "Approve file pagination: done (seq 11). tira proposes it under table (its text names table): approve the placement next.");
    // the placement: tira's parent filled in, editable; no button for the one already filled in
    const place = (await s.http("GET", "/confirm?type=idea&id=pagination&event=APPROVE_NODE&fragment=1")).body;
    assert.match(place, /<b>Decision:<\/b> [^<]* tira proposes it under table: its text names table\. Approving makes it a task under the parent you name, to do\./);
    assert.match(place, /<b>Recommendation:<\/b> Approve it under table if that&#39;s where it fits; change parent_id to put it elsewhere\./);
    assert.match(place, /data-nutshell>[^]*?<p class="verdict ok">[^]*?<b>Recommendation:<\/b>[^]*?<details class="why" data-why><summary>Why: tradeoffs, best practice, kind<\/summary>/); // the nutshell first, the rest folded
    assert.match(place, /<label class="field" data-field="parent_id"><span>Goes under<\/span><input type="text" name="parent_id" value="table" placeholder="the task it becomes a subtask of"/); // tira's proposal, to change
    assert.doesNotMatch(place, /data-fill="parent_id"/);
    const born = await s.run("pagination", "APPROVE_NODE", 'tira send idea pagination APPROVE_NODE parent_id="table"');
    assert.equal(await s.flash(born), "Approve placement pagination: done (seq 13). It's a task now: pagination, under table.");
    const { r } = await s.state();
    assert.equal(r.entities.find((e) => e.key === "node:pagination")?.tree?.parent, "node:table");
    assert.deepEqual(r.anomalies, []);
  } finally {
    await s.done();
  }
});

test("a stage skip is refused live, in plain words, and nothing is written: approving the placement while the file is still pending", async () => {
  const s = await serving();
  try {
    await s.idea("sort", { summary: "sort by column", why: "find big rows", under: "table" });
    const n0 = (await s.store.readStream(S)).length;
    const skip = (await s.http("GET", "/confirm?type=idea&id=sort&event=APPROVE_NODE&fragment=1")).body;
    assert.match(skip, /<p class="verdict no">tira would refuse this: the file isn&#39;t approved yet, and the placement comes after the file \(denied: idea-lifecycle: file_pending \+ APPROVE_NODE\)\.<\/p>/);
    assert.match(skip, /<b>What to do:<\/b> Approve the file first \(or reject it\)\. tira then proposes where it goes, and you approve that\./);
    assert.match(skip, /<b>Recommendation:<\/b> Don&#39;t run it: the file isn&#39;t approved yet/);
    assert.match(skip, /data-ok="false"/);
    // edited into it from the file's dialog: tira's word on that one first
    const edited = await s.run("sort", "APPROVE_FILE", 'tira send idea sort APPROVE_NODE parent_id="table"');
    assert.match(edited.body, /<h1>Approve placement sort\?<\/h1><p class="flash no" role="status" data-notice>That&#39;s a different action/);
    // sent anyway: refused in the dialog, never in the log
    const sent = await s.run("sort", "APPROVE_NODE", 'tira send idea sort APPROVE_NODE parent_id="table"');
    assert.equal(sent.status, 409);
    assert.match(sent.body, /data-error>tira would still refuse this: the file isn&#39;t approved yet, and the placement comes after the file \(denied: idea-lifecycle: file_pending \+ APPROVE_NODE\)\. Nothing was written\./);
    assert.equal((await s.store.readStream(S)).length, n0);
  } finally {
    await s.done();
  }
});

test("the placement's parent is checked before it's written: it must exist and take the task; when tira couldn't settle it, you pick from what it found", async () => {
  const s = await serving();
  try {
    await s.idea("views", { summary: "saved views for filters and the table", why: "daily rebuilds" });
    await s.send("idea", "views", "APPROVE_FILE");
    const pick = (await s.http("GET", "/confirm?type=idea&id=views&event=APPROVE_NODE&fragment=1")).body;
    assert.match(pick, /tira couldn&#39;t settle where it goes \(its text names filters and table\): you pick\. Candidates: filters, table\./);
    assert.match(pick, /<input type="text" name="parent_id" value=""/);
    assert.match(pick, /<button type="button" class="fill" data-fill="parent_id" data-value="filters">filters<\/button><button type="button" class="fill" data-fill="parent_id" data-value="table">table<\/button>/);
    const n0 = (await s.store.readStream(S)).length;
    const empty = await s.run("views", "APPROVE_NODE", 'tira send idea views APPROVE_NODE parent_id=""');
    assert.match(empty.body, /data-error>Say where it goes: parent_id=&#34;…&#34; \(the task it becomes a subtask of\)\. Nothing was written\./);
    const nowhere = await s.run("views", "APPROVE_NODE", 'tira send idea views APPROVE_NODE parent_id="nowhere"');
    assert.match(nowhere.body, /data-error>tira can&#39;t run that: there is no task nowhere\. Nothing was written\./);
    const closed = await s.run("views", "APPROVE_NODE", 'tira send idea views APPROVE_NODE parent_id="fetch_metrics"');
    assert.match(closed.body, /data-error>tira can&#39;t run that: fetch_metrics is done: it can&#39;t take a new task\. Nothing was written\./);
    // posted without the dialog: refused the same way
    const seen = String((await s.store.readStream(S)).at(-1)?.seq);
    const raw = await s.http("POST", "/act", new URLSearchParams({ token: "k", type: "idea", id: "views", event: "APPROVE_NODE", parent_id: "nowhere", seen }).toString());
    assert.equal(raw.status, 409);
    assert.equal((await s.store.readStream(S)).length, n0);
    const ok = await s.run("views", "APPROVE_NODE", 'tira send idea views APPROVE_NODE parent_id="filters"');
    assert.equal(await s.flash(ok), `Approve placement views: done (seq ${n0 + 1}). It's a task now: views, under filters.`);
  } finally {
    await s.done();
  }
});

test("a reject needs a reason, and drops the idea", async () => {
  const s = await serving();
  try {
    await s.idea("csv", { summary: "export to csv", why: "share it" });
    const decision = (await s.http("GET", "/confirm?type=idea&id=csv&event=REJECT_FILE&fragment=1")).body;
    assert.match(decision, /<b>Kind:<\/b> final \(a dropped idea can&#39;t come back\)\. The rule: event\.reason is a non-empty string\./);
    assert.match(decision, /<label class="field" data-field="reason"><span>Reason<\/span><input type="text" name="reason" value=""/);
    assert.doesNotMatch(decision, /data-comment-field/); // an idea has no comments: its task will
    const bare = await s.run("csv", "REJECT_FILE", 'tira send idea csv REJECT_FILE reason="  "');
    assert.match(bare.body, /data-error>Add the reason: reason=&#34;…&#34; \(words, not only spaces\)\. Nothing was written\./);
    const ok = await s.run("csv", "REJECT_FILE", 'tira send idea csv REJECT_FILE reason="we export elsewhere"');
    assert.match(await s.flash(ok), /^Reject file csv: done \(seq \d+\)\. It's dropped; your reason stays in its history\.$/);
    const { events, r } = await s.state();
    assert.deepEqual(ideaRows(r, events, S).map((i) => [i.stage, i.reason]), [["dropped", "we export elsewhere"]]);
    assert.doesNotMatch((await s.http("GET", "/")).body, /data-idea-card/); // gone from the board
  } finally {
    await s.done();
  }
});

test("an idea's verbs are for ideas, a task's for tasks: the command says which", () => {
  const isTree = (t: string) => t === "node";
  const why = (text: string) => {
    const p = parseCommand(text, isTree);
    return p.ok ? "" : p.why;
  };
  assert.equal(why("tira send node table APPROVE_FILE"), "APPROVE_FILE is for ideas: tira send idea <idea> APPROVE_FILE");
  assert.equal(why("tira send idea x START"), "START is for tasks (node); an idea takes APPROVE_FILE, REJECT_FILE, APPROVE_NODE, REJECT_NODE");
  assert.equal(why('tira send idea x APPROVE_NODE reason="r"'), 'APPROVE_NODE takes parent_id="…" and note="…", not reason');
  const ok = parseCommand('tira send idea x APPROVE_NODE parent_id="table" note="fits"', isTree);
  assert.deepEqual(ok.ok ? ok.action : undefined, { type: "idea", id: "x", event: "APPROVE_NODE", payload: { parent_id: "table", note: "fits" } });
});

test("refusals of an idea's approvals say why and what to do, at every stage", () => {
  const at = (stage: string, event: string, text = true) => ideaRefusal(stage, event, "x", text);
  assert.equal(at("file_pending", "APPROVE_NODE").why, "the file isn't approved yet, and the placement comes after the file");
  assert.equal(at("file_pending", "REJECT_NODE").why, "the file isn't approved yet, and the placement comes after the file");
  assert.equal(at("declared", "APPROVE_NODE").why, "the file isn't approved yet, and the placement comes after the file");
  assert.deepEqual(at("declared", "APPROVE_FILE"), { why: "its file isn't drafted yet", todo: "tira drafts it from what the idea says; approve it then." });
  assert.match(at("declared", "APPROVE_FILE", false).todo, /^Draft it first: tira send idea x DRAFT_FILE/);
  assert.equal(at("filed", "APPROVE_NODE").why, "tira hasn't proposed where it goes yet");
  assert.equal(at("filed", "REJECT_FILE").why, "the file is already approved; this step is the placement");
  assert.equal(at("node_pending", "APPROVE_FILE").why, "the file is already approved; this step is the placement");
  assert.deepEqual(at("materialized", "REJECT_NODE"), { why: "the idea is a task already", todo: "Open the task x on the board." });
  assert.equal(at("dropped", "APPROVE_FILE").why, "the idea was dropped");
  // the brief says the refusal first, and promises nothing
  const brief = ideaBriefFor({ id: "x", event: "APPROVE_NODE", stage: "file_pending", summary: "s", declaredSeq: 3, refusal: at("file_pending", "APPROVE_NODE"), noop: false, actor: "isha" });
  assert.equal(brief.recommendation, "Don't run it: the file isn't approved yet, and the placement comes after the file.");
  assert.equal(brief.kind, "refused by the rules.");
  assert.doesNotMatch(brief.decision, /Approving/);
});
