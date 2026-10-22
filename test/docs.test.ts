// tira-docs/components/*.md: every DOM hook a component doc names under "Devtool hook"
// exists in a rendered page (static, live, a confirm page, a factory page) or in the
// palette's script, so the docs can't drift from the build.
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAccess, saveAppKeys, saveSession } from "../src/sync/credentials.ts";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { Dispatcher } from "../src/write/dispatcher.ts";
import { fold } from "../src/fold/fold.ts";
import { renderHtml } from "../src/render/html.ts";
import { tiraServer } from "../src/serve/server.ts";
import { sync } from "../src/sync/sync.ts";
import { FakeGitHub, FakeJira } from "./sync-fakes.ts";

const DIR = new URL("../tira-docs/components/", import.meta.url);

async function pages(): Promise<string> {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const d = new Dispatcher(store, registry);
  const node = (id: string, parent_id?: string) => d.submit({ stream: "t", kind: "create", entity: { type: "node", id }, actor: "isha", payload: parent_id ? { parent_id } : {} });
  const send = (id: string, event: string, payload: Record<string, unknown> = {}) => d.submit({ stream: "t", kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  await node("app");
  await node("a", "app");
  await node("b", "app");
  await send("a", "BLOCK", { reason: "waiting" });
  await send("b", "START");
  // d waits on its ticket t1 (a block that names its blocker): the blocks link
  await node("d", "app");
  await node("t1", "d");
  await send("d", "BLOCK", { reason: "waiting on t1", blocker: "t1" });
  await send("t1", "CANCEL"); // its ticket closed: "ready to unblock"
  // found while working on a, its sibling: the graph's found-while line
  await d.submit({ stream: "t", kind: "create", entity: { type: "node", id: "c" }, actor: "isha", payload: { parent_id: "app", kind: "discovered", discovered_during: "a" } });
  // ideas: one placed under app (its file approved), one waiting for its file, one whose parent a person must pick
  const idea = (id: string, summary: string, under?: string) => d.submit({ stream: "t", kind: "create", entity: { type: "idea", id }, actor: "claude", payload: { summary, why: "w", ...(under ? { under } : {}) } });
  await idea("paging", "paging for the app");
  await idea("csv", "export to csv");
  await idea("both", "a link from the app", "d"); // declared under d, its text names app
  for (const id of ["paging", "both"]) await d.submit({ stream: "t", kind: "event", entity: { type: "idea", id }, event: "APPROVE_FILE", actor: "isha", payload: {} });
  // the workspace's links, synced with stand-ins: a Jira key on each card, a pull request on b
  await d.submit({ stream: "t", kind: "create", entity: { type: "workspace", id: "workspace", version: 1 }, actor: "isha", payload: { repo: "acme/app", jira_site: "https://acme.atlassian.net", jira_project: "DOG" } });
  const github = new FakeGitHub();
  github.add({ number: 3, title: "tira: b" });
  await sync({ store, registry, stream: "t", jira: new FakeJira(), github });
  const te = await store.readStream("t");
  const staticPage = renderHtml(fold(te, registry), "t", "h", te);
  // a log from before the rules version marker, for the legacy tag
  await store.append("old", [{ type: "node.born", data: { entity: { id: "o" }, payload: {} }, metadata: { actor: "isha" } }]);
  const oe = await store.readStream("old");
  const legacyPage = renderHtml(fold(oe, registry), "old", "h", oe);
  // a factory stream, for the lanes
  await d.submit({ stream: "f", kind: "create", entity: { type: "session", id: "s1" }, actor: "s1" });
  await d.submit({ stream: "f", kind: "create", entity: { type: "brief", id: "x", version: 1 }, actor: "orchestrator" });
  await d.submit({ stream: "f", kind: "event", entity: { type: "brief", id: "x", version: 1 }, event: "DISPATCHED", actor: "orchestrator" });
  const fe = await store.readStream("f");
  const lanes = renderHtml(fold(fe, registry), "f", "h", fe);
  // a busy stream: more than 3 need you (blocked groups fold to a line) and 9 done (Done keeps its newest 8)
  const busy = (id: string, event?: string, payload: Record<string, unknown> = {}) => event === undefined
    ? d.submit({ stream: "busy", kind: "create", entity: { type: "node", id }, actor: "isha" })
    : d.submit({ stream: "busy", kind: "event", entity: { type: "node", id }, event, actor: "isha", payload });
  for (let i = 0; i < 9; i++) { await busy(`d${i}`); await busy(`d${i}`, "START"); await busy(`d${i}`, "COMPLETE", { evidenceRef: "e" }); }
  for (let i = 0; i < 4; i++) { await busy(`b${i}`); await busy(`b${i}`, "BLOCK", { reason: "waiting" }); }
  const be = await store.readStream("busy");
  const busyPage = renderHtml(fold(be, registry), "busy", "h", be);
  // the live page, a confirm page, and a result
  const server = tiraServer({ store, registry, stream: "t", actor: "isha", token: "k" });
  // with GitHub sign-in set up (a stand-in GitHub): the landing, the code step, the connect step
  // and the Integrations page; and a first run, before anything is set up
  const home = mkdtempSync(join(tmpdir(), "tira-docs-"));
  const firstHome = mkdtempSync(join(tmpdir(), "tira-docs-first-"));
  const env = { TIRA_HOME: home };
  saveAppKeys({ github: { clientId: "Iv1.docs" }, atlassian: { clientId: "docs", secret: "docs-secret" } }, env);
  saveSession("docs-session", "isha", env);
  saveAccess(() => ({ admin: "isha", contact: { name: "Isha", email: "isha@example.com" } }), env);
  const githubAuth = { start: async () => ({ deviceCode: "d", userCode: "ABCD-1234", verifyAt: "https://github.com/login/device", interval: 5, expiresIn: 900 }), poll: async () => ({ wait: 0 }), user: async () => ({ login: "x" }), repos: async () => [] };
  const signInServer = tiraServer({ store, registry, stream: "t", actor: "isha", token: "k", links: { githubAuth, env } });
  const ask = async (s: typeof server, cookie?: string) => {
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    return (method: string, path: string, body?: string) => new Promise<{ body: string; location?: string }>((resolve, reject) => {
      // as localhost (where Atlassian sends people back), signed in when a cookie is given
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `localhost:${port}`, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ body: b, ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}) }));
      });
      req.on("error", reject);
      req.end(body);
    });
  };
  const get = await ask(server);
  const getSignedOut = await ask(signInServer);
  // signed in, on a workspace linked to a repo (so the board shows, not the connect step)
  await d.submit({ stream: "w", kind: "create", entity: { type: "workspace", id: "workspace", version: 1 }, actor: "isha", payload: { repo: "acme/app" } });
  const signedInServer = tiraServer({ store, registry, stream: "w", token: "k", links: { githubAuth, env } });
  const getSignedIn = await ask(signedInServer, "tira_session=docs-session");
  const firstRunServer = tiraServer({ store, registry, stream: "t", token: "k", links: { githubAuth, env: { TIRA_HOME: firstHome } } });
  const getFirstRun = await ask(firstRunServer);
  try {
    const live = (await get("GET", "/")).body;
    const confirm = (await get("GET", "/confirm?type=node&id=b&event=COMPLETE")).body;
    // the dialog's packet alone, for an action tira would refuse (a is blocked): its hint and way out
    const fragment = (await get("GET", "/confirm?type=node&id=a&event=START&fragment=1")).body;
    // a block decision (reasons used before, as chips) and a command left without its proof
    const blockLive = (await get("GET", "/confirm?type=node&id=b&event=BLOCK&fragment=1")).body;
    // an idea's placement where a person picks the parent (its candidates as buttons)
    const pick = (await get("GET", "/confirm?type=idea&id=both&event=APPROVE_NODE&fragment=1")).body;
    const landing = (await getSignedOut("GET", "/welcome")).body + (await getFirstRun("GET", "/welcome")).body;
    const signin = (await getSignedOut("POST", "/signin/start", "token=k")).body;
    const signedIn = (await getSignedIn("GET", "/integrations")).body + (await getSignedIn("GET", "/")).body + (await getSignedIn("GET", "/connect")).body;
    const before = String((await store.readStream("t")).at(-1)?.seq);
    const stopped = (await get("POST", "/act", `token=k&type=node&id=b&event=COMPLETE&fragment=1&seen=${before}&command=${encodeURIComponent('tira send node b COMPLETE evidenceRef=""')}`)).body;
    const seen = String((await store.readStream("t")).at(-1)?.seq);
    const acted = await get("POST", "/act", `token=k&type=node&id=b&event=COMPLETE&evidenceRef=e&seen=${seen}`);
    const flash = (await get("GET", acted.location ?? "/")).body;
    const noWorkspace = (await get("GET", "/?w=nope")).body; // a project the store doesn't hold
    const script = ["app.mjs", "graph.mjs", "signin.mjs"].map((f) => readFileSync(new URL(`../src/serve/${f}`, import.meta.url), "utf8")).join("\n");
    return [staticPage, legacyPage, lanes, busyPage, live, confirm, fragment, blockLive, pick, landing, signin, signedIn, stopped, flash, noWorkspace, script].join("\n");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => signInServer.close(() => r()));
    await new Promise<void>((r) => signedInServer.close(() => r()));
    await new Promise<void>((r) => firstRunServer.close(() => r()));
    rmSync(home, { recursive: true, force: true });
    rmSync(firstHome, { recursive: true, force: true });
  }
}

// Exact names only: [data-att] must not pass on data-attention-count, .att not on att-row.
const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const present = (hook: string, text: string): boolean => {
  if (hook.startsWith("[data-") && hook.endsWith("]")) {
    const name = hook.slice(1, -1);
    return new RegExp(`\\s${name}(?=[=\\s>])`).test(text) || text.includes(`dataset.${camel(name.slice(5))} `) || text.includes(`dataset.${camel(name.slice(5))}=`);
  }
  if (hook.startsWith("#")) return text.includes(`id="${hook.slice(1)}"`) || text.includes(`.id = "${hook.slice(1)}"`);
  if (hook.startsWith(".")) return new RegExp(`class="(?:[^"]*\\s)?${hook.slice(1)}(?=[\\s"])`).test(text) || text.includes(`className = "${hook.slice(1)}"`);
  return false;
};

test("every component doc says its job and names hooks; every hook exists in the build", async () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(files, ["attention-section.md", "board-view.md", "command-palette.md", "confirm-page.md", "hash-chip.md", "ideas.md", "integrations-page.md", "lanes-view.md", "node-drawer.md", "onboarding.md", "project-switch.md", "theme-switch.md", "welcome.md", "workspace-bar.md"]);
  const built = await pages();
  for (const f of files) {
    const doc = readFileSync(new URL(f, DIR), "utf8");
    assert.match(doc, /^\*\*JTBD:\*\* \d+ — /m, `${f}: names its job`);
    assert.match(doc, /^\*\*Falsifier\.\*\* /m, `${f}: names its falsifier`);
    const section = /## Devtool hook\n([^]*?)(?:\n\*\*Falsifier|\n## |$)/.exec(doc)?.[1] ?? "";
    const named = [...section.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    // a bare data-* name in backticks is a hook written wrong: say so instead of skipping it
    for (const h of named) assert.ok(!/^data-[a-z-]+$/.test(h), `${f}: write ${h} as [${h}]`);
    const hooks = named.filter((h) => /^(\[data-[a-z-]+\]|#[a-z0-9-]+|\.[a-z][a-z0-9-]*)$/.test(h));
    assert.ok(hooks.length > 0, `${f}: names at least one hook`);
    for (const h of hooks) assert.ok(present(h, built), `${f}: ${h} is not in the build`);
  }
});
