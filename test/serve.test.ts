// `tira serve` (the D1 UI brief): the live page, its confirm pages, its writes, and the
// palette's ranking. Requests go over real HTTP to a server on 127.0.0.1:0.
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { fold } from "../src/fold/fold.ts";
import { renderHtml } from "../src/render/html.ts";
import { CSP, changedBy, hintFor, inOrder, taskIndex, tiraServer, withQ, workspaceIn, workspaceList } from "../src/serve/server.ts";
import { esc } from "../src/render/escape.ts";
import { filesMatching, srcCode } from "./src-text.ts";
// @ts-expect-error: plain JS shared with the browser (src/serve/rank.mjs)
import { priority, rank, score } from "../src/serve/rank.mjs";
import { answerFor, words } from "../src/serve/help.mjs";

const S = "tasktree-dash";

// The README's dashboard, mid-work: colors blocked (why: tokens), loading_state in progress.
async function world() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const born = (id: string, parent_id?: string) => wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}) => wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  await born("dashboard");
  await born("metrics_card", "dashboard");
  await born("fetch_metrics", "metrics_card");
  await born("improve_visual", "metrics_card");
  for (const id of ["colors", "loading_state", "font"]) await born(id, "improve_visual");
  await born("table", "dashboard");
  await born("filters", "dashboard");
  await send("colors", "BLOCK", { reason: "waiting on the design-token decision" });
  await send("loading_state", "START");
  return { store, registry, send };
}

async function serving() {
  const w = await world();
  const server = tiraServer({ store: w.store, registry: w.registry, stream: S, actor: "isha", token: "t0k3n" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const http = (method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end(opts.body);
    });
  // as a confirm page posts it: with the seq it was decided on (`seen`), unless a test overrides it
  const form = async (fields: Record<string, string>, origin = `http://127.0.0.1:${port}`) => {
    const seen = String((await w.store.readStream(S)).at(-1)?.seq ?? 0);
    return http("POST", "/act", { headers: { "content-type": "application/x-www-form-urlencoded", origin }, body: new URLSearchParams({ seen, ...fields }).toString() });
  };
  return { ...w, server, port, http, form, done: () => new Promise<void>((r) => server.close(() => r())) };
}

test("the live page: needs attention with actions, the palette, the guide; strict CSP; the rendered file has none of the live parts", async () => {
  const s = await serving();
  try {
    const page = await s.http("GET", "/");
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-security-policy"], CSP);
    // pinned literally: a change to the policy itself must show up here
    assert.equal(CSP, "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    assert.equal(page.headers["cache-control"], "no-store");
    // not no-referrer: under it, browsers send Origin: null on the page's own form posts
    assert.equal(page.headers["referrer-policy"], "same-origin");
    assert.match(page.body, /<script type="module" src="\/app\.mjs"><\/script>/);
    assert.match(page.body, /data-open-palette/);
    assert.match(page.body, /<a class="act" href="\/confirm\?type=node&#38;id=colors&#38;event=UNBLOCK" data-act="UNBLOCK">Unblock<\/a>/);
    assert.match(page.body, /<a class="act" href="\/confirm\?type=node&#38;id=loading_state&#38;event=COMPLETE" data-act="COMPLETE">Complete<\/a>/);
    assert.match(page.body, /<section class="drawer guide" id="guide"[^>]*data-guide>/);
    assert.ok(!/<script(?![^>]*src="\/app\.mjs")/.test(page.body), "no inline script");
    // the same log rendered to a file: no script, no actions, no search button
    const events = await s.store.readStream(S);
    const file = renderHtml(fold(events, s.registry), S, "h", events);
    for (const live of ["<script", "data-open-palette", 'class="act"', "data-flash"]) assert.ok(!file.includes(live), live);
    assert.match(file, /data-guide/); // the guide is in both
    // the scripts it loads, from this server only
    const app = await s.http("GET", "/app.mjs");
    assert.equal(app.status, 200);
    assert.match(String(app.headers["content-type"]), /^text\/javascript/);
    assert.match(app.body, /from "\.\/rank\.mjs"/);
    // live, Esc closes an open task dialog (unless the palette took it), and focus follows the dialog
    assert.match(app.body, /e\.key === "Escape" && !e\.defaultPrevented && root\.hidden && !confirmBox\.open && openDialog\(\)\) \{ location\.hash = "_";/);
    assert.match(app.body, /dialog\.querySelector\("\.close"\)\?\.focus\(\)/);
    assert.equal((await s.http("GET", "/rank.mjs")).status, 200);
    // the theme choice, remembered per browser: app.mjs loads it on the page
    assert.match(app.body, /import "\.\/theme\.mjs";/);
    const theme = await s.http("GET", "/theme.mjs");
    assert.equal(theme.status, 200);
    assert.match(theme.body, /localStorage\.setItem\(KEY, r\.dataset\.themeChoice\)/);
    // the graph's canvas (pan, zoom, folds), on the same layout code the page was rendered with
    assert.match(app.body, /import \{ graph \} from "\.\/graph\.mjs";/);
    const graph = await s.http("GET", "/graph.mjs");
    assert.equal(graph.status, 200);
    assert.match(graph.body, /from "\.\/layout\.mjs";/);
    const layout = await s.http("GET", "/layout.mjs");
    assert.equal(layout.status, 200);
    assert.match(String(layout.headers["content-type"]), /^text\/javascript/);
    assert.equal(layout.body, readFileSync(new URL("../src/serve/layout.mjs", import.meta.url), "utf8"));
    assert.equal((await s.http("GET", "/nope")).status, 404);
  } finally {
    await s.done();
  }
});

test("only 127.0.0.1 / localhost answer: another Host is refused (DNS rebinding)", async () => {
  const s = await serving();
  try {
    assert.equal((await s.http("GET", "/", { headers: { host: "evil.example" } })).status, 403);
    assert.equal((await s.http("GET", "/", { headers: { host: `localhost:${s.port}` } })).status, 200);
  } finally {
    await s.done();
  }
});

test("the palette's index lists every task in drawer order, with its path", async () => {
  const s = await serving();
  try {
    const tasks = JSON.parse((await s.http("GET", "/api/tasks")).body) as { id: string; state: string; path: string; drawer: string }[];
    assert.deepEqual(tasks.map((t) => t.id), ["dashboard", "metrics_card", "fetch_metrics", "improve_visual", "colors", "loading_state", "font", "table", "filters"]);
    assert.deepEqual(tasks.find((t) => t.id === "colors"), { key: "node:colors", type: "node", id: "colors", state: "blocked", path: "dashboard › metrics_card › improve_visual", drawer: "t4", next: false });
    // the task tira says comes next is marked, once: the palette offers it first
    assert.deepEqual(tasks.filter((t) => (t as { next?: boolean }).next).map((t) => t.id), ["fetch_metrics"]);
    const page = (await s.http("GET", "/")).body;
    for (const t of tasks) assert.ok(page.includes(`<section class="drawer" id="${t.drawer}" aria-label="${t.id}" role="dialog" aria-modal="true">`), t.id);
  } finally {
    await s.done();
  }
});

test("every decision has two views: the work in a nutshell with tira's recommendation, and the command it will run, filled in", async () => {
  const s = await serving();
  try {
    const before = (await s.store.readStream(S)).length;
    const unblock = await s.http("GET", "/confirm?type=node&id=colors&event=UNBLOCK");
    assert.equal(unblock.status, 409); // loading_state is in progress: one active task at a time
    assert.match(unblock.body, /data-ok="false"/);
    assert.match(unblock.body, /tira would refuse this: gate: one active task: node:loading_state is already active\./);
    // the nutshell first: the move, then tira's verdict and what to do instead, then the recommendation
    assert.match(unblock.body, /<section class="brief" aria-label="tira recommends \(read-only\)" data-brief><h2>tira recommends<\/h2><p class="nutshell" data-nutshell><b>Decision:<\/b> colors is blocked under improve_visual since seq 10: &#34;waiting on the design-token decision&#34;\. Recorded as isha\.<\/p><p class="verdict no">tira would refuse this: [^<]+<\/p><p class="hint" data-hint>[^]*?<\/p><p><b>Recommendation:<\/b> Don&#39;t run it: tira will refuse \(gate: /);
    // the tradeoffs, best practice and kind wait under "Why"
    assert.match(unblock.body, /<details class="why" data-why><summary>Why: tradeoffs, best practice, kind<\/summary><p><b>Tradeoffs:<\/b> [^<]+<\/p><p><b>Best practice:<\/b> [^<]+<\/p><p><b>Kind:<\/b> refused by the rules\.<\/p><\/details><\/section>/);
    assert.match(unblock.body, /<p><b>Kind:<\/b> refused by the rules\.<\/p>/);
    // refused: the command shows, read-only, with nothing to run
    assert.match(unblock.body, /data-command>tira send node colors UNBLOCK<\/textarea><p class="cmd-help">tira would refuse this as it stands: edit it \(another task or verb\) and check again, or close\./);
    // still editable (into another task or verb), checked again before anything runs
    assert.match(unblock.body, /<button class="act" type="submit">Check again<\/button>/);
    assert.doesNotMatch(unblock.body, /— run it/);
    // a refusal says what to do instead
    assert.match(unblock.body, /<p class="hint" data-hint><b>What to do:<\/b> Only one task can be in progress\. Complete or block loading_state first, then unblock colors\.<\/p>/);
    // the theme, and the script that remembers the choice
    assert.match(unblock.body, /id="th-system" checked[^]*?<main class="packet-page"[^]*?<script type="module" src="\/theme\.mjs"><\/script><\/body>/); // the theme you picked (in Profile settings) carries here
    assert.doesNotMatch(unblock.body, /data-theme-switch/); // and is picked there, not here
    const complete = await s.http("GET", "/confirm?type=node&id=loading_state&event=COMPLETE");
    assert.equal(complete.status, 200);
    assert.match(complete.body, /<p class="nutshell" data-nutshell><b>Decision:<\/b> loading_state is in progress under improve_visual since seq 11\. Completing it moves it in progress → done\. Recorded as isha\.<\/p>/);
    assert.match(complete.body, /<p><b>Recommendation:<\/b> Complete it with proof anyone can re-check\.<\/p>/); // colors and font are still open
    assert.match(complete.body, /<p><b>Kind:<\/b> a finish \(needs proof\)\. The rule: event\.evidenceRef is a non-empty string\.<\/p>/);
    for (const k of ["Tradeoffs", "Best practice"]) assert.match(complete.body, new RegExp(`<p><b>${k}:</b> [^<]+</p>`), k);
    assert.match(complete.body, /<input type="hidden" name="seen" value="11">/);
    assert.match(complete.body, /tira&#39;s check: allowed\./);
    assert.match(complete.body, /<input type="hidden" name="token" value="t0k3n">/);
    // your action: the command, editable, with the proof to fill in, then the button
    assert.match(complete.body, /<h2>Your action — edit before sending<\/h2><textarea name="command" [^>]*data-command>tira send node loading_state COMPLETE evidenceRef=&#34;&#34;<\/textarea>/);
    assert.match(complete.body, /<button class="act primary" type="submit">Complete — run it<\/button>/);
    // starting fetch_metrics would leave nothing for tira to close yet; after the dashboard's
    // visual branch drains, moving on names the parent tira will close
    await s.send("loading_state", "COMPLETE", { evidenceRef: "spinner.mp4" });
    await s.send("font", "CANCEL");
    await s.send("colors", "UNBLOCK");
    await s.send("colors", "COMPLETE", { evidenceRef: "palette.png" });
    // the block form asks for what the gate checks: a reason with text, not only spaces (2026-10-20)
    const block = await s.http("GET", "/confirm?type=node&id=table&event=BLOCK");
    assert.match(block.body, /data-command>tira create node &#34;&#34; --parent table kind=discovered discovered_during=table\ntira send node table BLOCK blocker=&#34;&#34; reason=&#34;&#34;<\/textarea>/);
    assert.match(block.body, /<p><b>Kind:<\/b> a pause \(needs a reason\)\. The rule: event\.reason has text \(not only spaces\)\.<\/p>/);
    const start = await s.http("GET", "/confirm?type=node&id=table&event=START");
    assert.match(start.body, /Starting it moves it to do → in progress\. First, tira closes improve_visual \(every child closed\), citing this move\. Recorded as isha\./);
    assert.match(start.body, /<p><b>Recommendation:<\/b> Start it only if the order should change: next in order is fetch_metrics\.<\/p>/);
    // unknown verbs and tasks are explained, not offered
    assert.match((await s.http("GET", "/confirm?type=node&id=table&event=ADD_CHILD")).body, /tira doesn&#39;t take ADD_CHILD from the page\./);
    assert.match((await s.http("GET", "/confirm?type=node&id=ghost&event=START")).body, /There is no task ghost\./);
    assert.match((await s.http("GET", `/confirm?type=node&id=${encodeURIComponent("<b>")}&event=START`)).body, /There is no task &#60;b&#62;\./);
    assert.equal((await s.store.readStream(S)).length, before + 4); // only the four sends above wrote anything
  } finally {
    await s.done();
  }
});

test("writes need the token and a same-origin request, accept only the page's verbs on tree tasks, and land as the server's actor", async () => {
  const s = await serving();
  try {
    const count = async () => (await s.store.readStream(S)).length;
    const n0 = await count();
    assert.equal((await s.form({ type: "node", id: "loading_state", event: "COMPLETE", evidenceRef: "x" })).status, 403); // no token
    assert.equal((await s.form({ token: "wrong!", type: "node", id: "loading_state", event: "COMPLETE", evidenceRef: "x" })).status, 403);
    assert.equal((await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "COMPLETE", evidenceRef: "x" }, "https://evil.example")).status, 403);
    assert.equal((await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "COMPLETE", evidenceRef: "x" }, "null")).status, 403); // an opaque origin
    assert.equal((await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "ADD_CHILD" })).status, 400); // a table event the page doesn't offer
    assert.equal((await s.form({ token: "t0k3n", type: "node", id: "dashboard", event: "ADD_SUBTASK", name: "  " })).status, 400); // a subtask needs a name
    assert.equal((await s.form({ token: "t0k3n", type: "brief", id: "b", event: "START" })).status, 400);
    assert.equal((await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "COMPLETE", evidenceRef: "x", actor: "tira" })).status, 303); // a posted actor is ignored
    assert.equal(await count(), n0 + 1);
    const last = (await s.store.readStream(S)).at(-1);
    assert.deepEqual([last?.type, last?.metadata.actor, (last?.data.payload as { evidenceRef?: string }).evidenceRef], ["node.complete", "isha", "x"]);
  } finally {
    await s.done();
  }
});

test("after an action the page says what happened, a refusal included (and the refusal is in the log)", async () => {
  const s = await serving();
  try {
    const ok = await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "COMPLETE", evidenceRef: "spinner.mp4" });
    assert.equal(ok.status, 303);
    const okPage = await s.http("GET", String(ok.headers.location));
    assert.match(okPage.body, /<div class="flash ok" role="status" data-flash>Complete loading_state: done \(seq 12\)\.<\/div>/);
    await s.send("filters", "START"); // filters is now the one task in progress
    const no = await s.form({ token: "t0k3n", type: "node", id: "table", event: "START" }); // posted straight, past the decision
    const noPage = await s.http("GET", String(no.headers.location));
    assert.match(noPage.body, /<div class="flash no" role="status" data-flash>Start table: refused \(gate: one active task: /);
    assert.equal((await s.store.readStream(S)).at(-1)?.type, "command.rejected");
    // a flash shows once per link, and an unknown one shows nothing
    assert.ok(!(await s.http("GET", "/?r=999")).body.includes("data-flash"));
  } finally {
    await s.done();
  }
});

test("the confirm page is the write path's own decision: a drained active parent tira will close doesn't block a move elsewhere", async () => {
  const s = await serving();
  try {
    // p is started, its only child c1 done: p is the active task, finished, awaiting tira's close
    const tree = new (await import("../src/write/write-path.ts")).WritePath(s.store, s.registry);
    const mk = (id: string, parent_id?: string) => tree.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
    await s.send("loading_state", "COMPLETE", { evidenceRef: "e" });
    await mk("p", "table");
    await mk("c1", "p");
    await s.send("p", "START");
    await s.send("c1", "START");
    await s.send("c1", "COMPLETE", { evidenceRef: "e" });
    const page = await s.http("GET", "/confirm?type=node&id=filters&event=START");
    assert.equal(page.status, 200, page.body.match(/tira would refuse[^<]*/)?.[0]);
    assert.match(page.body, /First, tira closes p, then table \(/); // closing p drains table: the whole chain is named
    const done = await s.form({ token: "t0k3n", type: "node", id: "filters", event: "START" });
    const flash = await s.http("GET", String(done.headers.location));
    assert.match(flash.body, /Start filters: done \(seq \d+\)\. tira closed p, table, citing it\./);
  } finally {
    await s.done();
  }
});

test("a write is refused if the log moved after its confirm page (the packet is shown again), and a post that skipped the confirm page gets one", async () => {
  const s = await serving();
  try {
    const n0 = (await s.store.readStream(S)).length;
    const confirm = await s.http("GET", "/confirm?type=node&id=loading_state&event=COMPLETE");
    const seen = /name="seen" value="(\d+)"/.exec(confirm.body)?.[1] as string;
    await s.send("table", "BLOCK", { reason: "someone else wrote meanwhile" });
    const late = await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "COMPLETE", evidenceRef: "e", seen });
    assert.equal(late.status, 303);
    assert.equal(late.headers.location, "/confirm?type=node&id=loading_state&event=COMPLETE&moved=1");
    assert.equal((await s.store.readStream(S)).length, n0 + 1); // only the other write
    assert.match((await s.http("GET", String(late.headers.location))).body, /data-moved>The log changed since you opened this, so nothing was written\./);
    const bare = await s.http("POST", "/act", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=t0k3n&type=node&id=loading_state&event=COMPLETE&evidenceRef=e" });
    assert.equal(bare.headers.location, "/confirm?type=node&id=loading_state&event=COMPLETE");
    assert.equal((await s.store.readStream(S)).length, n0 + 1);
  } finally {
    await s.done();
  }
});

test("the server refuses to act as tira or the dispatcher; an oversized body gets a 413; a result shows once", async () => {
  const w = await world();
  for (const actor of ["tira", " T i r a ", "dispatcher"]) {
    assert.throws(() => tiraServer({ store: w.store, registry: w.registry, stream: S, actor }), /reserved/, actor);
  }
  const s = await serving();
  try {
    const big = await s.http("POST", "/act", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=t0k3n&x=${"a".repeat(20_000)}` });
    assert.equal(big.status, 413);
    assert.equal((await s.http("GET", "/")).status, 200);
    const ok = await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "COMPLETE", evidenceRef: "e" });
    const link = String(ok.headers.location);
    assert.match((await s.http("GET", link)).body, /data-flash/);
    assert.ok(!(await s.http("GET", link)).body.includes("data-flash"));
  } finally {
    await s.done();
  }
});

test("the palette finds every task of the demo in ≤ 3 keystrokes, filters by verb, and ranks 1,000 tasks well under 100 ms", async () => {
  const s = await serving();
  try {
    const tasks = taskIndex(fold(await s.store.readStream(S), s.registry), S);
    for (const t of tasks) {
      const ok = [1, 2, 3].some((n) => rank(t.id.slice(0, n), tasks).results[0]?.id === t.id)
        || rank(t.id.split(/_/).map((w: string) => w[0]).join("").slice(0, 3), tasks).results[0]?.id === t.id;
      assert.ok(ok, `${t.id} needs more than 3 keystrokes`);
    }
    // a verb first: only tasks whose state allows it
    assert.deepEqual(rank("unblock ", tasks).results.map((t: { id: string }) => t.id), ["colors"]);
    assert.equal(rank("unblock col", tasks).verb, "UNBLOCK");
    assert.deepEqual(rank("complete l", tasks).results.map((t: { id: string }) => t.id), ["loading_state"]);
    assert.equal(rank("start colors", tasks).results.length, 0); // blocked: unblock, don't start
    // ranking: exact > prefix > initials > word start > substring > in-order letters
    assert.ok(score("table", "table") > score("tab", "table"));
    assert.ok(score("tab", "table") > score("ls", "loading_state"));
    assert.ok(score("ls", "loading_state") > score("state", "loading_state"));
    assert.ok(score("state", "loading_state") > score("ding", "loading_state"));
    assert.ok(score("ding", "loading_state") > score("lgs", "loading_state"));
    assert.equal(score("xyz", "loading_state"), 0);
    assert.equal(rank("loading state", tasks).results[0]?.id, "loading_state"); // a space for an underscore
    // a 100-task tree of look-alike names: after ≤ 3 letters every task is among the visible
    // matches (the first 8, reachable with the arrow keys), though not always first
    const areas = ["dashboard", "metrics_card", "table", "filters", "settings", "auth", "billing", "export"];
    const doing = ["fetch", "render", "cache", "paginate", "sort", "filter", "validate", "style", "test", "document", "migrate", "refactor"];
    const hundred = areas.flatMap((a) => [a, ...doing.map((v) => `${v}_${a}`)]).slice(0, 100).map((id, i) => ({ key: `node:${id}`, type: "node", id, state: "unstarted", path: "app", drawer: `t${i}` }));
    const within3 = (id: string) => {
      const qs = new Set<string>([id.slice(0, 1), id.slice(0, 2), id.slice(0, 3), id.split("_").map((w) => w[0]).join("").slice(0, 3)]);
      for (let n = 1; n <= 3; n++) for (let at = 0; at + n <= id.length; at++) qs.add(id.slice(at, at + n));
      return [...qs].some((q) => rank(q, hundred).results.some((x: { id: string }) => x.id === id));
    };
    assert.deepEqual(hundred.filter((t) => !within3(t.id)).map((t) => t.id), []);
    // equal scores keep tree order
    const twins = [{ id: "ab", state: "unstarted", path: "" }, { id: "ac", state: "unstarted", path: "" }];
    assert.deepEqual(rank("a", twins).results.map((t: { id: string }) => t.id), ["ab", "ac"]);
    assert.deepEqual(rank("a", [...twins].reverse()).results.map((t: { id: string }) => t.id), ["ac", "ab"]);
    const many = Array.from({ length: 1000 }, (_, i) => ({ key: `node:t${i}`, type: "node", id: `task_${i}_${["ui", "api", "docs"][i % 3]}`, state: "unstarted", path: "app", drawer: `t${i}` }));
    // the best of three: the palette's speed, not whatever else the machine runs (other test files in parallel)
    const timed = () => {
      const t0 = performance.now();
      for (const q of ["t", "ta", "task_9", "api", "d"]) rank(q, many);
      return performance.now() - t0;
    };
    const best = Math.min(timed(), timed(), timed());
    assert.ok(best < 100, `${best.toFixed(1)} ms for 5 queries`);
  } finally {
    await s.done();
  }
});

test("a confirm opens as a dialog over the page: ?fragment=1 is just the packet, its way out closes the dialog, and the page's script opens every action in it", async () => {
  const s = await serving();
  try {
    const frag = await s.http("GET", "/confirm?type=node&id=table&event=BLOCK&fragment=1");
    assert.equal(frag.status, 200);
    assert.match(frag.body, /^<div class="packet" data-packet data-ok="true"><h1>Block table\?<\/h1>/);
    assert.doesNotMatch(frag.body, /<html|<nav|<script/); // no page around it
    assert.match(frag.body, /<button class="act primary" type="submit">Block — run it<\/button> <button class="how" type="button" data-close-confirm>Not now<\/button><\/div><\/form><\/div>$/);
    assert.equal(frag.headers["content-security-policy"], CSP);
    const refused = await s.http("GET", "/confirm?type=node&id=colors&event=UNBLOCK&fragment=1");
    assert.equal(refused.status, 409);
    assert.match(refused.body, /data-hint[^]*<button class="how" type="button" data-close-confirm>Close<\/button>/);
    // the full page keeps working for a direct link, and leaves by a link back to the page
    assert.match((await s.http("GET", "/confirm?type=node&id=table&event=BLOCK")).body, /<a class="how" href="\/">Not now<\/a><\/div><\/form>/);
    const app = (await s.http("GET", "/app.mjs")).body;
    assert.match(app, /closest\('a\.act\[href\^="\/confirm"\]'\)/); // every action link, in rows and task dialogs
    assert.match(app, /e\.preventDefault\(\);\n  void openConfirm\(link\.getAttribute\("href"\)\);/); // stays on the page
    assert.match(app, /if \(verb\) void openConfirm\(/); // and the palette's verbs
    assert.match(app, /fetch\(`\$\{href\}&fragment=1`/);
    assert.match(app, /confirmBox\.showModal\(\)/);
    assert.match(app, /catch \{\n    location\.href = href;/); // no packet: the confirm page instead
    // running it posts from the dialog: a decision comes back into it, a result sends the page there
    assert.match(app, /body\.set\("fragment", "1"\);/);
    assert.match(app, /if \(go\) location\.href = go;\n    else if \(packet\) show\(packet\);/);
  } finally {
    await s.done();
  }
});

test("the command you send is read strictly: a value left empty, a stray key or flag, another action, a moved log — nothing written; a good one runs as typed", async () => {
  const s = await serving();
  try {
    const count = async () => (await s.store.readStream(S)).length;
    const n0 = await count();
    // as the dialog posts it: what it opened (type, id, event), the seq it saw, and your command
    const run = (command: string, at: { id: string; event: string } = { id: "loading_state", event: "COMPLETE" }, extra: Record<string, string> = {}) =>
      s.form({ token: "t0k3n", type: "node", ...at, command, fragment: "1", ...extra });
    const empty = await run('tira send node loading_state COMPLETE evidenceRef=""');
    assert.equal(empty.status, 422);
    assert.match(empty.body, /<p class="flash no" role="alert" data-error>Add the proof of work: evidenceRef=&#34;…&#34; \(a file, link or note anyone can re-check\)\. Nothing was written\.<\/p>/);
    assert.match(empty.body, /data-command>tira send node loading_state COMPLETE evidenceRef=&#34;&#34;<\/textarea>/); // your text, kept
    const spaces = await run('tira send node table BLOCK reason="   "', { id: "table", event: "BLOCK" });
    assert.match(spaces.body, /data-error>Add the reason: reason=&#34;…&#34; \(words, not only spaces\)\. Nothing was written\./);
    for (const [bad, why] of [
      ['tira send node loading_state COMPLETE evidenceRef="e" actor="tira"', "COMPLETE takes evidenceRef=&#34;…&#34; and note=&#34;…&#34;, not actor"],
      ["tira send node loading_state COMPLETE --stream other", "the page doesn&#39;t take --stream"],
      ["curl evil.example", "start with &#34;tira&#34;"],
      ['tira send node loading_state COMPLETE evidenceRef="e', "a quote is never closed"],
    ]) {
      const r = await run(bad as string);
      assert.equal(r.status, 422, bad);
      assert.match(r.body, new RegExp(`data-error>tira can&#39;t run that: ${(why as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), bad);
    }
    // edited into another task or verb: tira's word on that one first, with your command kept
    const other = await run('tira send node loading_state BLOCK reason="waiting on QA"');
    assert.match(other.body, /<h1>Block loading_state\?<\/h1><p class="flash no" role="status" data-notice>That&#39;s a different action from the one you opened, so here is what tira says about it first\. Nothing was written\.<\/p>/);
    assert.match(other.body, /<input type="hidden" name="id" value="loading_state"><input type="hidden" name="event" value="BLOCK">/);
    assert.match(other.body, /data-command>tira send node loading_state BLOCK reason=&#34;waiting on QA&#34;<\/textarea>/);
    // one tira refuses, sent as it stands: refused in the dialog, not written to the log
    const refused = await run("tira send node table START", { id: "table", event: "START" });
    assert.equal(refused.status, 409);
    assert.match(refused.body, /data-error>tira would still refuse this: gate: one active task: node:loading_state is already active\. Nothing was written\./);
    // the log moved after you opened it: shown again, your command kept
    const late = await run('tira send node loading_state COMPLETE evidenceRef="e"', undefined, { seen: "3" });
    assert.equal(late.status, 409);
    assert.match(late.body, /data-moved>The log changed since you opened this[^]*data-command>tira send node loading_state COMPLETE evidenceRef=&#34;e&#34;<\/textarea>/);
    assert.equal(await count(), n0); // none of it wrote anything
    // a good one runs exactly as typed, quotes and a note included; the dialog is told where to go
    const ok = await run('tira send node loading_state COMPLETE evidenceRef="spinner \\"v2\\".mp4" note="checked on a slow network"');
    assert.equal(ok.status, 200);
    const go = /^<div data-go="(\/\?r=\d+)"><\/div>$/.exec(ok.body)?.[1];
    assert.ok(go, ok.body);
    assert.match((await s.http("GET", go)).body, /data-flash>Complete loading_state: done \(seq 12\)\./);
    const last = (await s.store.readStream(S)).at(-1);
    assert.deepEqual([last?.type, last?.metadata.actor, last?.data.payload], ["node.complete", "isha", { evidenceRef: 'spinner "v2".mp4', note: "checked on a slow network" }]);
    // a subtask by command; found work must be found under the task it goes under
    const wrong = await run("tira create node charts --parent dashboard kind=discovered discovered_during=table", { id: "dashboard", event: "ADD_SUBTASK" });
    assert.match(wrong.body, /data-error>tira can&#39;t run that: found work is marked kind=discovered discovered_during=dashboard/);
    const born = await run('tira create node "charts v2" --parent dashboard kind=discovered discovered_during=dashboard', { id: "dashboard", event: "ADD_SUBTASK" });
    assert.match(born.body, /^<div data-go=/);
    const charts = fold(await s.store.readStream(S), s.registry).entities.find((e) => e.id === "charts v2");
    assert.deepEqual([charts?.tree?.parent, charts?.tree?.kind], ["node:dashboard", "discovered"]);
    // without the dialog (no fragment): errors get the confirm page, a run goes back to the page
    const page = await s.form({ token: "t0k3n", type: "node", id: "table", event: "START", command: "tira send node table START" });
    assert.equal(page.status, 303);
  } finally {
    await s.done();
  }
});

test("writes run in order, each only if the one before it was written: no block without its ticket", async () => {
  const ran: string[] = [];
  const step = (name: string, ok: boolean) => async () => { ran.push(name); return { ok, text: `${name}: ${ok ? "done" : "refused"}.` }; };
  assert.deepEqual(await inOrder([step("ticket", true), step("block", true)]), { ok: true, text: "ticket: done. block: done." });
  ran.length = 0;
  assert.deepEqual(await inOrder([step("ticket", false), step("block", true)]), { ok: false, text: "ticket: refused." });
  assert.deepEqual(ran, ["ticket"]); // the block never ran
  assert.deepEqual(await inOrder([step("block", false)]), { ok: false, text: "block: refused." });
});

test("refusals say what to do instead", () => {
  const hint = (code: string, detail: string, event: string, id: string, state: string) => hintFor(code, detail, event, id, state);
  assert.equal(hint("gate", "one active task: node:font, node:table is already active", "START", "colors", "unstarted"), "Only one task can be in progress. Complete or block font, table first, then start colors.");
  assert.equal(hint("gate", "subtree not drained: node:p has open children node:a, node:b", "COMPLETE", "p", "in_progress"), "Close its open subtasks first (complete or cancel them): a, b.");
  assert.equal(hint("gate", "can't cancel node:p while children are open: node:a (close them first)", "CANCEL", "p", "unstarted"), "Close its open subtasks first (complete or cancel them): a.");
  assert.equal(hint("gate", "re-open node:p first: node:c sits under a closed parent (node:p is done; only a done parent can be re-opened)", "REOPEN", "c", "done"), "Re-open p first, with a reason.");
  assert.equal(hint("denied", "node-lifecycle: done + ADD_CHILD (re-open node:p first)", "ADD_SUBTASK", "p", "done"), "Re-open p first, with a reason.");
  assert.equal(hint("denied", "node-lifecycle: blocked + START", "START", "c", "blocked"), "c is blocked: unblock it instead.");
  assert.equal(hint("denied", "node-lifecycle: unstarted + COMPLETE", "COMPLETE", "c", "unstarted"), "Start c first.");
  assert.equal(hint("denied", "node-lifecycle: cancelled + REOPEN", "REOPEN", "c", "cancelled"), "Cancelled is final: add a new task instead.");
  assert.equal(hint("denied", "node-lifecycle: in_progress + REOPEN", "REOPEN", "c", "in_progress"), "Only a done task can be re-opened; c is in progress.");
  assert.equal(hint("guard-failed", "node-lifecycle: in_progress + BLOCK needs hasReasonText", "BLOCK", "c", "in_progress"), undefined);
});

test("to block, the dialog asks what it waits on: a new ticket, or an open task (not itself, not one it sits under, not a closed one); a re-open suggests reasons used before", async () => {
  const s = await serving();
  try {
    const block = (await s.http("GET", "/confirm?type=node&id=table&event=BLOCK&fragment=1")).body;
    assert.match(block, /<label class="blocked-by" data-blocked-by="table" data-type="node"><span>Blocked by<\/span><input type="text" placeholder="a new ticket, e\.g\. design_tokens"/);
    const open = () => [...block.matchAll(/data-fill-blocker="([^"]*)"/g)].map((m) => m[1]);
    for (const id of ["colors", "loading_state", "font", "filters", "fetch_metrics"]) assert.ok(open().includes(id), id);
    assert.ok(!open().includes("table"), "not itself");
    assert.ok(!open().includes("dashboard"), "not a task it sits under");
    assert.match(block, /<div class="fills" data-fills><span>Or an open task:<\/span>/);
    // the confirm page (no script) lists them as text
    assert.match((await s.http("GET", "/confirm?type=node&id=table&event=BLOCK")).body, /<p class="cmd-help">Open tasks it could wait on: metrics_card · fetch_metrics · improve_visual · colors · loading_state · font · filters<\/p>/);
    await s.send("loading_state", "COMPLETE", { evidenceRef: "spinner.mp4" }); // one task at a time
    await s.send("fetch_metrics", "START");
    await s.send("fetch_metrics", "COMPLETE", { evidenceRef: "api.md" });
    assert.ok(!(await s.http("GET", "/confirm?type=node&id=table&event=BLOCK&fragment=1")).body.includes('data-fill-blocker="fetch_metrics"'), "done tasks aren't waited on");
    // a re-open: nothing re-opened yet, no suggestions; then the reason used before
    assert.doesNotMatch((await s.http("GET", "/confirm?type=node&id=fetch_metrics&event=REOPEN&fragment=1")).body, /data-fills/);
    await s.send("fetch_metrics", "REOPEN", { reason: "numbers were wrong" });
    await s.send("fetch_metrics", "COMPLETE", { evidenceRef: "api-v2.md" });
    assert.match((await s.http("GET", "/confirm?type=node&id=fetch_metrics&event=REOPEN&fragment=1")).body, /<button type="button" class="fill" data-fill="reason" data-value="numbers were wrong">/);
  } finally {
    await s.done();
  }
});

test("blocking on a new ticket creates it under the blocked task and links the two everywhere: dialogs, needs attention, Kanban, Graph", async () => {
  const s = await serving();
  try {
    const count = async () => (await s.store.readStream(S)).length;
    const run = (command: string, id: string) => s.form({ token: "t0k3n", type: "node", id, event: "BLOCK", command, fragment: "1" });
    // the dialog's own default, filled in by the page's script: a ticket, then the block on it
    const ok = await run('tira create node qa_signoff --parent loading_state kind=discovered discovered_during=loading_state\ntira send node loading_state BLOCK blocker="qa_signoff" reason="QA hasn\'t signed off"', "loading_state");
    const go = /^<div data-go="(\/\?r=\d+)"><\/div>$/.exec(ok.body)?.[1] as string;
    assert.ok(go, ok.body);
    const page = (await s.http("GET", go)).body;
    assert.match(page, /data-flash>Add subtask qa_signoff under loading_state: done \(seq 12\)\. Block loading_state: done \(seq 13\)\.<\/div>/);
    const events = await s.store.readStream(S);
    const r = fold(events, s.registry);
    const qa = r.entities.find((e) => e.id === "qa_signoff");
    assert.deepEqual([qa?.tree?.parent, qa?.tree?.kind, qa?.regions.lifecycle], ["node:loading_state", "discovered", "unstarted"]);
    assert.deepEqual(events.at(-1)?.data.payload, { blocker: "qa_signoff", reason: "QA hasn't signed off" });
    // the link, both ways
    const dialog = (id: string) => new RegExp(`<section class="drawer" id="t\\d+" aria-label="${id}"[^]*?</section>`).exec(page)?.[0] ?? "";
    assert.match(dialog("loading_state"), /<div class="links" data-links><p><span class="lk">Blocked by<\/span><a href="#t\d+">qa_signoff<\/a><span class="state s-unstarted">/);
    assert.match(dialog("qa_signoff"), /<div class="links" data-links><p><span class="lk">Blocks<\/span><a href="#t\d+">loading_state<\/a><span class="state s-blocked">/);
    assert.match(page, /data-attention-key="node:loading_state"[^>]*>[^]*?<span class="by" data-blocked-by>waiting on <a href="#t\d+">qa_signoff<\/a>/);
    assert.match(page, /<div class="t">qa_<wbr>signoff<\/div><div class="row">[^]*?<span class="chip blocks" data-blocks>[^]*?blocks loading_state<\/span>/);
    assert.match(page, /<path class="e blocks" data-from="node:loading_state" data-to="node:qa_signoff"/); // its own subtask: the tree line is the link
    // both stay tickets on Kanban: the blocked task (now a parent) in Blocked, its new ticket in To do
    const kanban = /<div class="bv bv-kanban">[^]*?<div class="bv bv-graph">/.exec(page)?.[0] ?? "";
    assert.match(kanban, /Blocked<span class="k">2<\/span><\/div>[^]*?<div class="t">colors<\/div>[^]*?<div class="t">loading_<wbr>state<\/div><div class="row"><span class="chip">improve_visual<\/span><span class="chip" data-subtasks>0\/1 subtasks<\/span>[^]*?blocked by qa_signoff/);
    assert.match(kanban, /To do<span class="k">\d+<\/span><\/div>[^]*?<div class="t">qa_<wbr>signoff<\/div>/);
    assert.match(page, /aria-label="qa_signoff, to do, blocks loading_state/);
    // once the ticket is done, the wait looks over: said in needs attention and in the decision
    await s.send("qa_signoff", "START");
    await s.send("qa_signoff", "COMPLETE", { evidenceRef: "qa-report.pdf" });
    assert.match((await s.http("GET", "/")).body, /waiting on <a href="#t\d+">qa_signoff<\/a><span class="state s-done">done<\/span><\/span><span class="ready" data-ready>ready to unblock<\/span>/);
    assert.match((await s.http("GET", "/confirm?type=node&id=loading_state&event=UNBLOCK")).body, /Recommendation:<\/b> Unblock it: qa_signoff is done now, so the wait looks over\./);
    // an open task elsewhere: linked, nothing created, the reason waits on it; drawn as an arc
    const n0 = await count();
    const onTask = await run("tira send node table BLOCK blocker=filters", "table");
    assert.match(onTask.body, /^<div data-go=/);
    assert.equal(await count(), n0 + 1);
    assert.deepEqual((await s.store.readStream(S)).at(-1)?.data.payload, { blocker: "filters", reason: "waiting on filters" });
    assert.match((await s.http("GET", "/")).body, /<path class="e blocks" data-from="node:filters" data-blocks="node:table"/);
    // what a block can't wait on, said in the dialog, nothing written
    const n1 = await count();
    for (const [command, id, why] of [
      ["tira send node font BLOCK blocker=ghost", "font", "there is no task ghost to wait on"],
      ["tira send node font BLOCK blocker=improve_visual", "font", "font sits under improve_visual: a task can&#39;t wait on what it is part of"],
      ["tira send node font BLOCK blocker=qa_signoff", "font", "qa_signoff is already done: there&#39;s nothing to wait on"],
    ] as const) {
      const r = await run(command, id);
      assert.equal(r.status, 422, command);
      assert.match(r.body, new RegExp(`data-error>tira can&#39;t run that: ${why}`), command);
    }
    // a new ticket tira would refuse (the name is taken): neither the ticket nor the block is written
    const taken = await run("tira create node filters --parent font\ntira send node font BLOCK blocker=filters", "font");
    assert.equal(taken.status, 409);
    assert.match(taken.body, /data-error>tira would still refuse the new ticket filters: /);
    assert.equal(await count(), n1);
    // without the page's script (no reason written), the block waits on its ticket
    const plain = await run('tira create node fonts_licence --parent font kind=discovered discovered_during=font\ntira send node font BLOCK blocker="fonts_licence" reason=""', "font");
    assert.match(plain.body, /^<div data-go=/);
    assert.deepEqual((await s.store.readStream(S)).at(-1)?.data.payload, { blocker: "fonts_licence", reason: "waiting on fonts_licence" });
  } finally {
    await s.done();
  }
});

test("Cancel, Reopen and Add subtask go through the page like the other verbs", async () => {
  const s = await serving();
  try {
    const state = async (id: string) => fold(await s.store.readStream(S), s.registry).entities.find((e) => e.id === id);
    assert.equal((await s.form({ token: "t0k3n", type: "node", id: "table", event: "CANCEL" })).status, 303);
    assert.equal((await state("table"))?.regions.lifecycle, "cancelled");
    await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "COMPLETE", evidenceRef: "spinner.mp4" });
    assert.equal((await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "REOPEN", reason: "the spinner flickers" })).status, 303);
    assert.equal((await state("loading_state"))?.regions.lifecycle, "in_progress");
    // a subtask: born under the task, marked as discovered work when the box is ticked
    assert.equal((await s.form({ token: "t0k3n", type: "node", id: "dashboard", event: "ADD_SUBTASK", name: "  charts ", discovered: "1" })).status, 303);
    const charts = await state("charts");
    assert.equal(charts?.tree?.parent, "node:dashboard");
    assert.equal(charts?.tree?.kind, "discovered");
    assert.equal(charts?.tree?.discoveredDuring, "node:dashboard");
    await s.form({ token: "t0k3n", type: "node", id: "dashboard", event: "ADD_SUBTASK", name: "legend" });
    assert.equal((await state("legend"))?.tree?.kind, "planned");
    // the packet for a subtask says where it goes; under a done task it says to re-open first
    const add = (await s.http("GET", "/confirm?type=node&id=dashboard&event=ADD_SUBTASK")).body;
    assert.match(add, /This adds a new task at the end of its subtasks\./);
    assert.match(add, /data-command>tira create node &#34;&#34; --parent dashboard<\/textarea>/); // dashboard isn't under way: planned, unless you say found
    const addLive = (await s.http("GET", "/confirm?type=node&id=dashboard&event=ADD_SUBTASK&fragment=1")).body;
    assert.match(addLive, /<button type="button" class="fill" data-fill-found="dashboard">Mark as found while working on dashboard<\/button>/);
    // under a task in progress, a new subtask is marked as found while working on it
    assert.match((await s.http("GET", "/confirm?type=node&id=loading_state&event=ADD_SUBTASK")).body, /data-command>tira create node &#34;&#34; --parent loading_state kind=discovered discovered_during=loading_state<\/textarea>/);
    await s.send("loading_state", "COMPLETE", { evidenceRef: "spinner.mp4" }); // one task at a time
    await s.send("fetch_metrics", "START");
    await s.send("fetch_metrics", "COMPLETE", { evidenceRef: "api.md" });
    const underDone = (await s.http("GET", "/confirm?type=node&id=fetch_metrics&event=ADD_SUBTASK")).body;
    assert.match(underDone, /What to do:<\/b> Re-open fetch_metrics first, with a reason\./);
  } finally {
    await s.done();
  }
});

// ---------- the five representation classes, made structural (2026-10-21) ----------

test("attribute-escaping-total: [&<>\"'] never reaches an HTML surface raw: one escape, total over the class, on the rendered page and every served page", async () => {
  // structure: one escape in src, used by both HTML surfaces; no hand-written entities; the
  // browser scripts never build markup from data
  const src = srcCode();
  assert.deepEqual(filesMatching(src, /\bconst esc\b|\bfunction esc\b|\.replace\(\/\[[^\]]*[&<>"']/), ["src/render/escape.ts"]);
  assert.deepEqual(filesMatching(src, /import \{ esc \} from "[./]*(?:render\/)?escape\.ts";/), ["src/render/html.ts", "src/serve/integrations.ts", "src/serve/new-project.ts", "src/serve/server.ts", "src/serve/welcome.ts"]);
  assert.deepEqual(filesMatching(src, /&(?:amp|quot|lt|gt|apos|#3[489]|#6[02]);/), []);
  assert.deepEqual(filesMatching(src, /innerHTML\s*\+?=\s*`[^`]*\$\{/), []);
  // total over the class, and nothing else changes
  assert.equal(esc(`&<>"'`), "&#38;&#60;&#62;&#34;&#39;");
  for (let c = 0x20; c < 0x7f; c++) if (!`&<>"'`.includes(String.fromCharCode(c))) assert.equal(esc(String.fromCharCode(c)), String.fromCharCode(c));
  // taint: the whole class inside everything a person types (task ids, a block reason, proof of
  // work, a subtask name), then every page: each copy of the marker reaches it with all five escaped
  const M = `QX&<>"'XQ`;
  const s = await serving();
  try {
    const wp = new WritePath(s.store, s.registry);
    const make = (id: string, parent_id: string) => wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: { parent_id } });
    await make(`t${M}`, "table");
    await make(`b${M}`, "table");
    await s.send(`b${M}`, "BLOCK", { reason: `r${M}` });
    await s.send("loading_state", "COMPLETE", { evidenceRef: `e${M}` });
    const log = await s.store.readStream(S);
    const confirm = async (id: string, event: string) => (await s.http("GET", `/confirm?type=node&id=${encodeURIComponent(id)}&event=${encodeURIComponent(event)}`)).body;
    const pages: Record<string, string> = {
      "the rendered page": renderHtml(fold(log, s.registry), S, "h", log),
      "the served page": (await s.http("GET", "/")).body,
      "start's confirm page": await confirm(`t${M}`, "START"),
      "block's confirm page (reasons used before, open tasks)": await confirm(`t${M}`, "BLOCK"),
      "unblock's confirm page": await confirm(`b${M}`, "UNBLOCK"),
      "a task that doesn't exist": await confirm(`g${M}`, "START"),
      "a verb the page doesn't take": await confirm(`t${M}`, `X${M}`),
      "a post on a log that moved, shown again": (await s.form({ token: "t0k3n", type: "node", id: `t${M}`, event: "BLOCK", seen: "1", command: `tira send node t${M} BLOCK reason=r${M}` })).body,
      "a post missing its reason, shown again": (await s.form({ token: "t0k3n", type: "node", id: `t${M}`, event: "BLOCK", command: `tira send node t${M} BLOCK note=n${M}` })).body,
      "a new project refused, shown again": (await s.http("POST", "/projects", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: "t0k3n", name: `n${M}`, repo: `r${M}` }).toString() })).body,
    };
    for (const [name, body] of Object.entries(pages)) {
      const copies = body.match(/QX.{0,60}?XQ/g) ?? [];
      assert.ok(copies.length > 0, `${name}: the marker never reached it`);
      for (const c of copies) assert.doesNotMatch(c.replace(/&#\d+;/g, ""), /[&<>"']/, `${name}: raw ${c}`);
    }
  } finally {
    await s.done();
  }
});

test("after an action, what it changed glows once: the task it moved, or a block's new ticket too; a refusal and a later load glow nothing", async () => {
  const s = await serving();
  try {
    const glowing = (page: string) => [...page.matchAll(/<a class="(?:gn|ghost)[^"]*\bchanged\b[^"]*"[^>]*data-(?:key|idea)="([^"]+)"/g)].map((m) => m[1]);
    const ok = await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "COMPLETE", evidenceRef: "spinner.mp4" });
    const page = (await s.http("GET", String(ok.headers.location))).body;
    assert.deepEqual(glowing(page), ["node:loading_state"]);
    assert.match(page, /<a class="card changed" href="#t\d+"[^>]*><div class="t">loading_<wbr>state<\/div>/);
    assert.deepEqual(glowing((await s.http("GET", "/")).body), []); // once: the next load is quiet
    // a refusal changed nothing
    await s.send("filters", "START");
    const no = await s.form({ token: "t0k3n", type: "node", id: "table", event: "START" });
    assert.deepEqual(glowing((await s.http("GET", String(no.headers.location))).body), []);
    // a block on a new ticket: both
    const block = await s.form({ token: "t0k3n", type: "node", id: "filters", event: "BLOCK", fragment: "1", command: 'tira create node api_keys --parent filters kind=discovered discovered_during=filters\ntira send node filters BLOCK blocker="api_keys" reason="waiting on api_keys"' });
    const go = /data-go="([^"]+)"/.exec(block.body)?.[1] ?? "";
    assert.deepEqual(glowing((await s.http("GET", go)).body).sort(), ["node:api_keys", "node:filters"]);
  } finally {
    await s.done();
  }
  // what an action names: the task, or the subtask it adds; a block's ticket too
  assert.deepEqual(changedBy({ type: "node", id: "a", event: "START", payload: {} }), ["node:a"]);
  assert.deepEqual(changedBy({ type: "node", id: "a", event: "ADD_SUBTASK", payload: {}, child: "b" }), ["node:b"]);
  assert.deepEqual(changedBy({ type: "node", id: "a", event: "BLOCK", payload: {} }, { type: "node", id: "a", event: "ADD_SUBTASK", payload: {}, child: "t" }), ["node:a", "node:t"]);
});

test("the palette opened empty offers what needs you first: next, then in progress, then blocked, then the rest to do; closed work last", () => {
  const t = (id: string, state: string, next = false) => ({ key: `node:${id}`, type: "node", id, state, path: "", drawer: id, next });
  const tasks = [t("old", "done"), t("later", "unstarted"), t("stuck", "blocked"), t("dropped", "cancelled"), t("doing", "in_progress"), t("up", "unstarted", true)];
  assert.deepEqual(rank("", tasks).results.map((x: { id: string }) => x.id), ["up", "doing", "stuck", "later", "old", "dropped"]);
  assert.deepEqual(tasks.map(priority), [0, 1, 2, 0, 3, 4]);
  // a verb with nothing after it keeps the same order among what it allows
  assert.deepEqual(rank("block ", tasks).results.map((x: { id: string }) => x.id), ["up", "doing", "later"]);
  // typing ranks by the match alone
  assert.equal(rank("old", tasks).results[0]?.id, "old");
});

test("the page's script: the palette moves to a task on the Graph, dialogs offer Show on graph, the highlighted match is announced, and motion stops for reduced motion", async () => {
  const app = readFileSync(new URL("../src/serve/app.mjs", import.meta.url), "utf8");
  const graph = readFileSync(new URL("../src/serve/graph.mjs", import.meta.url), "utf8");
  // the palette: on the Graph, picking a task moves there; elsewhere it opens the task's dialog
  assert.match(app, /else if \(!\(graphShown\(\) && graph\.reveal\(task\.key\)\)\) location\.hash = `#\$\{task\.drawer\}`;/);
  assert.match(app, /role="combobox" aria-expanded="true" aria-controls="pal-list"/);
  assert.match(app, /if \(shown\[sel\]\) input\.setAttribute\("aria-activedescendant", `pal-\$\{sel\}`\);\n  else input\.removeAttribute\("aria-activedescendant"\);/);
  // Show on graph: the dialog closes, the board turns to the Graph (remembered), the canvas moves there
  assert.match(app, /closest\("\[data-show-on-graph\]"\)[^]*?location\.hash = "_";[^]*?pick\.checked = true; pick\.dispatchEvent\(new Event\("change"\)\);[^]*?graph\.reveal\(key\)/);
  // folded attention groups you opened stay open across the reload (per tab)
  assert.match(app, /sessionStorage\.setItem\(OPEN_KEY, JSON\.stringify\(open\)\)/);
  // the canvas: reveal opens the folds above, glides there and rings it; nothing glides or tweens for reduced motion
  assert.match(graph, /export const graph = \{\n  reveal: \(key\) => api\?\.reveal\(key\) \?\? false,/);
  assert.match(graph, /function reveal\(key\) \{[^]*?unfoldTo\(n\);[^]*?glideTo\(centreOn\(p, /);
  assert.match(graph, /function glideTo\(v, ms = 420, then\) \{\n    cancelAnimationFrame\(glide\);\n    if \(still\(\) \|\| /);
  assert.match(graph, /if \(!animate \|\| still\(\)\) return paint\(last\.at\);/);
  assert.match(graph, /wrap\.classList\.toggle\("far", isFar\(view\.s\)\);/);
  assert.match(graph, /mini\.className = "minimap";/);
});

test("the mark goes home: the workspace's board live (and from a decision), the top of a rendered file", async () => {
  const s = await serving();
  try {
    assert.match((await s.http("GET", "/")).body, /<nav class="top" aria-label="tira"><a class="brand" href="\/" title="Home: the board" data-home>/);
    assert.match((await s.http("GET", "/confirm?type=node&id=table&event=START")).body, /<nav class="top"><a class="brand" href="\/" title="Home: the board" data-home>[^]*?<a class="how" href="\/">← the page<\/a>/);
    const events = await s.store.readStream(S);
    const file = renderHtml(fold(events, s.registry), S, "h", events);
    assert.match(file, /<nav class="top" aria-label="tira"><a class="brand" href="#" title="Home: the board" data-home><svg[^]*?<\/svg>tira<\/a><div class="tabs">/);
    assert.doesNotMatch(file, /data-workspaces|data-ws-menu|data-profile/); // a rendered file is one project, and no one acts on it
  } finally {
    await s.done();
  }
});

test("workspaces: one server serves every workspace in the store at ?w=; its page, palette, decisions and writes stay in it; the switcher lists them all", async () => {
  const s = await serving();
  const O = "side-project";
  const wp = new WritePath(s.store, s.registry);
  const other = (id: string, parent_id?: string) => wp.submit({ stream: O, kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
  await other("site");
  await other("hero", "site");
  await other("contact", "site");
  await wp.submit({ stream: O, kind: "event", entity: { type: "node", id: "hero" }, event: "BLOCK", actor: "isha", payload: { reason: "waiting on copy" } });
  try {
    // the switcher, live only: the workspace you're in, its list read when it opens
    const home = (await s.http("GET", "/")).body;
    assert.match(home, /<details class="ws projects" data-workspaces open><summary title="Your projects">Projects<svg[^]*?<\/svg><\/summary><div class="ws-menu" data-ws-menu><a class="ws-item" href="\/" aria-current="page" data-stream="tasktree-dash"><span class="pav t\d" aria-hidden="true">T<\/span><span class="ws-t"><b>tasktree-dash<\/b><\/span><\/a><\/div><a class="new-project" href="\/projects\/new" data-new-project><svg[^]*?<\/svg>New project<\/a><\/details>/);
    // the sidebar searches projects by name, and has this project's settings; the header searches
    // this project's tasks (the palette, ⌘K)
    const side = /<nav class="top"[^]*?<\/nav>/.exec(home)?.[0] ?? "";
    assert.match(side, /<label class="proj-search"><svg[^]*?<\/svg><input type="search" placeholder="Search projects" aria-label="Search projects by name" autocomplete="off" spellcheck="false" data-project-search><\/label>/);
    assert.doesNotMatch(side, /data-open-palette/);
    assert.match(side, /<a class="side-link" href="\/integrations" data-project-settings>/);
    assert.match(home, /<button class="find" type="button" data-open-palette><svg[^]*?<\/svg><span>Search tasks in tasktree-dash<\/span><kbd>⌘K<\/kbd><\/button><\/header>/);
    // you: who the page acts as
    assert.match(home, /<details class="ws me" data-profile><summary title="You: isha"><span class="av">I<\/span><span class="ws-name">isha<\/span>/);
    assert.doesNotMatch(home, /[?&]w=/); // the first workspace's links stay as they were
    const list = JSON.parse((await s.http("GET", "/api/workspaces")).body);
    assert.deepEqual(list, [
      { stream: O, href: "/?w=side-project", current: false, tasks: 2, open: 2, attention: 1 },
      { stream: S, href: "/", current: true, tasks: 6, open: 6, attention: 2 },
    ]);
    assert.equal(JSON.parse((await s.http("GET", "/api/workspaces?w=side-project")).body).find((w: { current: boolean }) => w.current).stream, O);
    // its page: its tree, every link back to the server carries it on
    const page = (await s.http("GET", "/?w=side-project")).body;
    assert.match(page, /<main data-stream="side-project"/);
    assert.match(page, /<a class="brand" href="\/\?w=side-project"/);
    assert.match(page, /<a class="act" href="\/confirm\?type=node&#38;id=hero&#38;event=UNBLOCK&#38;w=side-project" data-act="UNBLOCK">/);
    assert.deepEqual(JSON.parse((await s.http("GET", "/api/tasks?w=side-project")).body).map((t: { id: string }) => t.id), ["site", "hero", "contact"]);
    // its decisions: about its tasks, posting back to it
    const decision = (await s.http("GET", "/confirm?type=node&id=hero&event=UNBLOCK&w=side-project")).body;
    assert.match(decision, /<form method="post" action="\/act\?w=side-project"/);
    assert.match(decision, /<a class="how" href="\/\?w=side-project">← the page<\/a>/);
    assert.match((await s.http("GET", "/confirm?type=node&id=hero&event=UNBLOCK")).body, /There is no task hero\./); // not in the first workspace
    // its writes land in it, and the result comes back to it
    const seen = String((await s.store.readStream(O)).at(-1)?.seq);
    const before = (await s.store.readStream(S)).length;
    const done = await s.http("POST", "/act?w=side-project", { headers: { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${s.port}` }, body: new URLSearchParams({ token: "t0k3n", type: "node", id: "hero", event: "UNBLOCK", seen }).toString() });
    assert.equal(done.status, 303);
    assert.match(String(done.headers.location), /^\/\?r=\d+&w=side-project$/);
    assert.equal((await s.store.readStream(O)).at(-1)?.type, "node.unblock");
    assert.equal((await s.store.readStream(S)).length, before);
    assert.match((await s.http("GET", String(done.headers.location))).body, /data-flash>Unblock hero: done/);
    // a workspace the store doesn't hold is a 404 with the way home; a name that can't be one, a 400
    const missing = await s.http("GET", "/?w=nope");
    assert.equal(missing.status, 404);
    assert.match(missing.body, /No project named nope yet[^]*?<a class="how" href="\/integrations\?w=nope" data-start-project>Project settings for nope<\/a>[^]*?<a class="how" href="\/">Back to your board<\/a>/);
    assert.equal((await s.http("GET", `/?w=${encodeURIComponent("a\u0001b")}`)).status, 400);
  } finally {
    await s.done();
  }
  // the pieces
  const u = (q: string) => new URL(`http://h/${q}`);
  assert.deepEqual(workspaceIn(u(""), "main"), { stream: "main", q: "" });
  assert.deepEqual(workspaceIn(u("?w=main"), "main"), { stream: "main", q: "" });
  assert.deepEqual(workspaceIn(u("?w=a%20b"), "main"), { stream: "a b", q: "w=a%20b" });
  assert.equal(workspaceIn(u(`?w=${"x".repeat(201)}`), "main"), undefined);
  assert.equal(workspaceIn(u("?w=a%7Fb"), "main"), undefined);
  assert.equal(withQ("/", ""), "/");
  assert.equal(withQ("/", "w=x"), "/?w=x");
  assert.equal(withQ("/?r=1", "w=x"), "/?r=1&w=x");
  assert.deepEqual(workspaceList(fold([], defaultRegistry()), ["b", "a", "b"], "a", "b").map((w) => [w.stream, w.href, w.current]), [["a", "/", false], ["b", "/?w=b", true]]);
});

test("the page's script keeps the workspace: the palette's index and verbs, and the dialog's post", () => {
  const app = readFileSync(new URL("../src/serve/app.mjs", import.meta.url), "utf8");
  assert.match(app, /const load = \(\) => fetch\(withW\("\/api\/tasks"\)\)/);
  assert.match(app, /if \(verb\) void openConfirm\(withW\(`\/confirm\?/);
  assert.match(app, /await fetch\(form\.getAttribute\("action"\) \?\? "\/act", \{ method: "POST", body \}\)/);
  assert.match(app, /await fetch\(withW\("\/api\/workspaces"\)\)/);
});

test("the Help centre's answers: the one what you typed fits best (a rarer word counts for more; a tie goes to the first), or none", () => {
  const qa = [
    { q: "How do I make tira's GitHub app?", keys: "github app oauth client id device flow setup create" },
    { q: "How do I make the Atlassian app for Jira?", keys: "atlassian jira app oauth scopes console client secret create" },
    { q: "Where are my keys and tokens kept?", keys: "keys tokens secret stored kept saved private safe credentials password" },
    { q: "What does Sync do?", keys: "sync syncing pull request pr issue mirror update proof merge" },
    { q: "Who can sign in?", keys: "sign signin login admin people access invite add user member team" },
    { q: "Why does Jira need localhost?", keys: "localhost callback redirect connect address url port" },
  ];
  assert.equal(answerFor("where is my jira secret stored", qa), 2); // "stored" fits one answer; "jira" and "secret" two each
  assert.equal(answerFor("GitHub app", qa), 0);
  assert.equal(answerFor("jira", qa), 1); // a tie: the first
  assert.equal(answerFor("who's the admin?", qa), 4);
  assert.equal(answerFor("syncing pull requests", qa), 3); // a word's other forms
  assert.equal(answerFor("localhost", qa), 5);
  assert.equal(answerFor("banana", qa), -1);
  assert.equal(answerFor("how do I", qa), -1); // small words alone
  assert.deepEqual(words("Where's my Jira token?"), ["jira", "token"]);
});

test("live: the page asks /api/live where its log is (the last event only), with no pill to say so; after a write the answer moves on, and the page knows where it was", async () => {
  const s = await serving();
  try {
    const page = (await s.http("GET", "/")).body;
    assert.match(page, /<div class="title-acts"><a class="history-btn"[^]*?<\/a><\/div>/); // History alone (no Live pill)
    assert.doesNotMatch(page, /data-live|data-now/);
    const at = Number(/data-last-seq="(\d+)"/.exec(page)?.[1]);
    const before = (JSON.parse((await s.http("GET", "/api/live")).body) as { seq: number }).seq;
    assert.equal(before, at); // nothing new: the page is where the log is, so it doesn't reload
    await s.send("font", "CANCEL");
    const after = (JSON.parse((await s.http("GET", "/api/live")).body) as { seq: number }).seq;
    assert.ok(after > before, `${after} > ${before}`);
    assert.match(readFileSync(new URL("../src/serve/app.mjs", import.meta.url), "utf8"), /fetch\(withW\("\/api\/live"\), \{ cache: "no-store" \}\)[^]*?const at = Number\(seq\);\s*if \(!Number\.isSafeInteger\(at\) \|\| at < 0\) return;\s*latest = at;[^]*?if \(at > seen && at > triedFor\)/);
  } finally {
    await s.done();
  }
});
