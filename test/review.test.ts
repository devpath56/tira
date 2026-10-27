// Work types and review before done (src/fold/kinds.ts, src/serve/review.ts; Isha, 2026-10-26):
// a task's work type says what its proof looks like (tira guesses, a person or agent sets it); a task a
// person marked for review asks Muse first when it's completed, whose problems become fix subtasks
// that keep the task open; a person can complete it without review, and has the final word after a
// few rounds. Files people add (a comment's, or a proof) are kept apart and shown as themselves.
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { fold } from "../src/fold/fold.ts";
import { tiraServer } from "../src/serve/server.ts";
import { commentsOf, ticketsOf } from "../src/fold/tickets.ts";
import { flatten, streamView } from "../src/render/tree-view.ts";
import { guessKind, KINDS, kindOf, PROOF_FOR } from "../src/fold/kinds.ts";
import { MAX_ROUNDS, MUSE_MODEL, MUSE_URL, museReviewer, REVIEWER, reviewInput, reviewKey, verdictOf, type ReviewAsk, type Verdict } from "../src/serve/review.ts";
import { completeTask } from "../src/mcp/actions.ts";

const S = "linkedin";

test("tira guesses a task's kind from its words, code when nothing says otherwise; a kind set on the ticket wins; every kind says what its proof is", () => {
  assert.equal(guessKind("Create spec for LinkedIn job postings"), "spec");
  assert.equal(guessKind("decide_v1_scope: answer the spec's decisions"), "spec"); // a tie goes to the earlier kind
  assert.equal(guessKind("Set up LinkedIn job alerts"), "ops");
  assert.equal(guessKind("build_alert_reader"), "code");
  assert.equal(guessKind("Run the backfill against the success metrics"), "data");
  assert.equal(guessKind("Wireframe the onboarding in Figma"), "design");
  assert.equal(guessKind("loading_state"), "code"); // no word for any kind: code, as tira's work always was
  assert.equal(guessKind("the latest numbers"), "code"); // "latest" isn't "test"
  assert.deepEqual(kindOf("x", { kind: "research", title: "Build it" }), { kind: "research", guessed: false });
  assert.deepEqual(kindOf("build_it", undefined), { kind: "code", guessed: true });
  assert.deepEqual(kindOf("x", { kind: "nonsense" }), { kind: "code", guessed: true }); // not a kind: guessed again
  for (const k of KINDS) assert.ok(PROOF_FOR[k].length > 10, k);
});

const ask: ReviewAsk = { key: "TIRA_LINKEDIN_2", title: "Decide v1 scope", kind: "spec", proofFor: PROOF_FOR.spec, description: "Answer the spec's six decisions.", steps: ["Read the spec", "Answer the decisions"], proof: "https://claude.ai/artifact/abc", proofDetail: "", comments: ["isha: keep contract roles out"] };

test("the reviewer reads the ticket, its kind and what its proof should be, the proof given and the latest comments", () => {
  const said = reviewInput(ask);
  assert.match(said, /^Task TIRA_LINKEDIN_2: Decide v1 scope\n\nWork type: spec\. Proof for it should be a link to the work \(a Claude artifact/);
  assert.match(said, /Steps:\n1\. Read the spec\n2\. Answer the decisions/);
  assert.match(said, /Proof given: https:\/\/claude\.ai\/artifact\/abc/);
  assert.match(said, /Latest comments:\nisha: keep contract roles out$/);
  assert.equal(reviewKey({ TIRA_MODEL_API_KEY: " k1 " }), "k1");
  assert.equal(reviewKey({ MODEL_API_KEY: "k2" }), "k2");
  assert.equal(reviewKey({}), undefined);
});

test("a verdict is read strictly: pass with no findings, changes with some (five at most), or not an answer", () => {
  const changes = (n: number) => JSON.stringify({ verdict: "changes", summary: "Half done.", findings: Array.from({ length: n }, (_, i) => ({ title: `Problem ${i}`, why: "it matters", fix: "do it" })) });
  assert.deepEqual(verdictOf(JSON.stringify({ verdict: "pass", summary: "Done as asked.", findings: [] }), 900), { ok: true, pass: true, summary: "Done as asked.", findings: [], tokens: 900 });
  const many = verdictOf(changes(8), 1);
  assert.equal(many.ok && many.findings.length, 5);
  for (const bad of ["not json", JSON.stringify({ verdict: "pass", summary: "x", findings: [{ title: "a", why: "b", fix: "c" }] }), changes(0), JSON.stringify({ verdict: "maybe", summary: "x", findings: [] })]) {
    assert.deepEqual(verdictOf(bad, 1), { ok: false, why: "its answer wasn't the verdict it was asked for" }, bad);
  }
});

test("Muse is asked through the Meta Model API: one chat completion, held to the verdict's shape; its refusals say why", async () => {
  const was = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { choices: [{ message: { content: JSON.stringify({ verdict: "pass", summary: "Good.", findings: [] }) } }], usage: { total_tokens: 1234 } } };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  try {
    assert.deepEqual(await museReviewer("mk")(ask), { ok: true, pass: true, summary: "Good.", findings: [], tokens: 1234 });
    assert.equal(calls[0]?.url, MUSE_URL);
    assert.deepEqual(calls[0]?.init.headers, { Authorization: "Bearer mk", "Content-Type": "application/json" });
    const body = JSON.parse(String(calls[0]?.init.body)) as { model: string; messages: { role: string; content: string }[]; response_format: { type: string; json_schema: { name: string; strict: boolean } }; reasoning_effort: string };
    assert.equal(body.model, MUSE_MODEL);
    assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
    assert.match(body.messages[0]?.content ?? "", /adversarial reviewer/);
    assert.deepEqual([body.response_format.type, body.response_format.json_schema.name, body.response_format.json_schema.strict], ["json_schema", "Review", true]);
    assert.notEqual(body.reasoning_effort, "none"); // Muse always reasons: "none" is refused
    answer = { status: 401, body: {} };
    assert.deepEqual(await museReviewer("mk")(ask), { ok: false, why: "the Meta Model API key was refused" });
    answer = { status: 429, body: {} };
    assert.deepEqual(await museReviewer("mk")(ask), { ok: false, why: "the Meta Model API is busy or out of quota" });
  } finally {
    globalThis.fetch = was;
  }
});

// tira serve on this computer: a spec task in progress, and a reviewer stood in for Muse
async function served(answers: Verdict[]) {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  for (const [id, title] of [["decide_scope", "Decide v1 scope: answer the spec's decisions"], ["write_notes", "Write the research notes"]] as const) {
    await wp.submit({ stream: S, kind: "create", entity: { type: "node", id }, actor: "isha", payload: {} });
    await wp.submit({ stream: S, kind: "create", entity: { type: "ticket", id, version: 1 }, actor: "isha", payload: { task: id, title, ...(id === "decide_scope" ? { review: true } : {}) } });
  }
  await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "decide_scope" }, event: "START", actor: "isha", payload: {} });
  const asked: ReviewAsk[] = [];
  const reviewer = async (a: ReviewAsk) => {
    asked.push(a);
    return answers.shift() ?? { ok: false as const, why: "no answer left" };
  };
  const server = tiraServer({ store, registry, stream: S, actor: "isha", token: "k", links: { reviewer } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const http = (method: string, path: string, body?: string) => new Promise<{ status: number; body: string; location?: string }>((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${port}` }) };
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b, ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}) }));
    });
    req.on("error", reject);
    req.end(body);
  });
  // the dialog's Complete, as the page posts it; the board's result after it
  const complete = async (id: string, proof: string, more: Record<string, string> = {}) => {
    const seen = String((await store.readStream(S)).at(-1)?.seq ?? 0);
    const r = await http("POST", "/act", new URLSearchParams({ token: "k", type: "node", id, event: "COMPLETE", proofRef: proof, dialog: "1", seen, ...more }).toString());
    const page = r.location ? (await http("GET", r.location)).body : r.body;
    return /data-flash>([^<]*)</.exec(page)?.[1] ?? r.body;
  };
  const state = async () => {
    const r = fold(await store.readStream(S), registry);
    return { rows: flatten(streamView(r, S).roots), tickets: ticketsOf(r, S), comments: commentsOf(r, S) };
  };
  // a file as the page's script sends it (its bytes as the body), and one read back whole
  const raw = (path: string, body: Buffer, headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject);
    req.end(body);
  });
  const get = (path: string) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; bytes: Buffer }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(parts) }));
    }).on("error", reject).end();
  });
  return { wp, store, asked, http, raw, get, complete, state, done: () => new Promise<void>((r) => server.close(() => r())) };
}

test("completing a task asks Muse first: its problems are fix subtasks that keep the task open; fixed, it's reviewed again and done", async () => {
  const s = await served([
    { ok: true, pass: false, summary: "Two decisions are still open.", tokens: 2100, findings: [{ title: "Decide remote roles", why: "Decision 3 isn't answered", fix: "Say yes or no" }, { title: "Set target levels", why: "Decision 2 is missing", fix: "Name the levels" }] },
    { ok: true, pass: true, summary: "All six answered.", findings: [], tokens: 1500 },
  ]);
  try {
    // a spec: its proof is a link, and the dialog says so (no GitHub check), with Complete without review
    const dialog = (await s.http("GET", "/confirm?type=node&id=decide_scope&event=COMPLETE&fragment=1")).body;
    assert.match(dialog, /placeholder="A link to the work, or attach a file…"/);
    assert.doesNotMatch(dialog, /data-proof-check|proof-kind/);
    assert.match(dialog, /<div class="proof-attach" data-proof-attach="\/files\?task=decide_scope"><label class="act attach-btn"><input type="file" hidden data-proof-file>/);
    assert.match(dialog, /<label class="field-check" data-skip-review><input type="checkbox" name="skip_review" value="1"> Complete it without Muse(?:'|&#39;)s review: your call<\/label>/);
    // first review: changes asked; two fix subtasks under it, as the reviewer, found while reviewing it
    assert.equal(await s.complete("decide_scope", "https://claude.ai/artifact/abc"), "Muse found 2 problems: fix subtasks are under decide_scope. Complete it once they&#39;re closed, and Muse reviews it again.");
    assert.equal(s.asked[0]?.kind, "spec");
    assert.equal(s.asked[0]?.proof, "https://claude.ai/artifact/abc");
    let now = await s.state();
    assert.equal(now.rows.find((x) => x.id === "decide_scope")?.state, "in_progress"); // still open
    const fixes = now.rows.find((x) => x.id === "decide_scope")?.children ?? [];
    assert.deepEqual(fixes.map((x) => [x.id, x.discoveredDuring]), [["fix_decide_remote_roles", "node:decide_scope"], ["fix_set_target_levels", "node:decide_scope"]]);
    assert.deepEqual(fixes.map((x) => now.tickets.get(x.id)?.title), ["Decide remote roles", "Set target levels"]);
    assert.equal(now.tickets.get("fix_decide_remote_roles")?.description, "Decision 3 isn't answered\n\nFix: Say yes or no");
    assert.deepEqual(fixes.map((x) => now.tickets.get(x.id)?.review), [true, true]); // each fix is reviewed too
    const said = now.comments.get("decide_scope") ?? [];
    assert.equal(said.at(-1)?.by, REVIEWER);
    assert.match(said.at(-1)?.text ?? "", /^Review: changes asked\. Two decisions are still open\.\n\n1\. Decide remote roles: Decision 3 isn(?:'|’)t answered\n2\. Set target levels[^]*\(2,100 tokens\)$/);
    // while the fixes are open, tira's own rule refuses completing it: no review is asked for
    assert.match(await s.complete("decide_scope", "https://claude.ai/artifact/abc"), /refused|close|subtask/i);
    assert.equal(s.asked.length, 1);
    // fixed: reviewed again, passed, done
    for (const id of ["fix_decide_remote_roles", "fix_set_target_levels"]) {
      await s.wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event: "START", actor: "isha", payload: {} });
      await s.wp.submit({ stream: S, kind: "event", entity: { type: "node", id }, event: "COMPLETE", actor: "isha", payload: { evidenceRef: "answered in the spec" } });
    }
    assert.match(await s.complete("decide_scope", "https://claude.ai/artifact/abc"), /done[^]*Muse reviewed it: passed\./);
    now = await s.state();
    assert.equal(now.rows.find((x) => x.id === "decide_scope")?.state, "done");
    assert.equal((now.comments.get("decide_scope") ?? []).at(-1)?.text, "Review: passed. All six answered. (1,500 tokens)");
  } finally {
    await s.done();
  }
});

test("a person has the final say: complete without review; a review that can't run says so and writes nothing; after a few rounds, only a person decides", async () => {
  const changes: Verdict = { ok: true, pass: false, summary: "Not yet.", tokens: 10, findings: [{ title: "Add sources", why: "None cited", fix: "Cite them" }] };
  const s = await served([{ ok: false, why: "the Meta Model API is busy or out of quota" }]);
  try {
    assert.equal(await s.complete("decide_scope", "https://claude.ai/artifact/abc"), "The review couldn&#39;t run: the Meta Model API is busy or out of quota. Try again, or complete it without review.");
    assert.equal((await s.state()).rows.find((x) => x.id === "decide_scope")?.state, "in_progress");
    // her call: done, no review asked for, and said so on the task
    assert.match(await s.complete("decide_scope", "https://claude.ai/artifact/abc", { skip_review: "1" }), /done/);
    const now = await s.state();
    assert.equal(now.rows.find((x) => x.id === "decide_scope")?.state, "done");
    assert.equal((now.comments.get("decide_scope") ?? []).at(-1)?.text, "Completed without review: isha's call.");
    assert.equal(s.asked.length, 1);
  } finally {
    await s.done();
  }
  // a task Muse sent back MAX_ROUNDS times: an agent is told a person decides; nothing is asked or written
  const t = await served(Array.from({ length: MAX_ROUNDS }, () => changes));
  try {
    for (let i = 0; i < MAX_ROUNDS; i++) {
      await t.complete("decide_scope", "https://claude.ai/artifact/abc");
      for (const x of ((await t.state()).rows.find((r) => r.id === "decide_scope")?.children ?? []).filter((r) => r.state === "unstarted")) {
        await t.wp.submit({ stream: S, kind: "event", entity: { type: "node", id: x.id }, event: "CANCEL", actor: "isha", payload: {} });
      }
    }
    const before = (await t.store.readStream(S)).length;
    const agent = await completeTask({ store: t.store, registry: defaultRegistry(), stream: S, actor: "claude-code", reviewFirst: async () => ({ go: false, text: `Muse has asked for changes ${MAX_ROUNDS} times: a person decides now.` }) }, "decide_scope", "https://claude.ai/artifact/abc");
    assert.deepEqual(agent, { ok: false, text: `Muse has asked for changes ${MAX_ROUNDS} times: a person decides now. Nothing else was written.` });
    assert.equal((await t.store.readStream(S)).length, before);
    assert.equal(await t.complete("decide_scope", "https://claude.ai/artifact/abc"), `Muse has asked for changes ${MAX_ROUNDS} times: complete it without review if it&#39;s done.`);
    assert.equal(t.asked.length, MAX_ROUNDS);
  } finally {
    await t.done();
  }
});

test("an agent's complete_task: a link proves work that isn't code; Muse's word comes back with the result", async () => {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "write_spec" }, actor: "isha", payload: {} });
  await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "write_spec" }, event: "START", actor: "isha", payload: {} });
  const passed = await completeTask({ store, registry, stream: S, actor: "claude-code", reviewFirst: async () => ({ go: true, note: " Muse reviewed it: passed." }) }, "write_spec", "https://claude.ai/artifact/xyz");
  assert.equal(passed.ok, true);
  assert.match(passed.text, /Muse reviewed it: passed\.$/);
  const last = (await store.readStream(S)).at(-1);
  assert.deepEqual([last?.type, (last?.data.payload as { evidenceRef?: string }).evidenceRef], ["node.complete", "https://claude.ai/artifact/xyz"]);
  // a task whose subtasks are open isn't reviewed: tira's rules refuse completing it anyway
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "draft_the_spec" }, actor: "isha", payload: {} });
  await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "draft_the_spec" }, event: "START", actor: "isha", payload: {} });
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "fix_plan" }, actor: "muse-review-bot", payload: { parent_id: "draft_the_spec", kind: "discovered", discovered_during: "draft_the_spec" } });
  let asked = 0;
  const held = await completeTask({ store, registry, stream: S, actor: "claude-code", reviewFirst: async () => { asked += 1; return { go: true, note: "" }; } }, "draft_the_spec", "https://claude.ai/artifact/plan");
  assert.equal(held.ok, false);
  assert.equal(asked, 0);
  // code is still proven by a commit or a pull request: a link alone isn't taken
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "build_api" }, actor: "isha", payload: {} });
  await wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "build_api" }, event: "START", actor: "isha", payload: {} });
  const linked = await completeTask({ store, registry, stream: S, actor: "claude-code" }, "build_api", "https://example.com/it-works");
  assert.equal(linked.ok, false);
  assert.match(linked.text, /build_api has no commits yet/);
});

test("only a task a person marked for review asks Muse: the switch on its ticket turns it on and off, and an agent's edit keeps it", async () => {
  const s = await served([{ ok: true, pass: true, summary: "Fine.", findings: [], tokens: 5 }]);
  try {
    // not marked: done without asking, and its dialog offers no skipping (one task at a time: the
    // marked one is finished first, outside the page)
    await s.wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "decide_scope" }, event: "COMPLETE", actor: "isha", payload: { evidenceRef: "https://claude.ai/artifact/abc" } });
    await s.wp.submit({ stream: S, kind: "event", entity: { type: "node", id: "write_notes" }, event: "START", actor: "isha", payload: {} });
    assert.doesNotMatch((await s.http("GET", "/confirm?type=node&id=write_notes&event=COMPLETE&fragment=1")).body, /data-skip-review/);
    assert.match(await s.complete("write_notes", "https://docs.example.com/notes"), /^Complete write_notes: done/);
    assert.equal((await s.state()).rows.find((x) => x.id === "write_notes")?.state, "done");
    assert.equal(s.asked.length, 0);
    // the side panel: its work type and the review switch, no proof line
    const page = (await s.http("GET", "/")).body;
    assert.match(page, /<span class="lk">Work type<\/span><div><select name="kind"[^>]*aria-label="Work type" data-save-on-change>/);
    assert.match(page, /<input type="hidden" name="review_set" value="1" form="tk-\d+"><label class="switch"><input type="checkbox" role="switch" name="review" value="1" form="tk-\d+" checked data-save-on-change/);
    assert.match(page, /Muse checks it before done/);
    assert.doesNotMatch(page, /data-kind-proof|Add the first step/);
    // the switch, saved: on; an agent's fill_ticket keeps it; a form without the switch keeps it; off
    await s.wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "outline_talk" }, actor: "isha", payload: {} });
    const save = (fields: Record<string, string>) => s.http("POST", "/tickets", new URLSearchParams({ token: "k", task: "outline_talk", title: "Outline the talk", ...fields }).toString());
    const review = async () => (await s.state()).tickets.get("outline_talk")?.review;
    // the page's script saves it in place: what happened, as JSON, no trip back to the board
    const inPlace = await save({ review_set: "1", review: "1", description: "- one\n- **two**", fragment: "1" });
    assert.equal(inPlace.status, 200);
    assert.equal(inPlace.location, undefined);
    const got = JSON.parse(inPlace.body) as { ok: boolean; text: string; seq: number; desc: string };
    assert.deepEqual([got.ok, got.text, Number.isSafeInteger(got.seq), got.desc], [true, "Saved.", true, "<ul><li>one</li><li><strong>two</strong></li></ul>"]);
    assert.equal(await review(), true);
    assert.deepEqual(JSON.parse((await save({ estimate_n: "soon", fragment: "1" })).body).ok, false); // why not, in place too
    const { fillTicket } = await import("../src/mcp/actions.ts");
    await fillTicket({ store: s.store, registry: defaultRegistry(), stream: S, actor: "claude-code" }, "outline_talk", { description: "Three parts." });
    assert.equal(await review(), true);
    await save({ description: "Three parts, ten minutes." });
    assert.equal(await review(), true);
    await save({ review_set: "1", description: "Three parts, ten minutes." });
    assert.equal(await review(), undefined);
  } finally {
    await s.done();
  }
});

test("files: a picture, a PDF or a document goes up for a task and comes back as itself; a comment names it; it can be a task's proof", async () => {
  const s = await served([{ ok: true, pass: true, summary: "The screenshot shows it.", findings: [], tokens: 7 }]);
  try {
    const send = (path: string, body: Buffer, headers: Record<string, string>) => s.raw(path, body, headers);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
    const up = await send("/files?task=decide_scope", png, { "x-tira-token": "k", "x-file-name": encodeURIComponent("my shot.png") });
    assert.equal(up.status, 200);
    const meta = JSON.parse(up.body) as { id: string; name: string; type: string; size: number };
    assert.match(meta.id, /^[0-9a-f]{24}$/);
    assert.deepEqual([meta.name, meta.type, meta.size], ["my shot.png", "image/png", png.length]);
    // back as itself: shown, never run
    const got = await s.get(`/file?id=${meta.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers["content-type"], "image/png");
    assert.equal(got.headers["x-content-type-options"], "nosniff");
    assert.match(String(got.headers["content-security-policy"]), /default-src 'none'.*sandbox/);
    assert.match(String(got.headers["content-disposition"]), /^inline; filename\*=UTF-8''my%20shot\.png$/);
    assert.ok(got.bytes.equals(png));
    assert.equal((await s.get("/file?id=0123456789abcdef01234567")).status, 404);
    assert.equal((await s.get(`/file?id=${meta.id}&w=another`)).status, 404); // only its own project's
    // refused: a page or a script, too big, no token, another site, a task that isn't here
    assert.equal((await send("/files?task=decide_scope", Buffer.from("<script>"), { "x-tira-token": "k", "x-file-name": "page.html" })).status, 415);
    assert.equal((await send("/files?task=decide_scope", Buffer.alloc(5 * 1024 * 1024 + 1), { "x-tira-token": "k", "x-file-name": "big.pdf" })).status, 413);
    assert.equal((await send("/files?task=decide_scope", png, { "x-tira-token": "nope", "x-file-name": "a.png" })).status, 403);
    assert.equal((await send("/files?task=decide_scope", png, { "x-tira-token": "k", "x-file-name": "a.png", origin: "https://evil.example" })).status, 403);
    assert.equal((await send("/files?task=nothing_here", png, { "x-tira-token": "k", "x-file-name": "a.png" })).status, 404);
    // a comment with the file and no words: the comment names it, and the dialog shows the picture
    await s.http("POST", "/comments", new URLSearchParams([["token", "k"], ["task", "decide_scope"], ["text", ""], ["file", meta.id]]).toString());
    const said = ((await s.state()).comments.get("decide_scope") ?? []).at(-1);
    assert.deepEqual(said?.files, [meta]);
    assert.match((await s.http("GET", "/")).body, new RegExp(`<a class="cm-img" href="/file\\?id=${meta.id}"[^>]*><img src="/file\\?id=${meta.id}" alt="my shot.png" loading="lazy"></a>`));
    // the page's script adds one in place: what happened, and the comment as the thread shows it
    const placed = await s.http("POST", "/comments", new URLSearchParams([["token", "k"], ["task", "decide_scope"], ["text", "- looks right"], ["fragment", "1"]]).toString());
    assert.equal(placed.location, undefined);
    const cm = JSON.parse(placed.body) as { ok: boolean; text: string; seq: number; item: string };
    assert.deepEqual([cm.ok, cm.text, Number.isSafeInteger(cm.seq)], [true, "Comment added.", true]);
    assert.match(cm.item, /^<li class="cm" data-comment><span class="cm-av" aria-hidden="true">IS<\/span><div class="cm-card"><div class="cm-h"><b>isha<\/b>[^]*<div class="cm-body"><ul><li>looks right<\/li><\/ul><\/div><\/div><\/li>$/);
    assert.equal(JSON.parse((await s.http("POST", "/comments", new URLSearchParams([["token", "k"], ["task", "decide_scope"], ["text", " "], ["fragment", "1"]]).toString())).body).ok, false);
    // a file of another task isn't this comment's
    const other = JSON.parse((await send("/files?task=write_notes", png, { "x-tira-token": "k", "x-file-name": "notes.png" })).body) as { id: string };
    const before = ((await s.state()).comments.get("decide_scope") ?? []).length;
    await s.http("POST", "/comments", new URLSearchParams([["token", "k"], ["task", "decide_scope"], ["text", "see"], ["file", other.id]]).toString());
    assert.equal(((await s.state()).comments.get("decide_scope") ?? []).length, before);
    // another task's file isn't this one's proof: nothing written, nothing asked
    await s.complete("decide_scope", `file:${other.id}`);
    assert.equal((await s.state()).rows.find((x) => x.id === "decide_scope")?.state, "in_progress");
    assert.equal(s.asked.length, 0);
    // the screenshot as the proof of work that isn't code: Muse is told what it is
    assert.match(await s.complete("decide_scope", `file:${meta.id}`), /done[^]*passed/);
    assert.equal(s.asked[0]?.proofDetail, `A file added to the task: my shot.png (image/png, ${png.length} B)`);
    const last = (await s.store.readStream(S)).filter((e) => e.type === "node.complete").at(-1);
    assert.equal((last?.data.payload as { evidenceRef?: string }).evidenceRef, `file:${meta.id}`);
  } finally {
    await s.done();
  }
});

test("words read as they're meant: lines starting '- ' or '1. ' are a list, **bold**, *italic* and `code` show as such, links and mentions still work", async () => {
  const { richHtml } = await import("../src/render/html.ts");
  assert.equal(richHtml("Done:\n- fixed **the** form\n- added `a test`\n\n1. one\n2. two"), "<p>Done:</p><ul><li>fixed <strong>the</strong> form</li><li>added <code>a test</code></li></ul><ol><li>one</li><li>two</li></ol>");
  assert.equal(richHtml("see *this* in contact_form, @isha"), '<p>see <em>this</em> in contact_form, <span class="mention" data-mention="isha">@isha</span></p>');
  assert.equal(richHtml("2 * 3 * 4 and snake_case_name"), "<p>2 * 3 * 4 and snake_case_name</p>"); // not marks
});
