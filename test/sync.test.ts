// Workspace links (src/tables/links.ts, src/sync/): a workspace linked to a git repo and a Jira
// project, synced on demand. tira leads, Jira mirrors; a person's move in Jira comes back as a
// request tira's rules may refuse. Run against the stand-ins in sync-fakes.ts; the real Jira
// client is checked against a local HTTP server, and the GitHub one with a recorded gh.
import "./hermetic.ts";
import { sqliteFile } from "./test-stores.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { Dispatcher } from "../src/write/dispatcher.ts";
import { fold } from "../src/fold/fold.ts";
import { linksOf, reportLines, sync, tasksNamed, workspaceOf } from "../src/sync/sync.ts";
import { JiraCloud } from "../src/sync/jira.ts";
import { GhCli } from "../src/sync/github.ts";
import { access, appKeys, atlassianAuth, githubAuth, jiraLogin, saveJiraLogin, saveSession, sessionLogin } from "../src/sync/credentials.ts";
import type { GitHubAuthApi } from "../src/auth/github.ts";
import type { AtlassianAuthApi } from "../src/auth/atlassian.ts";
import { carryQ, tiraServer } from "../src/serve/server.ts";
import { LINK_GUARDS } from "../src/tables/links.ts";
import { tint } from "../src/serve/layout.mjs";
import { renderHtml } from "../src/render/html.ts";
import { FakeGitHub, FakeJira } from "./sync-fakes.ts";

const S = "tasktree-dash";

async function world() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const d = new Dispatcher(store, registry);
  const born = (id: string, parent_id?: string) => d.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}, actor = "isha") => d.submit({ stream: S, kind: "event", entity: { type: "node", id }, event, actor, payload });
  const link = (payload: Record<string, unknown>, version = 1, actor = "isha") => d.submit({ stream: S, kind: "create", entity: { type: "workspace", id: "workspace", version }, actor, payload });
  await born("dashboard");
  await born("table", "dashboard");
  await born("filters", "dashboard");
  const jira = new FakeJira();
  const github = new FakeGitHub();
  const state = async () => fold(await store.readStream(S), registry);
  const run = () => sync({ store, registry, stream: S, jira, github });
  return { store, registry, d, born, send, link, jira, github, state, run };
}

const linked = { repo: "acme/app", jira_site: "https://acme.atlassian.net", jira_project: "DOG" };

test("a workspace is linked by a person, to a repo and a Jira project (its site with it); each change is a new version", async () => {
  const w = await world();
  assert.deepEqual((await w.run()).problems, ["this workspace isn't linked yet: tira link --repo <owner/name> --jira-site <https://…> --jira <KEY>"]);
  // malformed or by the wrong writer: refused, and logged
  for (const [payload, actor] of [
    [{ jira_project: "DOG" }, "isha"], // a project needs its site
    [{ repo: "not a repo" }, "isha"],
    [{ jira_site: "http://insecure.example" }, "isha"],
    [{}, "isha"],
    [linked, "sync"], // the sync never links
  ] as const) {
    const r = await w.link(payload, 1, actor);
    assert.notEqual(r.result.status, "appended", JSON.stringify(payload));
  }
  assert.equal((await w.link(linked)).result.status, "appended");
  assert.equal((await w.link({ repo: "acme/web" }, 2)).result.status, "appended");
  const ws = workspaceOf(await w.state(), S);
  assert.deepEqual(ws, { version: 2, repo: "acme/web", by: "isha" });
});

test("out to Jira: every task gets an issue, once; its status then follows the task, with blocked and cancelled as labels", async () => {
  const w = await world();
  await w.link(linked);
  const first = await w.run();
  assert.deepEqual(first.created.map((c) => `${c.task} ${c.key}`), ["dashboard DOG-1", "table DOG-2", "filters DOG-3"]);
  assert.deepEqual(first.problems, []);
  assert.deepEqual(first.requests, []);
  const again = await w.run();
  assert.deepEqual([again.created, again.pushed, again.requests], [[], [], []]); // nothing to do
  assert.deepEqual(reportLines(again), ["synced with GitHub acme/app and Jira DOG", "nothing to change"]);
  await w.send("table", "START");
  await w.send("filters", "CANCEL");
  const moved = await w.run();
  assert.deepEqual(moved.pushed.map((p) => `${p.key} ${p.to}`), ["DOG-2 In Progress", "DOG-3 Done"]);
  assert.deepEqual(w.jira.issuesByKey.get("DOG-3")?.labels, ["tira", "cancelled"]);
  await w.send("table", "BLOCK", { reason: "waiting on design" });
  await w.run();
  assert.equal(w.jira.issuesByKey.get("DOG-2")?.category, "indeterminate"); // blocked stays In Progress
  assert.deepEqual(w.jira.issuesByKey.get("DOG-2")?.labels, ["tira", "blocked"]);
  await w.send("table", "UNBLOCK");
  await w.run();
  assert.deepEqual(w.jira.issuesByKey.get("DOG-2")?.labels, ["tira"]);
  // what tira last set is on record, so the next sync knows a person's move from its own
  const l = linksOf(await w.state(), S);
  assert.deepEqual(l.get("table")?.jira, { key: "DOG-2", category: "indeterminate", status: "In Progress", tira: "indeterminate" });
  assert.deepEqual((await w.state()).anomalies, []);
});

test("in from GitHub: a pull request naming a task is linked to it and follows it to merged; the names it counts", async () => {
  const w = await world();
  await w.link(linked);
  await w.run(); // DOG-1..3
  w.github.add({ number: 7, title: "Pagination for the table", body: "tira: table", state: "open" });
  w.github.add({ number: 8, title: "Filter chips", branch: "isha/filters", state: "open" });
  w.github.add({ number: 9, title: "DOG-1: dashboard layout", state: "open" });
  w.github.add({ number: 10, title: "unrelated", body: "tira: nowhere; a tablet fix", commits: ["tidy"] });
  w.github.add({ number: 11, title: "x", commits: ["tira: filters"] });
  w.github.add({ number: 12, title: "polish the table header", body: "for the filters too" }); // a mention, not a name
  const first = await w.run();
  assert.deepEqual(first.prs.map((p) => `${p.pr} ${p.change} ${p.task}`), ["acme/app#7 linked table", "acme/app#8 linked filters", "acme/app#9 linked dashboard", "acme/app#11 linked filters"]);
  assert.deepEqual((await w.run()).prs, []); // nothing new
  w.github.add({ number: 7, title: "Pagination for the table", body: "tira: table", state: "closed", mergedAt: "2026-10-21T12:00:00Z" });
  w.github.add({ number: 8, title: "Filter chips", branch: "isha/filters", state: "closed" });
  const later = await w.run();
  assert.deepEqual(later.prs.map((p) => `${p.pr} ${p.change}`), ["acme/app#7 merged", "acme/app#8 closed"]);
  const prs = linksOf(await w.state(), S).get("table")?.prs;
  assert.deepEqual(prs, [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", title: "Pagination for the table", state: "merged", mergedAt: "2026-10-21T12:00:00Z" }]);
  assert.deepEqual(tasksNamed({ number: 1, title: "tira: table.", body: "", branch: "table/x", url: "", state: "open", commits: [] }, new Set(["table"]), new Map()), ["table"]);
});

test("in from Jira: issues people made there become tasks, in Jira's shape and where they are in Jira, once", async () => {
  const w = await world();
  await w.link(linked);
  const epic = w.jira.made("Checkout", "indeterminate"); // DOG-1, by Devansh
  const pay = w.jira.made("Pay by card", "done", { parent: epic }); // DOG-2
  w.jira.made("Card form", "done", { parent: pay }); // DOG-3
  w.jira.made("table", "new", { by: "Ann" }); // DOG-4: a name tira already has
  w.jira.made("  Fix\nlogin  ", "indeterminate"); // DOG-5
  w.jira.made("Search", "indeterminate"); // DOG-6: a second one in progress
  // one of tira's own, from another workspace on the same project: left alone
  w.jira.issuesByKey.set("DOG-99", { key: "DOG-99", summary: "elsewhere", status: "To Do", category: "new", labels: ["tira"] });
  const rep = await w.run();
  assert.deepEqual(rep.problems, []);
  // done ones children first, so each parent's work is closed before it is. Where tira can't
  // follow Jira, it says why: Checkout's issues are all done, so tira closed it when work moved
  // on; and tira keeps one task in progress at a time
  assert.deepEqual(rep.imported.map((m) => `${m.key} ${m.task}: ${m.to}`), [
    "DOG-3 Card form: Done", "DOG-2 Pay by card: Done", "DOG-5 Fix login: In Progress",
    "DOG-6 Search: To Do (In Progress in Jira: tira keeps one task in progress at a time)",
    "DOG-1 Checkout: Done (tira closed it: all its work is done)", "DOG-4 table (DOG-4): To Do",
  ]);
  assert.match(reportLines(rep).join("\n"), /DOG-3 brought in as Card form \(Done\)/);
  const st = await w.state();
  const task = (id: string) => st.entities.find((e) => e.stream === S && e.type === "node" && e.id === id);
  assert.equal(task("Pay by card")?.tree?.parent, "node:Checkout");
  assert.equal(task("Card form")?.tree?.parent, "node:Pay by card");
  assert.equal(task("Checkout")?.tree?.parent, undefined);
  assert.deepEqual(["Checkout", "Pay by card", "Card form", "table (DOG-4)", "Fix login"].map((t) => task(t)?.regions.lifecycle), ["done", "done", "done", "unstarted", "in_progress"]);
  // written as the people who made them in Jira; done with the issue's own link as the proof
  const events = await w.store.readStream(S);
  assert.equal(events.find((e) => e.type === "node.born" && (e.data as { entity: { id: string } }).entity.id === "table (DOG-4)")?.metadata.actor, "jira:Ann");
  const done = events.find((e) => e.type === "node.complete" && (e.data as { entity: { id: string } }).entity.id === "Card form");
  assert.equal((done?.data as { payload: { evidenceRef: string } }).payload.evidenceRef, "https://acme.atlassian.net/browse/DOG-3");
  assert.equal(done?.metadata.actor, "jira:Devansh");
  // each is linked and labelled, and nothing in Jira is moved by bringing it in, even where tira
  // differs; tira's own tasks still get their issues
  assert.deepEqual(["DOG-1", "DOG-2", "DOG-3", "DOG-4", "DOG-5", "DOG-6"].map((k) => w.jira.issuesByKey.get(k)?.labels.includes("tira")), [true, true, true, true, true, true]);
  assert.deepEqual(rep.pushed, []);
  assert.deepEqual(["DOG-1", "DOG-6"].map((k) => w.jira.issuesByKey.get(k)?.category), ["indeterminate", "indeterminate"]);
  assert.deepEqual(rep.created.map((c) => `${c.task} ${c.key}`), ["dashboard DOG-7", "table DOG-8", "filters DOG-9"]);
  assert.equal(task("elsewhere"), undefined);
  assert.equal(linksOf(st, S).get("Checkout")?.jira?.key, "DOG-1");
  // once: the next sync brings nothing in again, and moves nothing (both sides are on record)
  const again = await w.run();
  assert.deepEqual([again.imported, again.created, again.requests, again.pushed, again.problems], [[], [], [], [], []]);
  // a person's later move on one comes back like any other: refused and put back while another
  // task is in progress; taken once it's done
  w.jira.person("DOG-4", "indeterminate", "Ann");
  const refused = await w.run();
  assert.deepEqual(refused.requests.map((q) => `${q.key} ${q.who}: ${q.result}`), ["DOG-4 Ann: refused (gate: one active task: node:Fix login is already active): put back"]);
  assert.equal(w.jira.issuesByKey.get("DOG-4")?.category, "new");
  await w.send("Fix login", "COMPLETE", { evidenceRef: "https://github.com/acme/app/pull/1" });
  w.jira.person("DOG-4", "indeterminate", "Ann");
  const taken = await w.run();
  assert.deepEqual(taken.requests.map((q) => `${q.key} ${q.who}: ${q.result}`), ["DOG-4 Ann: start table (DOG-4)"]);
  assert.deepEqual(taken.pushed.map((p) => p.key), ["DOG-5"]); // Fix login, done in tira: Jira follows
  assert.deepEqual((await w.state()).anomalies, []);
});

test("in from Jira: a person's move comes back as a request from them, and tira's rules decide; a refused one is put back", async () => {
  const w = await world();
  await w.link(linked);
  await w.run();
  // moved to In Progress: tira starts the task, as the person who moved it
  w.jira.person("DOG-2", "indeterminate", "Isha");
  const started = await w.run();
  assert.deepEqual(started.requests, [{ key: "DOG-2", task: "table", who: "Isha", to: "In Progress", result: "start table" }]);
  let r = await w.state();
  assert.equal(r.entities.find((e) => e.key === "node:table")?.regions.lifecycle, "in_progress");
  assert.equal(r.entities.find((e) => e.key === "node:table")?.lastActor, "jira:Isha");
  assert.deepEqual(started.pushed, []); // Jira already shows it
  // moved to Done with no proof: refused, and Jira is put back to where tira is
  w.jira.person("DOG-2", "done", "Devansh");
  const refused = await w.run();
  assert.equal(refused.requests[0]?.result, "refused (guard-failed: node-lifecycle: in_progress + COMPLETE needs hasEvidenceRef): put back");
  assert.deepEqual(refused.pushed.map((p) => `${p.key} ${p.to}`), ["DOG-2 In Progress"]);
  assert.equal((await w.state()).rejections.at(-1)?.intent.actor, "jira:Devansh"); // the refusal is in the log
  assert.deepEqual((await w.run()).requests, []); // once put back, nothing more to ask
  // with a merged pull request, Done completes it, the PR as its proof
  w.github.add({ number: 7, title: "tira: table", state: "closed", mergedAt: "2026-10-21T12:00:00Z" });
  await w.run();
  w.jira.person("DOG-2", "done", "Devansh");
  const done = await w.run();
  assert.equal(done.requests[0]?.result, "complete table");
  r = await w.state();
  const complete = (await w.store.readStream(S)).filter((e) => e.type === "node.complete").at(-1);
  assert.deepEqual(complete?.data.payload, { evidenceRef: "https://github.com/acme/app/pull/7", note: "from Jira DOG-2" });
  // moved back to To Do: tira has no such move; Jira is put back
  w.jira.person("DOG-3", "indeterminate");
  await w.run();
  w.jira.person("DOG-3", "new");
  const back = await w.run();
  assert.equal(back.requests[0]?.result, "tira has no move from in progress to To Do: put back");
  assert.equal(w.jira.issuesByKey.get("DOG-3")?.category, "indeterminate");
  assert.deepEqual((await w.state()).anomalies, []);
});

test("only the sync writes Jira and PR links; its name is reserved", async () => {
  const w = await world();
  const asPerson = await w.d.submit({ stream: S, kind: "create", entity: { type: "jira-issue", id: "table" }, actor: "isha", payload: { task: "table", key: "DOG-9" } });
  assert.equal(asPerson.result.status, "rejected");
  const asSync = await w.d.submit({ stream: S, kind: "create", entity: { type: "pr", id: "acme/app#1/table" }, actor: "sync", payload: { task: "table", repo: "acme/app", number: 1, url: "https://github.com/acme/app/pull/1" } });
  assert.deepEqual(asSync.result.status === "rejected" ? asSync.result.code : asSync.result.status, "reserved-actor");
  // the sync records what GitHub and Jira say; it never links the workspace itself
  const syncLinks = await w.d.writePath.submitAsSync({ stream: S, kind: "create", entity: { type: "workspace", id: "workspace", version: 1 }, payload: linked });
  assert.equal(syncLinks.status === "rejected" ? syncLinks.code : syncLinks.status, "guard-failed");
  // a link to a task that doesn't exist is refused even from the sync
  const ghost = await w.d.writePath.submitAsSync({ stream: S, kind: "create", entity: { type: "jira-issue", id: "nope" }, payload: { task: "nope", key: "DOG-9" } });
  assert.equal(ghost.status === "rejected" ? ghost.code : ghost.status, "unknown-ref");
});

test("a failing Jira or GitHub is reported, and the rest of the sync carries on", async () => {
  const w = await world();
  await w.link(linked);
  w.github.fail = "gh: not signed in";
  const rep = await w.run();
  assert.deepEqual(rep.problems, ["GitHub: gh: not signed in"]);
  assert.equal(rep.created.length, 3);
  w.jira.fail = "Jira GET /rest/api/3/search/jql: 401";
  w.github.fail = undefined;
  assert.deepEqual((await w.run()).problems, ["reading Jira DOG: Jira GET /rest/api/3/search/jql: 401"]);
});

test("a Jira login is kept in a private file, never in the log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tira-home-"));
  try {
    const env = { TIRA_HOME: dir };
    assert.equal(jiraLogin("https://acme.atlassian.net", env), undefined);
    saveJiraLogin("https://acme.atlassian.net", { email: "isha@example.com", token: "tok-123" }, env);
    assert.deepEqual(jiraLogin("https://acme.atlassian.net", env), { email: "isha@example.com", token: "tok-123" });
    assert.equal(statSync(join(dir, "credentials.json")).mode & 0o777, 0o600);
    assert.match(readFileSync(join(dir, "credentials.json"), "utf8"), /tok-123/);
    // and the sync's writes never carry it
    const w = await world();
    await w.link(linked);
    await w.run();
    assert.doesNotMatch(JSON.stringify(await w.store.readAll()), /tok-123|isha@example\.com/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real Jira client: Basic auth, the v3 calls, a transition chosen by status category; an error names the call, never the login", async () => {
  const seen: { method: string; url: string; auth: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization ?? "", body });
      const send = (status: number, json?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(json === undefined ? "" : JSON.stringify(json)); };
      if (req.url === "/rest/api/3/myself") return send(200, { displayName: "Isha" });
      if (req.url === "/rest/api/3/issue" && req.method === "POST") return send(201, { id: "1", key: "DOG-1" });
      if (req.url?.startsWith("/rest/api/3/search/jql")) {
        return send(200, { isLast: true, issues: [{ key: "DOG-1", fields: { summary: "table", status: { name: "In Review", statusCategory: { key: "indeterminate" } }, labels: ["tira"] },
          changelog: { histories: [{ id: "5", created: "2026-10-21T09:00:00.000Z", author: { displayName: "Ann" }, items: [{ field: "status" }] }, { id: "6", created: "2026-10-21T10:00:00.000Z", author: { displayName: "Devansh" }, items: [{ field: "status" }] }, { id: "7", created: "2026-10-21T11:00:00.000Z", author: { displayName: "Bot" }, items: [{ field: "summary" }] }] } }] });
      }
      if (req.url === "/rest/api/3/issue/DOG-1/transitions" && req.method === "GET") {
        return send(200, { transitions: [{ id: "11", to: { name: "To Do", statusCategory: { key: "new" } } }, { id: "31", to: { name: "Done", statusCategory: { key: "done" } } }] });
      }
      if (req.url === "/rest/api/3/issue/DOG-1/transitions" && req.method === "POST") return send(204);
      if (req.url === "/rest/api/3/issue/DOG-1" && req.method === "PUT") return send(204);
      send(401, { errorMessages: ["nope"] });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const j = new JiraCloud(site, "isha@example.com", "tok-123");
    assert.deepEqual(await j.myself(), { name: "Isha" });
    assert.deepEqual(await j.createIssue("DOG", "table", "tira task table"), { key: "DOG-1" });
    const [issue] = await j.issues("DOG");
    assert.deepEqual(issue, { key: "DOG-1", summary: "table", status: "In Review", category: "indeterminate", labels: ["tira"], movedBy: { name: "Devansh", at: "2026-10-21T10:00:00.000Z", id: "6" } });
    assert.equal(await j.moveTo("DOG-1", "done"), "Done");
    await j.setLabels("DOG-1", ["blocked"], ["cancelled"]);
    assert.ok(seen.every((s) => s.auth === `Basic ${Buffer.from("isha@example.com:tok-123").toString("base64")}`));
    assert.deepEqual(JSON.parse(seen.find((s) => s.method === "POST" && s.url.endsWith("/transitions"))?.body ?? "{}"), { transition: { id: "31" } });
    assert.deepEqual(JSON.parse(seen.find((s) => s.method === "PUT")?.body ?? "{}"), { update: { labels: [{ add: "blocked" }, { remove: "cancelled" }] } });
    const made = JSON.parse(seen.find((s) => s.url === "/rest/api/3/issue")?.body ?? "{}");
    assert.deepEqual([made.fields.project, made.fields.issuetype, made.fields.labels], [{ key: "DOG" }, { name: "Task" }, ["tira"]]);
    assert.match(decodeURIComponent(seen.find((s) => s.url.startsWith("/rest/api/3/search/jql"))?.url ?? ""), /project = "DOG" AND labels = "tira"/);
    await assert.rejects(j.moveTo("DOG-1", "indeterminate"), /no transition to a "indeterminate" status/);
    const bad = await new JiraCloud(site, "isha@example.com", "tok-123").moveTo("DOG-9", "done").catch((e: Error) => e.message);
    assert.match(String(bad), /^Jira GET \/rest\/api\/3\/issue\/DOG-9\/transitions: 401/);
    assert.doesNotMatch(String(bad), /tok-123|isha@example/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("the GitHub client reads pull requests and their commit messages through gh", async () => {
  const asked: string[][] = [];
  const gh = new GhCli(async (args) => {
    asked.push(args);
    if (args[1]?.endsWith("/commits?per_page=100")) return JSON.stringify([{ commit: { message: "tira: table" } }]);
    return JSON.stringify([{ number: 7, title: "t", body: null, html_url: "https://github.com/acme/app/pull/7", state: "closed", merged_at: "2026-10-21T12:00:00Z", head: { ref: "isha/table" } }]);
  });
  assert.deepEqual(await gh.pulls("acme/app"), [{ number: 7, title: "t", body: "", branch: "isha/table", url: "https://github.com/acme/app/pull/7", state: "closed", mergedAt: "2026-10-21T12:00:00Z", commits: ["tira: table"] }]);
  assert.deepEqual(asked.map((a) => a[1]), ["repos/acme/app/pulls?state=all&sort=updated&direction=desc&per_page=50", "repos/acme/app/pulls/7/commits?per_page=100"]);
});

// ---------- on the page ----------

// GitHub's device sign-in and Atlassian's round trip, as stand-ins
class FakeGitHubAuth implements GitHubAuthApi {
  polls = 0;
  approveAfter = 1; // polls that come back "not yet" first
  login = "isha-gh"; // who GitHub says signed in
  async start() {
    return { deviceCode: "dev-123", userCode: "ABCD-1234", verifyAt: "https://github.com/login/device", interval: 5, expiresIn: 900 };
  }
  async poll(_clientId: string, deviceCode: string) {
    if (deviceCode !== "dev-123") return { failed: "GitHub didn't know that code: start again" };
    return ++this.polls <= this.approveAfter ? { wait: 0 } : { token: "gho-token" };
  }
  async user(token: string) {
    if (token !== "gho-token") throw new Error("bad token");
    return this.login === "isha-gh" ? { login: "isha-gh", name: "Isha" } : { login: this.login };
  }
  async repos() {
    return ["acme/app", "acme/web"];
  }
}
class FakeAtlassian implements AtlassianAuthApi {
  states: string[] = [];
  private readonly jiraClient: FakeJira;
  constructor(jiraClient: FakeJira) {
    this.jiraClient = jiraClient;
  }
  authorizeUrl(clientId: string, redirectUri: string, state: string) {
    this.states.push(state);
    return `https://auth.example/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  }
  async exchange(_keys: { clientId: string; secret: string }, code: string) {
    if (code !== "good-code") throw new Error("Atlassian sign-in: 400");
    return { access: "at-token", refresh: "rt-token", expiresAt: Date.now() + 3_600_000 };
  }
  async sites() {
    return [{ id: "cloud-1", url: "https://acme.atlassian.net", name: "acme" }];
  }
  jira() {
    return this.jiraClient;
  }
}

// tira serve with stand-in GitHub and Atlassian, as `actor` (null: none, everyone signs in)
async function serving(home: string, actor: string | null = "isha") {
  const w = await world();
  const env = { TIRA_HOME: home };
  const githubAuthApi = new FakeGitHubAuth();
  const atlassian = new FakeAtlassian(w.jira);
  const server = tiraServer({ store: w.store, registry: w.registry, stream: S, ...(actor !== null ? { actor } : {}), token: "k", links: { github: w.github, githubAuth: githubAuthApi, atlassian, env } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  let cookie = "";
  const http = (method: string, path: string, body?: string, host = `localhost:${port}`) => new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const post = (path: string, fields: Record<string, string>) => http("POST", path, new URLSearchParams({ token: "k", ...fields }).toString());
  // the result a write left, on the page it sends you to (following the page's own redirects)
  const flash = async (r: { headers: Record<string, string | string[] | undefined>; body: string }) => {
    let to = String(r.headers.location ?? /data-go="([^"]+)"/.exec(r.body)?.[1] ?? "/");
    let got = await http("GET", to);
    for (let hops = 0; got.status === 303 && hops < 3; hops++) got = await http("GET", (to = String(got.headers.location)));
    return (got.body.match(/data-flash>([^<]+)</)?.[1] ?? "").replaceAll("&#39;", "'");
  };
  // sign in with the stand-in GitHub, approved at once (GitHub sign-in must be set up)
  const signInWithGitHub = async () => {
    githubAuthApi.approveAfter = 0;
    const id = /name="id" value="([0-9a-f]+)"/.exec((await post("/signin/start", {})).body)?.[1] ?? "";
    const done = await post("/signin/poll", { id, fragment: "1" });
    cookie = String(done.headers["set-cookie"]).split(";")[0] ?? "";
    return done;
  };
  return {
    ...w, env, port, http, post, flash, githubAuthApi, atlassian, signInWithGitHub,
    signIn: (c: string) => { cookie = c; }, signOut: () => { cookie = ""; }, cookie: () => cookie,
    done: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("before setup: the board points to Project settings, and Profile settings opens on Setup; changes are recorded as the name tira serve was given", async () => {
  const home = mkdtempSync(join(tmpdir(), "tira-home-"));
  const s = await serving(home);
  try {
    const board = (await s.http("GET", "/")).body;
    // the sidebar's profile: your name on the button, and the menu straight to your Profile settings;
    // this project's settings are a link of their own
    assert.match(board, /<div class="ws-menu me-menu" data-me-menu><a class="ws-item" href="\/settings" data-integrations-nav>Profile settings<small>/);
    assert.match(board, /<a class="side-link" href="\/integrations" data-project-settings><svg[^]*?<\/svg>Project settings<\/a>/);
    assert.doesNotMatch(board, /Acting as|class="ws-head"/);
    assert.match(board, /<\/h1><div class="proj-links" data-workspace aria-label="Linked to"><a class="act primary" href="\/integrations" data-integrations><svg[^]*?<\/svg><svg[^]*?<\/svg>Connect GitHub and Jira<\/a><\/div><div class="title-acts">/); // on the name's line, only while nothing is linked
    assert.doesNotMatch(board, /data-sign-in|data-user[ >]|data-signout/); // no GitHub sign-in set up: nothing to sign in with
    // Profile settings: yours, in every project (no project on it)
    const page = (await s.http("GET", "/settings")).body;
    assert.match(page, /<h1>Profile settings<\/h1><p>Yours, in every project on this tira\.<\/p>/);
    assert.doesNotMatch(page, /class="set-proj"|data-int="(?:github|jira|sync|delete)"/);
    assert.match(page, /<span class="grp-k">Working as<\/span><span class="grp-v">isha<\/span>/);
    assert.match(page, /GitHub sign-in isn't set up\. Add it under Setup\./);
    assert.match(page, /<details class="grp" data-int="setup" id="setup" open>/);
    assert.match(page, /Callback <code>http:\/\/localhost:\d+\/integrations\/jira\/callback<\/code>/);
    // Project settings: the project's own (its GitHub, Jira, Sync and Delete), none of yours
    const project = (await s.http("GET", "/integrations")).body;
    assert.match(project, /<h1>Project settings<\/h1><p><span class="pav t\d" aria-hidden="true">T<\/span><b>tasktree-dash<\/b><\/p>/);
    assert.deepEqual([...project.matchAll(/<a class="set-link" href="#(\w+)">/g)].map((m) => m[1]), ["general", "github", "jira", "sync", "delete"]);
    assert.doesNotMatch(project, /data-int="(?:account|accounts|appearance|people|setup)"/);
    // without sign-in set up, tira serve's own name still acts
    assert.equal((await s.post("/integrations/link", { what: "repo", repo: "acme/app" })).status, 303);
    assert.deepEqual(workspaceOf(await s.state(), S), { version: 1, repo: "acme/app", by: "isha" });
  } finally {
    await s.done();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Setup keeps tira's app keys privately; the Atlassian secret is never shown again", async () => {
  const home = mkdtempSync(join(tmpdir(), "tira-home-"));
  const s = await serving(home);
  try {
    assert.equal(await s.flash(await s.post("/integrations/setup", { github_client_id: "Iv1.gh", atlassian_client_id: "at-id", atlassian_secret: "" })), "Add the Atlassian app's secret too.");
    assert.equal(await s.flash(await s.post("/integrations/setup", { github_client_id: "Iv1.gh", atlassian_client_id: "at-id", atlassian_secret: "SECRET-xyz" })), "Saved.");
    assert.deepEqual(appKeys(s.env), { github: { clientId: "Iv1.gh" }, atlassian: { clientId: "at-id", secret: "SECRET-xyz" } });
    await s.signInWithGitHub();
    const page = (await s.http("GET", "/settings")).body;
    assert.doesNotMatch(page, /SECRET-xyz/);
    assert.match(page, /<input type="password" name="atlassian_secret" value="" autocomplete="off" placeholder="Saved">/);
    assert.match(page, /<details class="grp" data-int="setup" id="setup">/); // both set: folded away
    assert.equal(statSync(join(home, "credentials.json")).mode & 0o777, 0o600);
    // once sign-in is on, only someone signed in may change them
    s.signOut();
    assert.equal(await s.flash(await s.post("/integrations/setup", { github_client_id: "Iv1.other" })), "Sign in with GitHub to change tira's apps.");
    assert.equal(appKeys(s.env).github?.clientId, "Iv1.gh");
  } finally {
    await s.done();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Sign in with GitHub: a code to approve on github.com; until then nothing is signed in, after it tira acts as your GitHub login", async () => {
  const home = mkdtempSync(join(tmpdir(), "tira-home-"));
  const s = await serving(home);
  try {
    await s.post("/integrations/setup", { github_client_id: "Iv1.gh" });
    // signed out with sign-in on: the landing, and nothing written
    const signedOut = await s.http("GET", "/");
    assert.equal(signedOut.status, 303);
    assert.equal(signedOut.headers.location, "/welcome");
    assert.equal((await s.http("GET", "/integrations")).headers.location, "/welcome");
    assert.equal((await s.http("GET", "/settings")).headers.location, "/welcome");
    const decision = (await s.http("GET", "/confirm?type=node&id=table&event=START&fragment=1")).body;
    assert.match(decision, /Sign in with GitHub first \(Integrations\)/);
    const seen = String((await s.store.readStream(S)).at(-1)?.seq);
    assert.equal((await s.post("/act", { type: "node", id: "table", event: "START", seen })).status, 401);
    assert.equal(await s.flash(await s.post("/integrations/link", { what: "repo", repo: "acme/app" })), "Sign in with GitHub first.");
    assert.equal(workspaceOf(await s.state(), S), undefined);
    assert.match((await s.http("GET", "/welcome")).body, /data-signin-start><svg[^]*?<\/svg><span>Continue with GitHub<\/span><\/button>/);
    // the code, and the page that waits for it
    const start = await s.post("/signin/start", {});
    assert.match(start.body, /<code data-user-code>ABCD-1234<\/code>/);
    assert.match(start.body, /<a class="land-btn" href="https:\/\/github\.com\/login\/device" target="_blank" rel="noopener noreferrer" data-open-github>/);
    assert.match(start.body, /<script type="module" src="\/signin\.mjs"><\/script>/);
    const id = /name="id" value="([0-9a-f]+)"/.exec(start.body)?.[1] ?? "";
    const waiting = await s.post("/signin/poll", { id, fragment: "1" });
    assert.equal(waiting.status, 202);
    assert.equal(waiting.headers["set-cookie"], undefined); // not approved yet: no one is signed in
    const done = await s.post("/signin/poll", { id, fragment: "1" });
    const setCookie = String(done.headers["set-cookie"]);
    assert.match(setCookie, /^tira_session=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    assert.match(done.body, /^<div data-go="\/connect\?r=\d+"><\/div>$/); // no repo yet: connect one next
    const session = setCookie.split(";")[0] ?? "";
    s.signIn(session);
    assert.equal(await s.flash(done), "Signed in as isha-gh: you're this tira's admin. Add the people who may sign in in Profile settings.");
    // the store keeps a hash of the session, and the GitHub token, never on a page
    const file = readFileSync(join(home, "credentials.json"), "utf8");
    assert.doesNotMatch(file, new RegExp(session.split("=")[1] ?? "x"));
    assert.match(file, /gho-token/);
    assert.equal((await s.http("GET", "/")).headers.location, "/connect");
    assert.equal(await s.flash(await s.post("/connect", { repo: "acme/app" })), "Connected to acme/app. Here's your board.");
    const board = (await s.http("GET", "/")).body;
    assert.match(board, /<summary title="You: isha-gh" data-user><span class="av">I<\/span><span class="ws-name">isha-gh<\/span>[^]*?data-integrations-nav>Profile settings<small>[^]*?data-signout>Sign out<\/button>/);
    assert.doesNotMatch(board, /gho-token/);
    // writes are now recorded as the GitHub login
    const at = String((await s.store.readStream(S)).at(-1)?.seq);
    await s.post("/act", { type: "node", id: "table", event: "START", seen: at });
    assert.equal((await s.store.readStream(S)).at(-1)?.metadata.actor, "isha-gh");
    // a code GitHub never approved, or an old one, doesn't sign anyone in
    assert.match((await s.post("/signin/poll", { id: "nope", fragment: "1" })).body, /data-error>That sign-in expired: start again\./);
    // sign out drops the session
    await s.post("/signout", {});
    assert.equal((await s.http("GET", "/")).headers.location, "/welcome");
  } finally {
    await s.done();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the way in, without a fixed name: the landing, sign in with GitHub, connect a repo (Jira optional), then the board", async () => {
  const home = mkdtempSync(join(tmpdir(), "tira-home-"));
  const s = await serving(home, null);
  const to = async (path: string, host?: string) => (await s.http("GET", path, undefined, host)).headers.location;
  try {
    // no one signed in: every page leads to the landing, and nothing is written
    assert.equal(await to("/"), "/welcome");
    assert.equal(await to("/integrations"), "/welcome");
    assert.equal(await to("/connect"), "/welcome");
    let landing = (await s.http("GET", "/welcome")).body;
    assert.match(landing, /<div class="land-card" data-landing><section class="land-brand" aria-label="What tira does">/);
    assert.match(landing, /<h1>Set up sign-in<\/h1>/); // the first time on this machine: tira's GitHub app
    assert.doesNotMatch(landing, /data-signin-start/);
    assert.equal(await s.flash(await s.post("/connect", { repo: "acme/app" })), "Sign in with GitHub first.");
    const seen = String((await s.store.readStream(S)).at(-1)?.seq);
    assert.equal((await s.post("/act", { type: "node", id: "table", event: "START", seen })).status, 401);
    assert.equal(workspaceOf(await s.state(), S), undefined);
    // set up, then Continue with GitHub
    assert.equal(await s.flash(await s.post("/integrations/setup", { github_client_id: "Iv1.gh", back: "/welcome" })), "Saved. Now sign in.");
    landing = (await s.http("GET", "/welcome")).body;
    assert.match(landing, /<h1>Sign in to tira<\/h1>/);
    assert.match(landing, /<p class="land-foot" data-newcomer>The first person to sign in becomes the admin\.<\/p>/);
    const done = await s.signInWithGitHub();
    assert.match(done.body, /data-go="\/connect\?r=\d+"/);
    // signed in, no repo yet: connect one before the board
    assert.equal(await to("/welcome"), "/connect");
    assert.equal(await to("/"), "/connect");
    let page = (await s.http("GET", "/connect")).body;
    assert.match(page, /<ol class="land-steps" aria-label="Step 2 of 3"><li class="done"><\/li><li class="now" aria-current="step"><\/li><li><\/li><\/ol>/);
    assert.match(page, /<select name="repo" form="connect" aria-label="Repository" data-repo-pick><option value="acme\/app">acme\/app<\/option><option value="acme\/web">acme\/web<\/option><\/select>/);
    assert.match(page, /<form method="post" action="\/integrations\/setup" data-setup-atlassian><input type="hidden" name="token" value="k"><input type="hidden" name="back" value="\/connect">/);
    assert.equal(await s.flash(await s.post("/connect", {})), "Pick a repo.");
    assert.equal(await s.flash(await s.post("/connect", { repo: "not a repo" })), "not a repo isn't a repo as owner/name.");
    // Jira skipped: straight to the board, the repo linked as the person signed in
    const opened = await s.post("/connect", { repo: "acme/app" });
    assert.match(String(opened.headers.location), /^\/\?r=\d+$/);
    assert.equal(await s.flash(opened), "Connected to acme/app. Here's your board.");
    assert.deepEqual(workspaceOf(await s.state(), S), { version: 1, repo: "acme/app", by: "isha-gh" });
    const board = await s.http("GET", "/");
    assert.equal(board.status, 200);
    assert.match(board.body, /<input class="view-radio" type="radio" name="board-style" id="bv-kanban" checked/); // Kanban first
    assert.match(board.body, /data-user><span class="av">I<\/span><span class="ws-name">isha-gh<\/span>/);
    assert.equal(await to("/welcome"), "/");
    // Jira later, from the same step: set up, off to Atlassian, and back to the step
    assert.equal(await s.flash(await s.post("/integrations/setup", { atlassian_client_id: "at-id", atlassian_secret: "SECRET-xyz", back: "/connect" })), "Saved.");
    assert.match((await s.http("GET", "/connect", undefined, `127.0.0.1:${s.port}`)).body, /<a class="land-link" href="http:\/\/localhost:\d+\/connect">Open tira at localhost to connect<\/a>/);
    page = (await s.http("GET", "/connect")).body;
    // Atlassian opens in a tab of its own; the page waits for it (tabs.mjs)
    assert.match(page, /<a class="act" href="\/integrations\/jira\/connect\?back=\/connect&#38;tab=1" target="_blank" rel="noopener" data-connect-jira>Connect<\/a>/);
    assert.match(page, /<script type="module" src="\/tabs\.mjs"><\/script>/);
    assert.equal((await s.http("GET", "/integrations/jira/connect?back=/connect")).status, 302);
    const back = await s.http("GET", `/integrations/jira/callback?code=good-code&state=${s.atlassian.states.at(-1) ?? ""}`);
    assert.match(String(back.headers.location), /^\/connect\?r=\d+$/);
    assert.equal(await s.flash(back), "Connected to Jira https://acme.atlassian.net. Pick a project to link.");
    // the same round trip from its own tab: that tab says how it went, and tells the others
    await s.http("GET", "/integrations/jira/connect?back=/connect&tab=1");
    const inTab = await s.http("GET", `/integrations/jira/callback?code=good-code&state=${s.atlassian.states.at(-1) ?? ""}`);
    assert.equal(inTab.status, 200);
    assert.match(inTab.body, /<div class="land-card one" data-jira-done><div class="land-body"><header><h1>Jira connected<\/h1><p>Connected to Jira https:\/\/acme\.atlassian\.net\. Pick a project to link\.<\/p><\/header>/);
    assert.match(inTab.body, /<a href="\/connect">Back to tira<\/a>/);
    await s.http("GET", "/integrations/jira/connect?back=/connect&tab=1");
    const deniedInTab = await s.http("GET", `/integrations/jira/callback?error=access_denied&state=${s.atlassian.states.at(-1) ?? ""}`);
    assert.match(deniedInTab.body, /<h1>Jira wasn't connected<\/h1><p>Jira wasn&#39;t connected \(access_denied\)\.<\/p>/);
    assert.doesNotMatch(deniedInTab.body, /data-jira-done/);
    page = (await s.http("GET", "/connect")).body;
    assert.match(page, /<select name="jira_project" form="connect" aria-label="Jira project" data-jira-pick><option value="">None<\/option><option value="DOG">Dogma \(DOG\)<\/option><option value="WEB">Website \(WEB\)<\/option><\/select>/);
    assert.equal(await s.flash(await s.post("/connect", { repo: "acme/app", jira_project: "DOG" })), "Connected to acme/app and Jira Dogma. Here's your board.");
    assert.deepEqual(workspaceOf(await s.state(), S), { version: 2, repo: "acme/app", jira_site: "https://acme.atlassian.net", jira_project: "DOG", jira_name: "Dogma", by: "isha-gh" });
    await s.post("/connect", { repo: "acme/app", jira_project: "DOG" }); // nothing changed: no new version
    await s.post("/connect", { repo: "acme/app" }); // no Jira picker on the form: Jira stays as it is
    assert.equal(workspaceOf(await s.state(), S)?.version, 2);
    await s.post("/connect", { repo: "acme/app", jira_project: "" }); // "None" unlinks it
    assert.deepEqual(workspaceOf(await s.state(), S), { version: 3, repo: "acme/app", by: "isha-gh" });
    assert.doesNotMatch(page, /SECRET-xyz|at-token|gho-token/);
    // a form can only send you back to tira's own steps
    const elsewhere = await s.post("/integrations/setup", { atlassian_client_id: "at-id", back: "https://evil.example/" });
    assert.match(String(elsewhere.headers.location), /^\/integrations\?r=\d+$/);
    await s.http("GET", "/integrations/jira/connect?back=https://evil.example/");
    const cb = await s.http("GET", `/integrations/jira/callback?code=good-code&state=${s.atlassian.states.at(-1) ?? ""}`);
    assert.match(String(cb.headers.location), /^\/integrations\?r=\d+$/);
    // signing out leads back to the landing
    await s.post("/signout", {});
    assert.equal(await to("/"), "/welcome");
  } finally {
    await s.done();
    rmSync(home, { recursive: true, force: true });
  }
});

test("access: the first person to sign in is the admin; after that only people the admin adds get in, and others are told who to ask", async () => {
  const home = mkdtempSync(join(tmpdir(), "tira-home-"));
  const s = await serving(home, null);
  try {
    await s.post("/integrations/setup", { github_client_id: "Iv1.gh", back: "/welcome" });
    // the first in becomes the admin, and sets how people reach them
    assert.equal(await s.flash(await s.signInWithGitHub()), "Signed in as isha-gh: you're this tira's admin. Add the people who may sign in in Profile settings.");
    assert.equal(access(s.env).admin, "isha-gh");
    let page = (await s.http("GET", "/settings")).body;
    assert.match(page, /<div class="grp-list" data-people><div class="grp-row"><span class="grp-k">isha-gh<\/span><span class="pill">Admin<\/span><\/div><form [^>]*data-add-person>/);
    assert.match(page, /<input type="text" name="name" value="Isha"/); // GitHub's name, to start with
    assert.equal(await s.flash(await s.post("/integrations/people", { do: "contact", name: "Isha", email: "isha@example.com" })), "Saved: the sign-in page shows how to reach you.");
    assert.equal(await s.flash(await s.post("/integrations/people", { do: "contact", name: "Isha", email: "not an email" })), "That isn't a name and an email people can use.");
    s.signOut();
    assert.match((await s.http("GET", "/welcome")).body, /<p class="land-foot" data-newcomer>New here\? Ask Isha \(<a href="mailto:isha@example\.com" data-admin-email>isha@example\.com<\/a>\) for access\.<\/p>/);
    // someone else: refused, told who to ask, and nothing of theirs is kept
    s.githubAuthApi.login = "octo";
    const refused = await s.signInWithGitHub();
    assert.equal(refused.headers["set-cookie"], undefined);
    assert.match(refused.body, /^<div data-go="\/welcome\?r=\d+"><\/div>$/);
    assert.equal(await s.flash(refused), "octo doesn't have access to this tira yet. Ask the admin, Isha (isha@example.com), to add your GitHub account.");
    assert.equal(githubAuth("octo", s.env), undefined);
    assert.equal((await s.http("GET", "/")).headers.location, "/welcome");
    // the admin adds them (any case, with or without @); then they get in
    s.githubAuthApi.login = "isha-gh";
    await s.signInWithGitHub();
    const admin = (await s.http("GET", "/connect")).status === 200 ? "ok" : "no";
    assert.equal(admin, "ok");
    assert.equal(await s.flash(await s.post("/integrations/people", { do: "add", login: "@octo" })), "Added octo: they can sign in with GitHub now.");
    assert.equal(await s.flash(await s.post("/integrations/people", { do: "add", login: "OCTO" })), "OCTO can already sign in.");
    assert.equal(await s.flash(await s.post("/integrations/people", { do: "add", login: "not a login!" })), "That isn't a GitHub username.");
    s.githubAuthApi.login = "octo";
    assert.equal(await s.flash(await s.signInWithGitHub()), "Signed in as octo. tira records your changes as octo.");
    assert.equal((await s.http("GET", "/")).headers.location, "/connect");
    // a member can't change who gets in, and sees who to ask
    page = (await s.http("GET", "/settings")).body;
    assert.match(page, /<span class="grp-k">Admin<\/span><span class="grp-v">Isha<\/span><\/div><\/div><div class="grp-foot">Ask the admin to add or remove people\.<\/div>/);
    assert.equal(await s.flash(await s.post("/integrations/people", { do: "add", login: "mallory" })), "Only this tira's admin can change who may sign in.");
    const octoSession = s.cookie();
    // removed: signed out at once, and tira forgets their sign-ins
    s.githubAuthApi.login = "isha-gh";
    await s.signInWithGitHub();
    assert.equal(await s.flash(await s.post("/integrations/people", { do: "remove", login: "octo" })), "Removed octo: they're signed out and can't sign in. Their GitHub and Jira links stay until they unlink them.");
    assert.deepEqual(access(s.env).members, []);
    assert.equal(githubAuth("octo", s.env)?.token !== undefined, true); // their link stays: only they unlink it (Isha, 2026-10-22)
    assert.equal(sessionLogin(octoSession.replace(/^tira_session=/, ""), s.env), undefined); // but every session of theirs ends
    s.signIn(octoSession);
    assert.equal((await s.http("GET", "/")).headers.location, "/welcome");
    // a session kept for someone not on the list (from before there was one) doesn't get in either
    await saveSession("old-session", "mallory", s.env);
    s.signIn("tira_session=old-session");
    assert.equal((await s.http("GET", "/")).headers.location, "/welcome");
    // the admin can't be removed
    s.githubAuthApi.login = "isha-gh";
    await s.signInWithGitHub();
    // only you unlink your GitHub: Profile settings' Disconnect GitHub forgets the token and signs you out
    assert.match((await s.http("GET", "/settings")).body, /<form method="post" action="\/integrations\/github\/disconnect" class="grp-row" data-disconnect-github>[^]*?Disconnect GitHub<\/button>/);
    const unlinked = await s.post("/integrations/github/disconnect", {});
    assert.match(String(unlinked.headers.location), /^\/welcome\?r=\d+$/);
    assert.match(String(unlinked.headers["set-cookie"]), /^tira_session=; /);
    assert.equal(githubAuth("isha-gh", s.env), undefined);
    assert.equal((await s.http("GET", "/")).headers.location, "/welcome");
    await s.signInWithGitHub();
    assert.equal(await s.flash(await s.post("/integrations/people", { do: "remove", login: "isha-gh" })), "Nothing changed.");
    assert.equal(access(s.env).admin, "isha-gh");
  } finally {
    await s.done();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Connect Jira through Atlassian, pick a repo and a project from lists (in Project settings, or right away for a new project), and sync: tasks and pull requests show on the board", async () => {
  const home = mkdtempSync(join(tmpdir(), "tira-home-"));
  const s = await serving(home);
  try {
    await s.post("/integrations/setup", { github_client_id: "Iv1.gh", atlassian_client_id: "at-id", atlassian_secret: "SECRET-xyz" });
    const id = /name="id" value="([0-9a-f]+)"/.exec((await s.post("/signin/start", {})).body)?.[1] ?? "";
    s.githubAuthApi.approveAfter = 0;
    s.signIn(String((await s.post("/signin/poll", { id, fragment: "1" })).headers["set-cookie"]).split(";")[0] ?? "");
    // the repo, from your repos
    let page = (await s.http("GET", "/integrations")).body;
    assert.match(page, /<select name="repo" aria-label="Repository"><option value="acme\/app">acme\/app<\/option><option value="acme\/web">acme\/web<\/option><\/select><button class="act primary" type="submit">Link<\/button>/);
    assert.match(page, /<details class="int-cmd"><summary>Show the command<\/summary><code>tira link --repo acme\/app<\/code>/);
    assert.equal(await s.flash(await s.post("/integrations/link", { what: "repo", repo: "acme/app" })), "Linked (version 1).");
    // a new project, before Jira is connected: your repos to pick from, and a way to connect Jira
    let fresh = (await s.http("GET", "/projects/new")).body;
    assert.match(fresh, /<input name="repo" value="" required pattern="[^"]+" placeholder="owner\/name" autocomplete="off" spellcheck="false" list="np-repos" data-np-repo><\/label><datalist id="np-repos"><option value="acme\/app"><option value="acme\/web"><\/datalist>/);
    assert.match(fresh, /<a class="act" href="\/integrations\/jira\/connect\?back=\/projects\/new&#38;tab=1" target="_blank" rel="noopener" data-connect-jira>Connect with Jira<\/a>/);
    assert.match(fresh, /<script type="module" src="\/tabs\.mjs"><\/script>/); // the page reloads when Jira says yes
    // Jira: off to Atlassian and back
    assert.match(page, /<a class="act primary" href="\/integrations\/jira\/connect\?tab=1" target="_blank" rel="noopener" data-connect-jira>Connect Jira<\/a>/);
    const go = await s.http("GET", "/integrations/jira/connect");
    assert.equal(go.status, 302);
    assert.match(String(go.headers.location), new RegExp(`^https://auth\\.example/authorize\\?client_id=at-id&redirect_uri=${encodeURIComponent(`http://localhost:${s.port}/integrations/jira/callback`)}&state=[0-9a-f]{48}$`));
    const state = s.atlassian.states.at(-1) ?? "";
    // a callback with a state tira didn't hand out is refused
    assert.equal(await s.flash(await s.http("GET", `/integrations/jira/callback?code=good-code&state=forged`)), "That Jira sign-in didn't come from here, or took too long: connect again.");
    assert.equal(await s.flash(await s.http("GET", `/integrations/jira/callback?code=good-code&state=${state}`)), "Connected to Jira https://acme.atlassian.net. Pick a project to link.");
    assert.equal(atlassianAuth("isha-gh", s.env)?.cloudId, "cloud-1");
    // a state works once
    assert.match(await s.flash(await s.http("GET", `/integrations/jira/callback?code=good-code&state=${state}`)), /didn't come from here/);
    page = (await s.http("GET", "/integrations")).body;
    assert.match(page, /<select name="jira_project" aria-label="Jira project"><option value="DOG">Dogma \(DOG\)<\/option><option value="WEB">Website \(WEB\)<\/option><\/select>/);
    assert.equal(await s.flash(await s.post("/integrations/link", { what: "jira", jira_project: "DOG" })), "Linked (version 2).");
    // the project's name, as Jira shows it, saved with its key
    assert.deepEqual(workspaceOf(await s.state(), S), { version: 2, repo: "acme/app", jira_site: "https://acme.atlassian.net", jira_project: "DOG", jira_name: "Dogma", by: "isha-gh" });
    assert.doesNotMatch(page, /at-token|rt-token|SECRET-xyz|gho-token/);
    // your Jira is yours, in every project: Profile settings show it, and disconnect it
    assert.match((await s.http("GET", "/settings")).body, /<span class="grp-k">Jira<\/span><span class="grp-v">Connected: https:\/\/acme\.atlassian\.net<\/span><\/div><form method="post" action="\/integrations\/jira\/disconnect"[^]*?Disconnect Jira/);
    // a new project, once Jira is connected: pick its Jira project in the first step
    fresh = (await s.http("GET", "/projects/new")).body;
    assert.match(fresh, /<select name="jira_project" aria-label="Jira project" data-np-jira><option value="">None for now<\/option><option value="DOG">Dogma \(DOG\)<\/option><option value="WEB">Website \(WEB\)<\/option><\/select>/);
    const wrongKey = await s.post("/projects", { name: "site", repo: "acme/web", jira_project: "not a key" });
    assert.equal(wrongKey.status, 400);
    assert.match(wrongKey.body, /data-np-problem>Pick a Jira project from your connected site, or none for now\.<\/div>/);
    const site = await s.post("/projects", { name: "site", repo: "acme/web", jira_project: "WEB" });
    assert.equal(await s.flash(site), "Created site, linked to GitHub acme/web and Jira Website. Sync from here.");
    assert.deepEqual(workspaceOf(fold(await s.store.readAll(), s.registry), "site"), { version: 1, repo: "acme/web", jira_site: "https://acme.atlassian.net", jira_project: "WEB", jira_name: "Website", by: "isha-gh" });
    // sync, from the board's own button
    s.github.add({ number: 7, title: "tira: table", state: "closed", mergedAt: "2026-10-21T12:00:00Z" });
    const synced = await s.post("/sync", {});
    assert.match(await s.flash(synced), /^Sync: synced with GitHub acme\/app and Jira DOG; acme\/app#7 linked to table; acme\/app#7 merged \(table\); dashboard: made Jira DOG-1; table: made Jira DOG-2; filters: made Jira DOG-3\.$/);
    const board = (await s.http("GET", "/")).body;
    assert.match(board, /title="Jira: Dogma \(DOG\)" data-link-jira><svg[^]*?<\/svg><span>Dogma<\/span><\/a><form method="post" action="\/sync" class="inline"><input type="hidden" name="token" value="k"><button class="act" type="submit" data-sync>Sync<\/button><\/form><\/div>/); // linked to both: nothing to add, and no Connect
    assert.doesNotMatch(board, /Connect GitHub and Jira|data-add-jira|data-add-repo/);
    assert.match(board, /<span class="chip jira" data-jira-key="DOG-2">DOG-2<\/span>/);
    assert.match(board, /<div class="task-links" data-task-links><p><span class="lk">Jira<\/span><a href="https:\/\/acme\.atlassian\.net\/browse\/DOG-2" rel="noopener noreferrer">DOG-2<\/a><span class="pill">To Do<\/span><\/p><p><span class="lk">Pull request<\/span><a href="https:\/\/github\.com\/acme\/app\/pull\/7" rel="noopener noreferrer">#7<\/a><span class="pill merged">merged<\/span><span>tira: table<\/span><\/p><\/div>/);
    assert.doesNotMatch(board, /class="chip" title="pr:|chip" title="jira-issue:/); // links show on their tasks, not as Lanes chips
    // completing the task offers the merged pull request as its proof
    await s.send("table", "START");
    const complete = (await s.http("GET", "/confirm?type=node&id=table&event=COMPLETE&fragment=1")).body;
    assert.match(complete, /<span>Proof from GitHub:<\/span><button type="button" class="fill" data-fill="evidenceRef" data-value="https:\/\/github\.com\/acme\/app\/pull\/7">/);
    // disconnect drops the Atlassian sign-in
    await s.post("/integrations/jira/disconnect", {});
    assert.equal(atlassianAuth("isha-gh", s.env), undefined);
    // over 127.0.0.1, Jira says to come back on localhost (Atlassian sends you there)
    assert.match((await s.http("GET", "/integrations", undefined, `127.0.0.1:${s.port}`)).body, /<a class="how" href="http:\/\/localhost:\d+\/integrations">Open tira at localhost to connect<\/a>/);
  } finally {
    await s.done();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the rendered file shows the links, never the actions", async () => {
  const w = await world();
  await w.link(linked);
  await w.run();
  const events = await w.store.readStream(S);
  const html = renderHtml(fold(events, w.registry), S, "h", events);
  assert.match(html, /<div class="proj-links" data-workspace aria-label="Linked to"><a class="pl" href="https:\/\/github\.com\/acme\/app"[^>]*data-link-repo><svg[^]*?<\/svg><span>acme\/app<\/span><\/a><a class="pl jira" href="https:\/\/acme\.atlassian\.net\/browse\/DOG"[^>]*data-link-jira><svg[^]*?<\/svg><span>DOG<\/span><\/a><\/div>/);
  assert.doesNotMatch(html, /data-act="SYNC"|data-act="CONNECT"/);
});

test("the CLI: tira link keeps what it isn't told and clears what's empty; tira connect-jira asks for the token; tira sync prints the report", async () => {
  const { run } = await import("../src/cli/cli.ts");
  const dir = mkdtempSync(join(tmpdir(), "tira-cli-links-"));
  try {
    const jira = new FakeJira();
    const github = new FakeGitHub();
    const asked: string[] = [];
    const tira = async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(["--db", join(dir, "t.db"), "--actor", "isha", ...argv], {
        out: (l) => out.push(l), err: (l) => err.push(l), env: { TIRA_HOME: dir },
        secret: async (prompt) => { asked.push(prompt); return "tok-cli"; },
        jira: () => jira, github, openStore: sqliteFile,
      });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    await tira("create", "node", "dashboard");
    assert.match((await tira("link", "--repo", "acme/app")).out, /^workspace tasktree-main linked \(version 1\): GitHub acme\/app$/);
    assert.match((await tira("link", "--jira", "DOG")).err, /a Jira project needs its site/);
    assert.match((await tira("link", "--jira-site", "https://acme.atlassian.net/", "--jira", "DOG")).out, /\(version 2\): GitHub acme\/app · Jira DOG on https:\/\/acme\.atlassian\.net$/);
    assert.match((await tira("link", "--repo", "")).out, /\(version 3\): Jira DOG on https:\/\/acme\.atlassian\.net$/);
    // the project's name as Jira shows it; it sticks while the same project stays linked
    assert.match((await tira("link", "--jira-name", "")).err, /--jira-name is the project's name as Jira shows it, 1 to 80 characters, got ""/);
    assert.match((await tira("link", "--jira-name", "Dogs")).out, /\(version 4\): Jira Dogs \(DOG\) on https:\/\/acme\.atlassian\.net$/);
    assert.match((await tira("sync")).out, /tira isn't signed in to Jira https:\/\/acme\.atlassian\.net: run tira connect-jira/);
    const connected = await tira("connect-jira", "--email", "isha@example.com");
    assert.equal(connected.code, 0);
    assert.deepEqual(asked, ["Jira API token for isha@example.com (it won't show as you type): "]);
    assert.match(connected.out, /^connected to Jira https:\/\/acme\.atlassian\.net as Isha; the token is kept in .*credentials\.json, readable only by you$/);
    assert.doesNotMatch(connected.out, /tok-cli/);
    assert.deepEqual(jiraLogin("https://acme.atlassian.net", { TIRA_HOME: dir }), { email: "isha@example.com", token: "tok-cli" });
    const synced = await tira("sync");
    assert.equal(synced.code, 0);
    // Jira calls it Dogma, not Dogs: the sync saves Jira's name, as whoever ran it
    assert.equal(synced.out, "synced with Jira DOG\nJira calls DOG \"Dogma\": the link shows that name now\ndashboard: made Jira DOG-1");
    assert.deepEqual(JSON.parse((await tira("sync", "--json")).out).created, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("+ New project: its own page, name it and connect its repo (Jira optional), and its board opens; every page on the way keeps the project", async () => {
  const home = mkdtempSync(join(tmpdir(), "tira-home-"));
  const s = await serving(home, null);
  try {
    await s.post("/integrations/setup", { github_client_id: "Iv1.gh", back: "/welcome" });
    await s.signInWithGitHub();
    await s.post("/connect", { repo: "acme/app" }); // the first project, as before
    // the sidebar offers a new one on a page of its own: its name and repo, a preview, what happens next
    const board = (await s.http("GET", "/")).body;
    assert.match(board, /<a class="new-project" href="\/projects\/new" data-new-project><svg[^]*?<\/svg>New project<\/a>/);
    assert.doesNotMatch(board, /<form[^>]*action="\/projects"/); // no form in the sidebar
    const newPage = (await s.http("GET", "/projects/new")).body;
    assert.match(newPage, /<main class="settings-page np-page" data-new-project-page><nav class="set-nav" aria-label="New project"><a class="brand" href="\/" title="Home: the board" data-home>/); // the mark goes back
    assert.match(newPage, /<form method="post" action="\/projects" class="grp-list np-form" data-new-project-form><input type="hidden" name="token" value="k"><label class="grp-row np-field"><span class="grp-k">Project name<small>[^<]+<\/small><\/span><input autofocus name="name" value="" required/);
    assert.match(newPage, /<span class="grp-k">GitHub repository<small>[^<]+<\/small><\/span><input name="repo" value="" required pattern="[^"]+" placeholder="owner\/name"/);
    assert.match(newPage, /<div class="grp-row np-acts"><a class="act" href="\/">Cancel<\/a><button class="act primary" type="submit">Create project<\/button><\/div><\/form>/);
    assert.match(newPage, /<div class="np-card" data-np-preview>[^]*?<b data-np-show-name>your-project<\/b>/);
    assert.match(newPage, /<script type="module" src="\/new-project\.mjs"><\/script>/);
    assert.equal((await s.http("GET", "/new-project.mjs")).status, 200);
    // connecting Jira swaps in the Jira row alone; what was typed isn't kept anywhere but the form
    assert.match(newPage, /<div class="np-jira" data-np-jira-row>/);
    const npScript = readFileSync(new URL("../src/serve/new-project.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(npScript, /sessionStorage|localStorage/);
    assert.match(npScript, /querySelector\("\[data-np-jira-row\]"\)[^]*?replaceWith/);
    assert.match(readFileSync(new URL("../src/serve/tabs.mjs", import.meta.url), "utf8"), /!document\.querySelector\("\[data-np-jira-row\]"\)\) location\.reload\(\)/);
    const made = await s.post("/projects", { name: "tablet", repo: "acme/tablet" });
    assert.match(String(made.headers.location), /^\/\?r=\d+&w=tablet$/);
    assert.equal(await s.flash(made), "Created tablet, linked to GitHub acme/tablet. Add its Jira project, or sync, from here.");
    assert.deepEqual(workspaceOf(fold(await s.store.readAll(), s.registry), "tablet"), { version: 1, repo: "acme/tablet", by: "isha-gh" });
    const tablet = (await s.http("GET", "/?w=tablet")).body;
    assert.match(tablet, /<main data-stream="tablet"[^>]* data-q="w=tablet">/); // the page names its project for its script
    assert.doesNotMatch(readFileSync(new URL("../src/serve/app.mjs", import.meta.url), "utf8"), /location\.search/); // never from the address bar
    assert.match(tablet, /<a class="act" href="\/integrations\?w=tablet#jira" data-add-jira>/); // add Jira, or sync, from its own page
    // opened from another project, it goes back there
    const fromTablet = (await s.http("GET", "/projects/new?w=tablet")).body;
    assert.match(fromTablet, /<a class="brand" href="\/\?w=tablet"[^]*?<form method="post" action="\/projects\?w=tablet"[^]*?<a class="act" href="\/\?w=tablet">Cancel<\/a>/);
    // a name taken, a name that can't be one, a repo that isn't owner/name: nothing written, and the
    // page comes back with what was typed, why, and the cursor on the field to fix
    const taken = await s.post("/projects", { name: "tablet", repo: "acme/x" });
    assert.equal(taken.status, 409);
    assert.match(taken.body, /<div class="flash no" role="alert" id="np-problem" data-np-problem>There is a project named tablet already: pick it in Projects, or name this one differently\.<\/div>/);
    assert.match(taken.body, /<input aria-invalid="true" aria-describedby="np-problem" autofocus name="name" value="tablet"/);
    assert.match(taken.body, /<input name="repo" value="acme\/x"/);
    const bad = await s.post("/projects", { name: "-bad", repo: "acme/x" });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /data-np-problem>A project&#39;s name is letters, digits, dots, dashes or underscores/);
    const notRepo = await s.post("/projects", { name: "watch", repo: "not a repo" });
    assert.equal(notRepo.status, 400);
    assert.match(notRepo.body, /data-np-problem>not a repo isn&#39;t a GitHub repo as owner\/name\.<\/div>/);
    assert.match(notRepo.body, /<input name="name" value="watch" required/);
    assert.match(notRepo.body, /<input aria-invalid="true" aria-describedby="np-problem" autofocus name="repo" value="not a repo"/);
    assert.equal((await s.store.readStream("watch")).length, 0);
    // a project the store doesn't hold yet, signed in: the board sends you to connect it
    assert.equal((await s.http("GET", "/?w=mobile")).headers.location, "/connect?w=mobile");
    const step = (await s.http("GET", "/connect?w=mobile")).body;
    // its forms and links keep the project
    assert.match(step, /<form method="post" action="\/connect\?w=mobile" id="connect">/);
    assert.doesNotMatch(step, /(?:href|action)="\/(?:connect|integrations[^"?]*|signout|welcome)"/); // none left pointing at the first project
    const opened = await s.post("/connect?w=mobile", { repo: "acme/web" });
    assert.match(String(opened.headers.location), /^\/\?r=\d+&w=mobile$/);
    assert.equal(await s.flash(opened), "Connected to acme/web. Here's your board.");
    // the link landed in the new project's stream, the first project's is untouched
    const all = fold(await s.store.readAll(), s.registry);
    assert.deepEqual(workspaceOf(all, "mobile"), { version: 1, repo: "acme/web", by: "isha-gh" });
    assert.equal(workspaceOf(all, S)?.repo, "acme/app");
    const page = await s.http("GET", "/?w=mobile");
    assert.equal(page.status, 200);
    assert.match(page.body, /<main data-stream="mobile"/);
    assert.match(page.body, /<a class="pl" href="https:\/\/github\.com\/acme\/web"/);
    assert.match(page.body, /<a class="act" href="\/integrations\?w=mobile#jira" data-add-jira><svg[^]*?<\/svg>Add Jira<\/a><form method="post" action="\/sync\?w=mobile" class="inline">/);
    assert.match(page.body, /<form method="post" action="\/sync\?w=mobile" class="inline">/);
    // deleting a project, from its settings: its name typed to be sure; never the one tira serve
    // was started with; then it's off the list and its board is closed, its history kept
    assert.match((await s.http("GET", "/integrations?w=tablet")).body, /<form method="post" action="\/projects\/delete\?w=tablet" class="grp-list" data-delete-project><input type="hidden" name="token" value="k"><label class="grp-row"><span class="grp-k">Type <b>tablet<\/b> to confirm<\/span><input type="text" name="confirm"[^>]*><\/label>[^]*?<button class="act danger" type="submit">Delete this project<\/button>/);
    assert.equal(await s.flash(await s.post("/projects/delete?w=tablet", { confirm: "tab" })), "Type tablet exactly to delete it. Nothing was deleted.");
    assert.equal(await s.flash(await s.post("/projects/delete", { confirm: S })), "This is the project tira serve was started with: it can't be deleted here. Nothing was deleted.");
    const gone = await s.post("/projects/delete?w=tablet", { confirm: "tablet" });
    assert.match(String(gone.headers.location), /^\/\?r=\d+$/);
    assert.equal(await s.flash(gone), "Deleted tablet: it's off the project list. Its history stays in tira's log.");
    const after = fold(await s.store.readAll(), s.registry);
    assert.deepEqual(workspaceOf(after, "tablet"), { version: 2, repo: "acme/tablet", by: "isha-gh", deleted: true });
    assert.ok((await s.store.readStream("tablet")).length > 1, "nothing is erased");
    const closed = await s.http("GET", "/?w=tablet");
    assert.equal(closed.status, 410);
    assert.match(closed.body, /<div class="packet" data-deleted-project><h1>tablet was deleted<\/h1><p class="hint">isha-gh deleted it\. Its board is closed; its history stays in tira's log\.<\/p>/);
    assert.deepEqual((JSON.parse((await s.http("GET", "/api/workspaces")).body) as { stream: string }[]).map((w) => w.stream).includes("tablet"), false);
    const again = await s.post("/projects", { name: "tablet", repo: "acme/tablet" });
    assert.equal(again.status, 409);
    assert.match(again.body, /data-np-problem>tablet was a project here, since deleted: pick another name\.<\/div>/);
    // renaming a project, from its settings: what people see changes everywhere; its address, its
    // colour and its history keep the name it was made with; two projects can't share a name
    assert.match((await s.http("GET", "/integrations?w=mobile")).body, /<form method="post" action="\/projects\/rename\?w=mobile" class="grp-list" data-rename-project><input type="hidden" name="token" value="k"><label class="grp-row"><span class="grp-k">Project name<\/span><input type="text" name="title" value="mobile" required/);
    assert.equal(await s.flash(await s.post("/projects/rename?w=mobile", { title: "  Mobile   App " })), "Renamed to Mobile App. Its address and history keep mobile.");
    assert.equal(await s.flash(await s.post("/projects/rename?w=mobile", { title: "TASKTREE-DASH" })), "Another project is already called TASKTREE-DASH: pick another name.");
    assert.equal(await s.flash(await s.post("/projects/rename?w=mobile", { title: "" })), "A project's name is 1 to 80 characters, with no control characters.");
    assert.equal(await s.flash(await s.post("/projects/rename?w=mobile", { title: "Mobile App" })), "It's already called Mobile App.");
    const renamed = (await s.http("GET", "/?w=mobile")).body;
    assert.match(renamed, /<title>tira · Mobile App<\/title>/);
    assert.match(renamed, new RegExp(`<h1><span class="pav t${tint("mobile")}" aria-hidden="true">M</span>Mobile App</h1>`)); // its colour stays
    assert.equal(workspaceOf(fold(await s.store.readAll(), s.registry), "mobile")?.repo, "acme/web"); // its links stay
    assert.deepEqual((JSON.parse((await s.http("GET", "/api/workspaces?w=mobile")).body) as { stream: string; title?: string }[]).find((w) => w.stream === "mobile")?.title, "Mobile App");
    // a later link change that doesn't mention the name keeps it
    await s.post("/integrations/link?w=mobile", { what: "repo", repo: "acme/web2" });
    assert.equal(workspaceOf(fold(await s.store.readAll(), s.registry), "mobile")?.title, "Mobile App");
    // no one signed in: the landing first
    s.signOut();
    assert.equal((await s.http("GET", "/projects/new")).headers.location, "/welcome");
  } finally {
    await s.done();
  }
  // the adapter alone: a same-site path gets the project, once; other addresses are left alone
  assert.equal(carryQ(`<a href="/integrations">x</a><form action="/connect?r=1"></form><a href="https://github.com/a">g</a><a href="/x?w=y">k</a>`, "w=p"),
    `<a href="/integrations?w=p">x</a><form action="/connect?r=1&#38;w=p"></form><a href="https://github.com/a">g</a><a href="/x?w=y">k</a>`);
  assert.equal(carryQ(`<a href="/integrations">x</a>`, ""), `<a href="/integrations">x</a>`);
});

test("Settings, after GitHub's: Profile settings (yours) and Project settings (the project's), each with sections on the left, the page across the middle, the Help centre as a support chat on the right; the tira mark goes back to the board", async () => {
  const home = mkdtempSync(join(tmpdir(), "tira-home-"));
  const s = await serving(home);
  try {
    const page = (await s.http("GET", "/settings")).body;
    const project = (await s.http("GET", "/integrations")).body;
    assert.match(page, /<main class="settings-page" data-settings><nav class="set-nav" aria-label="Profile settings"><a class="brand" href="\/" title="Home: the board" data-home>/);
    assert.match(project, /<main class="settings-page" data-settings><nav class="set-nav" aria-label="Project settings"><a class="brand" href="\/" title="Home: the board" data-home>/);
    const nav = (p: string) => [...p.matchAll(/<a class="set-link" href="#(\w+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(nav(page), [["account", "Profile"], ["accounts", "Accounts"], ["appearance", "Appearance"], ["people", "People"], ["setup", "Setup"]]);
    assert.deepEqual(nav(project), [["general", "General"], ["github", "GitHub"], ["jira", "Jira"], ["sync", "Sync"], ["delete", "Delete"]]);
    for (const [p, ids] of [[page, ["account", "accounts", "appearance", "people", "setup"]], [project, ["general", "github", "jira", "sync", "delete"]]] as const) for (const id of ids) assert.match(p, new RegExp(`id="${id}"`), id); // each link lands on its section
    assert.doesNotMatch(page + project, /← the board|How to make these apps<\/summary>/); // the mark is the way back; the how-to is in Help
    // the profile, as GitHub and Jira show one: a picture (its initial), the name, what it is
    assert.match(page, /<div class="profile" data-profile-card><span class="av av-lg">I<\/span><span class="pf-who"><b>isha<\/b><span>the name tira serve was started with<\/span><\/span><\/div>/);
    // how tira looks: System, Light or Dark, picked here (the radios every page carries), not in a sidebar
    assert.match(page, /<div class="appear" data-theme-switch><label for="th-system" class="look look-system">[^]*?<b>System<\/b><small>Follows your computer<\/small><\/label><label for="th-light" class="look look-light">[^]*?<label for="th-dark" class="look look-dark">/);
    assert.match(page, /<input class="view-radio" type="radio" name="theme" id="th-system" checked/);
    assert.doesNotMatch(project, /data-theme-switch/);
    assert.doesNotMatch((await s.http("GET", "/")).body, /data-theme-switch/);
    // what each section is for, under its title
    assert.match(project, /<h2 class="grp-h">GitHub<\/h2><p class="grp-desc">This project&#39;s repository\./);
    // deleting the project: not the one tira serve was started with
    assert.match(project, /<section class="grp danger" id="delete" data-int="delete"><h2 class="grp-h">Delete project<\/h2>[^]*?This is the project tira serve was started with/);
    assert.doesNotMatch(project, /data-delete-project/);
    // the Help centre, as a support chat: a panel that folds (remembered per browser) under a header
    // that says it answers right away; a greeting by name; the questions people ask as suggested
    // replies (with no script each opens on its answer, the app steps with this tira's address); and
    // a box to type your own, which help.mjs shows and answers
    const help = /<aside class="set-help" aria-label="Help centre" data-help>[^]*?<\/aside>/.exec(page)?.[0] ?? "";
    assert.match(help, /^<aside[^>]*><details class="hc" data-remember="tira-help-centre" open><summary class="help-head"[^>]*><span class="av tira">\?<\/span><span class="hc-t"><b>Help centre<\/b><small><i class="hc-on" aria-hidden="true"><\/i>Answers right away<\/small>/);
    assert.match(readFileSync(new URL("../src/serve/theme.mjs", import.meta.url), "utf8"), /for \(const d of document\.querySelectorAll\("details\[data-remember\]"\)\)[^]*?localStorage\.setItem\(d\.dataset\.remember, d\.open \? "1" : "0"\)/);
    assert.match(help, /<div class="hc-log" role="log" aria-live="polite" aria-label="Conversation" data-help-log><div class="msg from-tira"><span class="av tira" aria-hidden="true">t<\/span><div class="msg-b"><p class="bubble">Hi isha! I'm tira's help\./);
    assert.equal((help.match(/<details class="hc-qa" data-keys="[a-z ]+"><summary class="hc-chip">/g) ?? []).length, 6);
    assert.match(help, /How do I make tira&#39;s GitHub app\?<\/summary><p class="bubble">On GitHub: Settings → Developer settings → OAuth Apps → New\. Homepage <code>http:\/\/localhost:\d+<\/code>/);
    assert.match(help, /<div class="hc-bottom" data-help-bottom hidden><form class="hc-compose" data-help-ask><input name="q" aria-label="Ask a question" placeholder="Ask a question…"[^>]*><button class="hc-send" type="submit" aria-label="Send" disabled>/);
    assert.match(page, /<script type="module" src="\/help\.mjs"><\/script>/);
    assert.equal((await s.http("GET", "/help.mjs")).status, 200);
    assert.match(project, /<aside class="set-help" aria-label="Help centre" data-help>/); // on both
    // your display name: how you're shown (the sidebar, your profile, the help's greeting); your
    // changes stay under your name in the log
    assert.match(page, /<form method="post" action="\/integrations\/profile" class="grp-row" data-display-name><input type="hidden" name="token" value="k"><span class="grp-k">Display name<\/span><input type="text" name="name" value="" maxlength="60" autocomplete="off" placeholder="isha" aria-label="Display name">/);
    assert.equal(await s.flash(await s.post("/integrations/profile", { name: " Isha  M " })), "You're shown as Isha M now.");
    const named = (await s.http("GET", "/settings")).body;
    assert.match(named, /<span class="pf-who"><b>Isha M<\/b>/);
    assert.match(named, /<p class="bubble">Hi Isha M! I'm tira's help\./);
    assert.match((await s.http("GET", "/")).body, /<summary title="You: Isha M"><span class="av">I<\/span><span class="ws-name">Isha M<\/span>/);
    assert.equal(await s.flash(await s.post("/integrations/profile", { name: "<b>" })), "A display name is 1 to 60 characters, with no angle brackets.");
    assert.equal(await s.flash(await s.post("/integrations/profile", { name: "" })), "You're shown by your usual name again.");
    assert.match((await s.http("GET", "/")).body, /<span class="ws-name">isha<\/span>/);
    // another project's settings keep it, back link included; your settings go back to where you were
    assert.match((await s.http("GET", "/integrations?w=side")).body, /<a class="brand" href="\/\?w=side" title="Home: the board" data-home>/);
    assert.match((await s.http("GET", "/settings?w=side")).body, /<a class="brand" href="\/\?w=side" title="Home: the board" data-home>/);
  } finally {
    await s.done();
  }
});

test("a project's link may mark it deleted, linked or not; deleted is true or absent, and a link still names something", () => {
  const ok = (payload: Record<string, unknown>) => LINK_GUARDS.workspaceWellFormed?.({ actor: "isha", payload } as never) === true;
  assert.equal(ok({ repo: "acme/app", deleted: true }), true);
  assert.equal(ok({ deleted: true }), true); // a project made with tira create, never linked
  assert.equal(ok({ repo: "acme/app", deleted: "yes" }), false);
  assert.equal(ok({ deleted: false }), false);
  assert.equal(ok({}), false);
  assert.equal(ok({ title: "Mobile App" }), true); // a rename of a project never linked
  assert.equal(ok({ repo: "acme/app", title: " padded" }), false);
  assert.equal(ok({ repo: "acme/app", title: "x".repeat(81) }), false);
});

test("a Jira project shows by its name, as Jira shows it: saved with its key, sticking while that project stays linked, and caught up by a sync, as the person syncing", async () => {
  const ok = (payload: Record<string, unknown>) => LINK_GUARDS.workspaceWellFormed?.({ actor: "isha", payload } as never) === true;
  assert.equal(ok({ ...linked, jira_name: "Dogma" }), true);
  assert.equal(ok({ repo: "acme/app", jira_name: "Dogma" }), false); // a name needs its project
  for (const bad of ["", " padded", "bell\u0007", "x".repeat(81), 7]) assert.equal(ok({ ...linked, jira_name: bad }), false, JSON.stringify(bad));

  const w = await world();
  // the header's Jira chip: its tooltip | what it says
  const chip = async () => {
    const events = await w.store.readStream(S);
    const m = /<a class="pl jira"[^>]*title="([^"]*)" data-link-jira><svg[^]*?<\/svg><span>([^<]*)<\/span>/.exec(renderHtml(fold(events, w.registry), S, "h", events));
    return `${m?.[1]} | ${m?.[2]}`;
  };
  await w.link(linked); // linked before tira kept names: shown by its key
  assert.equal(workspaceOf(await w.state(), S)?.jira_name, undefined);
  assert.equal(await chip(), "Jira: DOG | DOG");
  // a sync with no one named (a test, a script) only reads: the link stays as it is
  const quiet = await w.run();
  assert.equal(quiet.jiraName, undefined);
  assert.deepEqual(quiet.problems, []);
  assert.equal(workspaceOf(await w.state(), S)?.version, 1);
  // a person's sync saves Jira's name, as them, and says so
  const sync1 = await sync({ store: w.store, registry: w.registry, stream: S, jira: w.jira, by: "isha" });
  assert.equal(sync1.jiraName, "Dogma");
  assert.ok(reportLines(sync1).includes(`Jira calls DOG "Dogma": the link shows that name now`));
  assert.deepEqual(workspaceOf(await w.state(), S), { version: 2, ...linked, jira_name: "Dogma", by: "isha" });
  assert.equal(await chip(), "Jira: Dogma (DOG) | Dogma");
  // the same name again: nothing written
  assert.equal((await sync({ store: w.store, registry: w.registry, stream: S, jira: w.jira, by: "isha" })).jiraName, undefined);
  assert.equal(workspaceOf(await w.state(), S)?.version, 2);
  // a change that doesn't mention the name keeps it, while the same project stays linked
  await w.link({ ...linked, repo: "acme/web" }, 3);
  assert.equal(workspaceOf(await w.state(), S)?.jira_name, "Dogma");
  // renamed in Jira: the next sync follows
  w.jira.names.set("DOG", "Dog Days");
  assert.equal((await sync({ store: w.store, registry: w.registry, stream: S, jira: w.jira, by: "devansh" })).jiraName, "Dog Days");
  assert.deepEqual(workspaceOf(await w.state(), S), { version: 4, ...linked, repo: "acme/web", jira_name: "Dog Days", by: "devansh" });
  // another project linked: the old name goes with the old project
  await w.link({ ...linked, jira_project: "WEB" }, 5);
  assert.equal(workspaceOf(await w.state(), S)?.jira_name, undefined);
  assert.equal(await chip(), "Jira: WEB | WEB");
  // a name Jira gives that can't be saved (too long) is left out; the sync carries on
  w.jira.names.set("WEB", "w".repeat(81));
  const long = await sync({ store: w.store, registry: w.registry, stream: S, jira: w.jira, by: "isha" });
  assert.equal(long.jiraName, undefined);
  assert.deepEqual(long.problems, []);
});
