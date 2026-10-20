// tira-docs/components/*.md: every DOM hook a component doc names under "Devtool hook"
// exists in a rendered page (static, live, a confirm page, a factory page) or in the
// palette's script, so the docs can't drift from the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { Dispatcher } from "../src/write/dispatcher.ts";
import { fold } from "../src/fold/fold.ts";
import { renderHtml } from "../src/render/html.ts";
import { tiraServer } from "../src/serve/server.ts";

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
  // the live page, a confirm page, and a result
  const server = tiraServer({ store, registry, stream: "t", actor: "isha", token: "k" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const get = (method: string, path: string, body?: string) => new Promise<{ body: string; location?: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ body: b, ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}) }));
    });
    req.on("error", reject);
    req.end(body);
  });
  try {
    const live = (await get("GET", "/")).body;
    const confirm = (await get("GET", "/confirm?type=node&id=b&event=COMPLETE")).body;
    const seen = String((await store.readStream("t")).at(-1)?.seq);
    const acted = await get("POST", "/act", `token=k&type=node&id=b&event=COMPLETE&evidenceRef=e&seen=${seen}`);
    const flash = (await get("GET", acted.location ?? "/")).body;
    const script = readFileSync(new URL("../src/serve/app.mjs", import.meta.url), "utf8");
    return [staticPage, legacyPage, lanes, live, confirm, flash, script].join("\n");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
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
  assert.deepEqual(files, ["attention-section.md", "command-palette.md", "confirm-page.md", "hash-chip.md", "lanes-view.md", "node-drawer.md", "onboarding.md", "progress-train.md", "theme-switch.md"]);
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
