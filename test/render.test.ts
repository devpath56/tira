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
// improve_visual drains (done, cancelled, done); table is in progress (active);
// a START on filters is rejected by the one-active gate.
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
  return fold(await store.readStream(S), registry);
}

const attrs = (html: string) =>
  [...html.matchAll(/data-key="([^"]+)" data-state="([^"]+)" data-drained="(true|false)" data-cursor="(true|false)" data-active="(true|false)" data-depth="(\d+)"/g)]
    .map(([, key, state, drained, cursor, active, depth]) => ({ key, state, drained: drained === "true", cursor: cursor === "true", active: active === "true", depth: Number(depth) }));

test("M1 oracle: the page shows every fold node exactly once, with the fold's flags", async () => {
  const r = await scenario();
  const hash = createHash("sha256").update(canonicalJson(r)).digest("hex");
  const html = renderHtml(r, S, hash);
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
  assert.deepEqual(nodes.filter((n) => n.drained).map((n) => n.key), ["node:improve_visual"]);
  assert.deepEqual(nodes.filter((n) => n.active).map((n) => n.key), ["node:table"]);
  assert.deepEqual(nodes.filter((n) => n.cursor).map((n) => n.key), ["node:improve_visual"]);
  assert.match(html, /<li>1 drained<\/li>/);
  assert.match(html, /<span class="mark drained">drained<\/span>/);
  assert.match(html, new RegExp(`data-node-count="${tree.length}" data-fold-tree-count="${tree.length}"`));
  assert.match(html, new RegExp(`data-dump-hash="${hash}"`));
  assert.match(html, /one active task: node:table is already active/); // the rejection is shown
  assert.match(html, /idea:7/); // non-tree entities are listed too
});

test("render is deterministic and escapes every user-supplied string", async () => {
  const r = await scenario();
  assert.equal(renderHtml(r, S, "h"), renderHtml(r, S, "h"));
  const X = `<script>x</script>`;
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  const stream = `tasktree-${X}`;
  await wp.submit({ stream, kind: "create", entity: { type: "node", id: X }, actor: "isha" });
  await wp.submit({ stream, kind: "create", entity: { type: "node", id: `${X}2` }, actor: "isha", payload: { parent_id: X, kind: "discovered", discovered_during: X } });
  await wp.submit({ stream, kind: "event", entity: { type: "node", id: X }, event: "COMPLETE", actor: "isha" }); // rejection detail echoes the id
  await wp.submit({ stream, kind: "create", entity: { type: "idea", id: X }, actor: "isha" }); // other-entities table
  const html = renderHtml(fold(await store.readStream(stream), registry), stream, "h");
  assert.ok(!html.includes("<script"), "an unescaped <script> reached the page");
  assert.ok(html.split("&#60;script&#62;").length - 1 >= 6); // id, title, stream, found-during, rejection, idea
});

test("text tree: nesting, markers, and the same flags as the page", async () => {
  const r = await scenario();
  const lines = textTree(streamView(r, S));
  const text = lines.join("\n");
  assert.match(lines[0] ?? "", /cursor node:improve_visual · active node:table$/);
  assert.match(text, /^├─ metrics_card\s+unstarted$/m);
  assert.match(text, /^│  └─ improve_visual\s+unstarted\s+◆ cursor {2}drained$/m);
  assert.match(text, /^│     ├─ font\s+cancelled$/m);
  assert.match(text, /^│     └─ tokens\s+done\s+found during colors$/m);
  assert.match(text, /^├─ table\s+in_progress ● active$/m);
  const empty = textTree(streamView(r, "tasktree-none"));
  assert.match(empty.join("\n"), /no tree yet/);
});
