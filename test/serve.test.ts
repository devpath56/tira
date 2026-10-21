// `tira serve` (the D1 UI brief): the live page, its confirm pages, its writes, and the
// palette's ranking. Requests go over real HTTP to a server on 127.0.0.1:0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { fold } from "../src/fold/fold.ts";
import { renderHtml } from "../src/render/html.ts";
import { CSP, taskIndex, tiraServer } from "../src/serve/server.ts";
// @ts-expect-error: plain JS shared with the browser (src/serve/rank.mjs)
import { rank, score } from "../src/serve/rank.mjs";

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
    assert.match(page.body, /<a class="act" href="\/confirm\?type=node&amp;id=colors&amp;event=UNBLOCK" data-act="UNBLOCK">Unblock<\/a>/);
    assert.match(page.body, /<a class="act" href="\/confirm\?type=node&amp;id=loading_state&amp;event=COMPLETE" data-act="COMPLETE">Complete<\/a>/);
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
    assert.equal((await s.http("GET", "/rank.mjs")).status, 200);
    // the theme choice, remembered per browser: app.mjs loads it on the page
    assert.match(app.body, /import "\.\/theme\.mjs";/);
    const theme = await s.http("GET", "/theme.mjs");
    assert.equal(theme.status, 200);
    assert.match(theme.body, /localStorage\.setItem\(KEY, r\.dataset\.themeChoice\)/);
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
    assert.deepEqual(tasks.find((t) => t.id === "colors"), { key: "node:colors", type: "node", id: "colors", state: "blocked", path: "dashboard › metrics_card › improve_visual", drawer: "t4" });
    const page = (await s.http("GET", "/")).body;
    for (const t of tasks) assert.ok(page.includes(`<section class="drawer" id="${t.drawer}" aria-label="${t.id}">`), t.id);
  } finally {
    await s.done();
  }
});

test("confirm pages say what will happen before anything is written: the move, the rule, the record, tira's next close, or the refusal", async () => {
  const s = await serving();
  try {
    const before = (await s.store.readStream(S)).length;
    const unblock = await s.http("GET", "/confirm?type=node&id=colors&event=UNBLOCK");
    assert.equal(unblock.status, 409); // loading_state is in progress: one active task at a time
    assert.match(unblock.body, /data-ok="false"/);
    assert.match(unblock.body, /tira would refuse this: gate: one active task: node:loading_state is already active\./);
    assert.match(unblock.body, /Blocked because: waiting on the design-token decision/);
    // the same theme switch as the page, and the script that remembers the choice
    assert.match(unblock.body, /id="th-system" checked[^]*?<main class="packet"[^]*?data-theme-switch[^]*?<script type="module" src="\/theme\.mjs"><\/script><\/body>/);
    const complete = await s.http("GET", "/confirm?type=node&id=loading_state&event=COMPLETE");
    assert.equal(complete.status, 200);
    assert.match(complete.body, /<li>loading_state: in progress → done<\/li>/);
    assert.match(complete.body, /<li>The rule: event\.evidenceRef is a non-empty string\.<\/li>/);
    assert.match(complete.body, /<li>Recorded as isha, in tasktree-dash\.<\/li>/);
    assert.match(complete.body, /<input type="hidden" name="seen" value="11">/);
    assert.match(complete.body, /tira&#39;s check: allowed\./);
    assert.match(complete.body, /<input type="hidden" name="token" value="t0k3n">/);
    assert.match(complete.body, /<input name="evidenceRef" aria-label="Evidence \(a file, link or note anyone can re-check\)" required/);
    // starting fetch_metrics would leave nothing for tira to close yet; after the dashboard's
    // visual branch drains, moving on names the parent tira will close
    await s.send("loading_state", "COMPLETE", { evidenceRef: "spinner.mp4" });
    await s.send("font", "CANCEL");
    await s.send("colors", "UNBLOCK");
    await s.send("colors", "COMPLETE", { evidenceRef: "palette.png" });
    // the block form asks for what the gate checks: a reason with text, not only spaces (2026-10-20)
    const block = await s.http("GET", "/confirm?type=node&id=table&event=BLOCK");
    assert.match(block.body, /<input name="reason" aria-label="Why is it blocked\?" required pattern="\.\*\\S\.\*" title="Write the reason \(not only spaces\)" autocomplete="off" autofocus>/);
    assert.match(block.body, /The rule: event\.reason has text \(not only spaces\)\./);
    const start = await s.http("GET", "/confirm?type=node&id=table&event=START");
    assert.match(start.body, /<li>tira will first close improve_visual \(every child is done or cancelled\), citing this move\.<\/li>/);
    assert.match(start.body, /<li>Recorded as isha, in tasktree-dash, after tira&#39;s closes\.<\/li>/);
    // unknown verbs and tasks are explained, not offered
    assert.match((await s.http("GET", "/confirm?type=node&id=table&event=REOPEN")).body, /tira doesn&#39;t take REOPEN from the page\./);
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
    assert.equal((await s.form({ token: "t0k3n", type: "node", id: "loading_state", event: "REOPEN", reason: "x" })).status, 400);
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
    const no = await s.form({ token: "t0k3n", type: "node", id: "table", event: "BLOCK", reason: "" });
    const noPage = await s.http("GET", String(no.headers.location));
    assert.match(noPage.body, /<div class="flash no" role="status" data-flash>Block table: refused \(guard-failed: /);
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
    assert.match(page.body, /tira will first close p, then table \(/); // closing p drains table: the whole chain is named
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
    const t0 = performance.now();
    for (const q of ["t", "ta", "task_9", "api", "d"]) rank(q, many);
    assert.ok(performance.now() - t0 < 100, `${(performance.now() - t0).toFixed(1)} ms for 5 queries`);
  } finally {
    await s.done();
  }
});
