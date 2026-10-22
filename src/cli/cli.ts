// tira CLI — a manual-testing rig for the Phase 1 core until the lean UI exists.
// Every write goes through the guarded WritePath; every read is a fold. The CLI
// never touches state directly, so what you see here is what the core decides.
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHtml, type DivergencePanel } from "../render/html.ts";
import { streamView, textTree } from "../render/tree-view.ts";
import { liveDatabase, openStore, type ClosableStore } from "../store/open.ts";
import { ImportRefused } from "../store/postgres-store.ts";
import { SqliteEventStore } from "../store/sqlite-store.ts";
import { defaultRegistry, type Registry } from "../tables/registry.ts";
import { checkCommand, type Command, type WriteResult } from "../write/write-path.ts";
import { Dispatcher, type HandoffWrite } from "../write/dispatcher.ts";
import { fxKey, transitionOf } from "../write/fxkey.ts";
import { isIsoTime } from "../time.ts";
import { sweep } from "../sweep/sweep.ts";
import { tiraServer } from "../serve/server.ts";
import { divergence, FX, VERDICTS, type Coordinates, type DivergenceReport, type FactoryRecord } from "../divergence/divergence.ts";
import { canonicalJson, fingerprint, fold, type FoldOptions, type FoldResult } from "../fold/fold.ts";
import { compareCodeUnits } from "../fold/view.ts";
import { REJECTED, tableEventName, type EventData, type RejectedData } from "../fold/events.ts";
import type { StoredEvent } from "../store/types.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
  // tests only: their own throwaway store for a --db value (live, tira opens Postgres only)
  openStore?: (db: string) => ClosableStore;
}

export const HELP = `tira — manual-testing CLI for the Phase 1 core

Usage:
  tira types                                      entity types, their states and events
  tira create <type> <id> [--parent P] [k=v ...]  create an entity          e.g. tira create node colors --parent improve_visual
  tira send <type> <id> <EVENT> [key=value ...]   send an event             e.g. tira send node colors COMPLETE evidenceRef=palette.png
  tira log                                        the raw event log, in seq order (rejections included)
  tira state [--at N] [--now ISO] [--vantage V]   derived state, plus rejections and anomalies
  tira replay <N>                                 state as of event N (same as: tira state --at N)
  tira tree [--at N]                              the tree with cursor (◆), active task (●) and drain flags
  tira render [--out FILE] [--at N] [--factory FILE]
                                                  write the read-only HTML page (D1); reload it after re-rendering.
                                                  Its divergence section is computed in this run from the factory
                                                  file and the events the page shows; no factory file, or one that
                                                  cannot be read, renders it UNEVALUABLE
  tira dump [--at N] [--hash]                     full derived state as canonical JSON (same log => same bytes);
                                                  --hash prints its sha256 instead
  tira key <type> <id> [EVENT] [key=value ...]    the fx: event id a factory transition uses (B2): the same
                                                  flags as send; no EVENT means a birth (e.g. drop.filed)
  tira sweep [--at N] [--json]                    health checks: orphans, loops, parent/child links, counts,
                                                  depths, closed parents with open work; plus tasks with no
                                                  definition or done criteria, and finished branches that
                                                  grew new work. Exits 3 when something is broken
  tira serve --actor NAME [--port N] [--factory FILE]
                                                  the page, live, on 127.0.0.1 only (default port 4747): needs
                                                  attention, ⌘K search, and start / unblock / complete / block /
                                                  cancel / reopen / add subtask, each through a decision dialog,
                                                  written as NAME; the divergence section is recomputed on every
                                                  page load. Ctrl-C stops it
  tira import <file.db>                           copy an old SQLite log into the Postgres database, once: every
                                                  event as it was, into an empty schema; a re-run adds nothing.
                                                  Each stream's fingerprint must match before and after
  tira divergence --factory FILE [--tira-log FILE] [--stream NAME] [--json]
                                                  the factory's file state against tira's log, one verdict per
                                                  fx: event id (B3): OK, MISSING, PHANTOM, WRONG-ENTITY,
                                                  DUPLICATE, ORPHAN. tira's side is the store's --stream;
                                                  --tira-log reads a log file instead (fixtures, tests). A live
                                                  run hashes the bytes it read and records that sha256; a
                                                  FILE.sha256 beside it is optional, but one that disagrees
                                                  refuses the run; appends one row to docs/divergence-run-log.jsonl;
                                                  --json prints the per-id verdict map with the report

Options:
  --db URL         the database: a postgres:// connection string (default: $TIRA_DATABASE_URL). tira keeps its
                   data in Postgres only; a SQLite file is refused. Put the string in $TIRA_DATABASE_URL (or the
                   repo's .env), not on the command line. A database on another machine needs ?sslmode=require.
                   $TIRA_SCHEMA picks a schema in it (default "tira"): a demo or a trial of its own
  --stream NAME    stream / tree (default: $TIRA_STREAM, else tasktree-main)
  --actor NAME     who is acting, for create/send (default: $TIRA_ACTOR)
  --version N      entity version (versioned entity types only)
  --event-id ID    idempotency key: re-sending the same command returns "duplicate"
  --payload JSON   payload as a JSON object; key=value pairs are merged in (as strings)
  --json           machine-readable output
  --hash           (dump) print sha256 of the canonical JSON
  --parent ID      (create) the parent node; discovered work: kind=discovered discovered_during=ID
  --out FILE       (render) output path (default: tira.html)
  --factory FILE   (divergence, render, serve) the factory's file state, JSONL (default: $TIRA_FACTORY)
  --tira-log FILE  (divergence) tira's log as JSONL, instead of the store
  -h, --help       this help

Event names: use the table's name (COMPLETE, ADD_CHILD) or the stored form (complete, add-child).

Writes go through the dispatcher: after your command lands it writes any handoff it
made due (factory briefs, drops and sessions; idea -> node births) as "dispatcher",
and prints them as "+ dispatcher ..." lines. tira state lists handoffs still waiting.

Exit codes: 0 ok · 2 rejected or refused by the rules · 3 the sweep found something broken · 1 usage or other error
(including malformed or empty divergence input). Divergences are warn-only (severity policy v1): they exit 0.`;

class UsageError extends Error {}

const OPTIONS = {
  db: { type: "string" },
  stream: { type: "string" },
  actor: { type: "string" },
  version: { type: "string" },
  "event-id": { type: "string" },
  payload: { type: "string" },
  at: { type: "string" },
  now: { type: "string" },
  vantage: { type: "string" },
  json: { type: "boolean" },
  hash: { type: "boolean" },
  parent: { type: "string" },
  out: { type: "string" },
  port: { type: "string" },
  factory: { type: "string" },
  "tira-log": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function table(rows: Record<string, string>[], cols: string[]): string[] {
  if (rows.length === 0) return ["  (none)"];
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => (r[c] ?? "").length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i] as number)).join("  ").trimEnd();
  return [line(cols), line(width.map((n) => "-".repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c] ?? "")))];
}

function seqArg(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} must be a non-negative integer, got "${raw}"`);
  return Number(raw);
}

function payloadFrom(values: Values, pairs: string[]): Record<string, unknown> {
  let payload: Record<string, unknown> = {};
  if (values.payload !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.payload);
    } catch {
      throw new UsageError(`--payload is not valid JSON: ${values.payload}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UsageError("--payload must be a JSON object");
    }
    payload = parsed as Record<string, unknown>;
  }
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq <= 0) throw new UsageError(`expected key=value, got "${p}"`);
    payload[p.slice(0, eq)] = p.slice(eq + 1); // always a string; use --payload for other types
  }
  return payload;
}

function describe(r: WriteResult, handoffs: HandoffWrite[] = []): string {
  if (r.status === "appended") {
    const regions = Object.entries(r.regions).map(([k, v]) => `${k}=${v}`).join(" ");
    const line = `appended   seq ${r.seq}  ${r.key}  ${r.outcome}  ${regions}`;
    const closes = (r.closedByTira ?? []).map((c) => `\n  + tira closed ${c.key} (seq ${c.seqs.join(", ")}): you moved on`);
    const passed = handoffs.map((h) => `\n  + dispatcher ${h.event} on ${h.key} (${h.rule}, seq ${h.seq})`);
    return line + closes.join("") + passed.join("");
  }
  if (r.status === "duplicate") return `duplicate  seq ${r.seq}  (original was ${r.original}; nothing new stored)`;
  if (r.status === "skipped") return `skipped    seq ${r.seq}  (no longer due; nothing new stored)`;
  if (r.status === "refused") return `REFUSED    ${r.code}  ${r.detail}  (nothing stored)`;
  return `REJECTED   seq ${r.seq}  ${r.code}  ${r.detail}`;
}

// The command a create, send or key line describes.
function commandFrom(kind: "create" | "send", args: string[], values: Values, stream: string, io: Io): Command {
  const need = kind === "create" ? 2 : 3;
  const [type, id, rawEvent] = args as [string, string, string];
  // Accept the stored form too: "add-child" -> ADD_CHILD (the table's name).
  const event = rawEvent !== undefined && /^[a-z][a-z0-9-]*$/.test(rawEvent) ? tableEventName(rawEvent) : rawEvent;
  const payload = payloadFrom(values, args.slice(need));
  if (values.parent !== undefined) {
    if (kind !== "create") throw new UsageError("--parent only applies to create");
    payload.parent_id = values.parent;
  }
  const actor = values.actor ?? io.env.TIRA_ACTOR;
  const entity = { type, id, ...(values.version !== undefined ? { version: Number(values.version) } : {}) };
  const base = {
    stream,
    entity,
    payload,
    ...(actor !== undefined ? { actor } : {}),
    ...(values["event-id"] !== undefined ? { eventId: values["event-id"] } : {}),
  };
  return kind === "create" ? { ...base, kind: "create" } : { ...base, kind: "event", event };
}

async function write(kind: "create" | "send", args: string[], values: Values, store: ClosableStore, registry: Registry, stream: string, io: Io): Promise<number> {
  if (args.length < (kind === "create" ? 2 : 3)) {
    throw new UsageError(kind === "create" ? "usage: tira create <type> <id> [key=value ...]" : "usage: tira send <type> <id> <EVENT> [key=value ...]");
  }
  const { result: r, handoffs } = await new Dispatcher(store, registry).submit(commandFrom(kind, args, values, stream, io));
  io.out(values.json ? JSON.stringify(handoffs.length > 0 ? { ...r, handoffs } : r) : describe(r, handoffs));
  return r.status === "rejected" || r.status === "refused" ? 2 : 0;
}

// The fx: key for a transition (src/write/fxkey.ts), computed the way the factory must. It
// reads no log, so it checks what send would refuse without one: the command's shape, the
// type, its version rule and the event's name. It never opens the store.
function key(args: string[], values: Values, registry: Registry, stream: string, io: Io): number {
  if (args.length < 2) throw new UsageError("usage: tira key <type> <id> [EVENT] [key=value ...]");
  if (values["event-id"] !== undefined) throw new UsageError("tira key prints the event id: drop --event-id");
  const hasEvent = args[2] !== undefined && !args[2].includes("=");
  const cmd = commandFrom(hasEvent ? "send" : "create", args, values, stream, io);
  checkCommand(cmd, registry);
  const def = registry.get(cmd.entity.type);
  if (!def) throw new UsageError(`unknown entity type: ${cmd.entity.type}`);
  if (def.versioned && cmd.entity.version === undefined) throw new UsageError(`${def.type} is versioned: pass --version`);
  if (!def.versioned && cmd.entity.version !== undefined) throw new UsageError(`${def.type} is not versioned: drop --version`);
  if (cmd.kind === "event" && !registry.resolve(def.type, cmd.event)) throw new UsageError(`unknown event: ${def.type}.${cmd.event}`);
  io.out(fxKey(transitionOf(cmd, (t, v) => registry.creationName(t, v))));
  return 0;
}

function entityLabel(e: StoredEvent): string {
  if (e.type === REJECTED) {
    const d = e.data as unknown as RejectedData;
    const ent = d?.intent?.entity;
    return ent ? `${ent.type}:${ent.id}${ent.version !== undefined ? `@${ent.version}` : ""}` : "?";
  }
  const d = e.data as unknown as EventData;
  const type = e.type.split(".")[0] ?? "?";
  return d?.entity ? `${type}:${d.entity.id}${d.entity.version !== undefined ? `@${d.entity.version}` : ""}` : "?";
}

function eventDetail(e: StoredEvent): string {
  if (e.type === REJECTED) {
    const d = e.data as unknown as RejectedData;
    const what = d?.intent ? (d.intent.kind === "create" ? "create" : d.intent.event) : "?";
    return `${what} -> ${d?.reason?.code ?? "?"}: ${d?.reason?.detail ?? ""}`;
  }
  const p = (e.data as unknown as EventData)?.payload;
  return p && Object.keys(p).length > 0 ? JSON.stringify(p) : "";
}

async function log(store: ClosableStore, stream: string, values: Values, io: Io): Promise<number> {
  const events = await store.readStream(stream);
  if (values.json) {
    io.out(JSON.stringify(events));
    return 0;
  }
  io.out(`stream ${stream} · ${events.length} event(s)`);
  for (const l of table(
    events.map((e) => ({
      seq: String(e.seq),
      rev: String(e.streamRevision),
      type: e.type,
      entity: entityLabel(e),
      actor: e.metadata.actor ?? "",
      detail: eventDetail(e),
      at: e.recordedAt,
    })),
    ["seq", "rev", "type", "entity", "actor", "detail", "at"],
  )) io.out(l);
  return 0;
}

function printState(r: FoldResult, stream: string, upTo: number | undefined, io: Io): void {
  io.out(`stream ${stream} · folded to seq ${r.lastSeq}${upTo !== undefined ? ` (replay to ${upTo})` : ""}`);
  io.out("");
  io.out(`entities (${r.entities.length})`);
  for (const l of table(
    r.entities.map((e) => ({
      key: e.key,
      state: Object.entries(e.regions).map(([k, v]) => (Object.keys(e.regions).length === 1 ? v : `${k}=${v}`)).join(" "),
      created: String(e.createdSeq),
      last: String(e.lastSeq),
      "last actor": e.lastActor ?? "",
    })),
    ["key", "state", "created", "last", "last actor"],
  )) io.out(l);
  io.out("");
  io.out(`rejections (${r.rejections.length})`);
  for (const l of table(
    r.rejections.map((x) => ({
      seq: String(x.seq),
      command: x.intent.kind === "create" ? `create ${x.intent.entity.type}:${x.intent.entity.id}` : `${x.intent.event} ${x.intent.entity.type}:${x.intent.entity.id}`,
      code: x.code,
      detail: x.detail,
    })),
    ["seq", "command", "code", "detail"],
  )) io.out(l);
  const ready = r.frontier[stream];
  if (ready !== undefined) {
    io.out("");
    io.out(`claimable now (${ready.length})${ready.length > 0 ? `: ${ready.join(", ")}` : ""}`);
  }
  const waiting = r.handoffs[stream] ?? [];
  if (waiting.length > 0) {
    io.out("");
    io.out(`handoffs waiting (${waiting.length})`);
    for (const l of table(
      waiting.map((p) => ({ since: String(p.since), rule: p.rule, on: p.key, "waiting on": p.waitingOn })),
      ["since", "rule", "on", "waiting on"],
    )) io.out(l);
  }
  const labels = r.labels?.[stream];
  if (labels !== undefined) {
    io.out("");
    io.out(`labels: ${labels.labels} on ${labels.labeled} approval(s) · found bad ${labels.foundBad} · oracles disagree on ${labels.disagreements} · ${labels.anomalies} refused by the fold`);
    for (const l of table(
      Object.entries(labels.approvals).map(([vid, a]) => ({ approval: vid, brief: a.brief, verdict: a.verdict, oracles: a.labels.map((x) => `${x.actor} ${x.verdict}`).join(", ") })),
      ["approval", "brief", "verdict", "oracles"],
    )) io.out(l);
  }
  if (r.anomalies.length > 0) {
    io.out("");
    io.out(`ANOMALIES (${r.anomalies.length}) — events the rules would not have allowed`);
    for (const l of table(
      r.anomalies.map((a) => ({ seq: String(a.seq), type: a.type, problem: a.problem })),
      ["seq", "type", "problem"],
    )) io.out(l);
  }
  const derived = r.derived[stream];
  if (derived && Object.keys(derived).length > 0) {
    io.out("");
    io.out("derived");
    for (const [key, preds] of Object.entries(derived)) io.out(`  ${key}  ${JSON.stringify(preds)}`);
  }
}

const foldOptions = (upTo: number | undefined, values: Values): FoldOptions => ({
  ...(upTo !== undefined ? { upToSeq: upTo } : {}),
  ...(values.now !== undefined ? { now: values.now } : {}),
  ...(values.vantage !== undefined ? { vantage: values.vantage } : {}),
});

async function state(store: ClosableStore, registry: Registry, stream: string, upTo: number | undefined, values: Values, io: Io): Promise<number> {
  const r = fold(await store.readStream(stream), registry, foldOptions(upTo, values));
  if (values.json) io.out(canonicalJson(r));
  else printState(r, stream, upTo, io);
  return 0;
}

// The replay oracle for demo D0 / manual tests M0–M1: every dump is a full replay of
// the raw log in this process (nothing derived is stored), so equal hashes across
// runs, copies of the store file, or machines mean the replay is deterministic.
async function dump(store: ClosableStore, registry: Registry, stream: string, upTo: number | undefined, values: Values, io: Io): Promise<number> {
  const r = fold(await store.readStream(stream), registry, foldOptions(upTo, values));
  if (values.hash) {
    const sha = fingerprint(r);
    io.out(values.json ? JSON.stringify({ sha256: sha, stream, lastSeq: r.lastSeq }) : `sha256:${sha}  stream ${stream} · seq ${r.lastSeq}`);
  } else {
    io.out(canonicalJson(r));
  }
  return 0;
}

// A file's bytes, hashed (a factory input's snapshot). A state's hash is fingerprint (fold.ts).
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// Health sweeps (src/sweep/sweep.ts). Exit 0 when nothing is broken (things to look at
// are fine), 3 when something is.
async function sweepCmd(store: ClosableStore, registry: Registry, stream: string, upTo: number | undefined, values: Values, io: Io): Promise<number> {
  const r = sweep(await store.readStream(stream), registry, stream, upTo === undefined ? {} : { upToSeq: upTo });
  if (values.json) {
    io.out(canonicalJson(r));
  } else {
    io.out(`health sweep · stream ${stream} · as of seq ${r.atSeq}`);
    for (const c of r.checks) {
      const mark = c.findings.length === 0 ? "ok  " : c.severity === "broken" ? "FAIL" : "look";
      io.out(`${mark}  ${c.title}${c.findings.length > 0 ? ` (${c.findings.length})` : ""}`);
      for (const f of c.findings) {
        const where = [f.key, f.seq === undefined ? undefined : `seq ${f.seq}`].filter((x) => x !== undefined).join(" · ");
        io.out(`      ${where ? `${where}  ` : ""}${f.detail}`);
      }
    }
    io.out("");
    const look = r.attention > 0 ? `${r.attention} to look at` : "";
    io.out(r.broken === 0 ? `nothing broken${look ? `; ${look}` : ""}` : `${r.broken} broken${look ? `; ${look}` : ""}`);
  }
  return r.broken > 0 ? 3 : 0;
}

async function tree(store: ClosableStore, registry: Registry, stream: string, upTo: number | undefined, values: Values, io: Io): Promise<number> {
  const r = fold(await store.readStream(stream), registry, foldOptions(upTo, values));
  const v = streamView(r, stream);
  if (values.json) io.out(JSON.stringify(v.roots));
  else for (const l of textTree(v)) io.out(l);
  return 0;
}

// D1: a static page from the same fold `dump` hashes, stamped with that hash (M1 oracle).
async function render(store: ClosableStore, registry: Registry, stream: string, upTo: number | undefined, values: Values, io: Io): Promise<number> {
  const events = await store.readStream(stream);
  const r = fold(events, registry, foldOptions(upTo, values));
  const hash = fingerprint(r);
  const out = values.out ?? "tira.html";
  const shown = events.filter((e) => e.seq <= r.lastSeq); // render --at N: the panel judges what the page shows
  writeFileSync(out, renderHtml(r, stream, hash, events, { divergence: divergencePanel(factoryFile(values, io), shown, stream) }));
  const nodes = streamView(r, stream).nodeCount;
  io.out(values.json ? JSON.stringify({ out, nodes, sha256: hash, lastSeq: r.lastSeq }) : `wrote ${out}  ${nodes} node(s) · seq ${r.lastSeq} · sha256:${hash}`);
  return 0;
}

// B3 divergence watchdog. The differ (src/divergence/divergence.ts) is pure; these are its
// thin input adapters and the report's printer. Nothing is stored or cached: the report is
// computed at read time. Divergences are attention findings under severity policy v1, so
// they never change the exit code; an unreadable, malformed or empty input is a command
// error (exit 1) naming the offending line, never a blank or zero report.
const FACTORY_FIELDS = ["transition_kind", "entity_type", "entity_id", "ts", "outcome", "actor", "event_id"] as const;
const RUN_LOG = fileURLToPath(new URL("../../docs/divergence-run-log.jsonl", import.meta.url));

function jsonLines(file: string, what: string): { line: number; value: Record<string, unknown> }[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read ${what} ${file}: ${(err as Error).message}`);
  }
  const rows: { line: number; value: Record<string, unknown> }[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      throw new UsageError(`${what} ${file} line ${i + 1}: not valid JSON`);
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new UsageError(`${what} ${file} line ${i + 1}: not a JSON object`);
    rows.push({ line: i + 1, value: v as Record<string, unknown> });
  });
  if (rows.length === 0) throw new UsageError(`${what} ${file} has no records`);
  return rows;
}

function readFactory(file: string): FactoryRecord[] {
  return jsonLines(file, "factory file").map(({ line, value }) => {
    for (const f of FACTORY_FIELDS) {
      if (typeof value[f] !== "string" || value[f] === "") throw new UsageError(`factory file ${file} line ${line}: ${f} must be a non-empty string`);
    }
    if (!(value.event_id as string).startsWith(FX)) throw new UsageError(`factory file ${file} line ${line}: event_id must be an fx: key, got "${String(value.event_id)}"`);
    return value as unknown as FactoryRecord;
  });
}

function readTiraLog(file: string): StoredEvent[] {
  return jsonLines(file, "tira log").map(({ line, value }) => {
    const bad = (why: string) => new UsageError(`tira log ${file} line ${line}: ${why}`);
    if (typeof value.eventId !== "string" || value.eventId === "") throw bad("eventId must be a non-empty string");
    if (typeof value.stream !== "string" || value.stream === "") throw bad("stream must be a non-empty string");
    if (!Number.isInteger(value.seq) || (value.seq as number) < 1) throw bad("seq must be a positive integer");
    if (typeof value.type !== "string" || value.type === "") throw bad("type must be a non-empty string");
    if (value.data === null || typeof value.data !== "object" || Array.isArray(value.data)) throw bad("data must be a JSON object");
    return value as unknown as StoredEvent;
  });
}

// git is run from a fixed system directory, never resolved through PATH (Sonar S4036): a
// writable PATH entry could otherwise substitute the binary that pins a fixture run. No git
// there means no pin, the same fall-through as an untracked file.
const GIT = ["/usr/bin/git", "/usr/local/bin/git"].find((p) => existsSync(p));
const git = (cwd: string, ...args: string[]) => {
  if (!GIT) throw new Error("git not found in a fixed system directory");
  return execFileSync(GIT, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
};

// A fixture run is pinned by git: the commit whose tree holds these exact bytes. A copy git
// does not hold (or holds with edits) is reported unpinned, with the bytes' sha256.
function fixturePin(file: string, bytes: Buffer): Coordinates["factory"] {
  const cwd = dirname(file);
  try {
    git(cwd, "ls-files", "--error-unmatch", "--", basename(file));
    const blob = git(cwd, "rev-parse", `HEAD:./${basename(file)}`);
    if (git(cwd, "hash-object", "--", basename(file)) === blob) return { snapshot: git(cwd, "rev-parse", "HEAD"), pin: "git", file };
  } catch {
    // not in a git work tree, or not tracked: fall through
  }
  return { snapshot: sha256(bytes), pin: "unpinned", file };
}

// A live run is pinned by the bytes it read: the command hashes them itself and records that
// sha256 as the snapshot (spec Q3 / D-Po2; operator ruling 2026-10-20 — repeatability is a
// property of the run, not of a publisher). A FILE.sha256 sidecar is optional: absent, the run
// proceeds; present and equal, it proceeds; present and different (or present but unreadable,
// so its value cannot be shown equal), the run is refused as an integrity mismatch.
function livePin(file: string, bytes: Buffer): Coordinates["factory"] {
  const snapshot = sha256(bytes);
  const side = `${file}.sha256`;
  let text: string | undefined;
  try {
    text = readFileSync(side, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new UsageError(`integrity mismatch: ${side} is present but unreadable (${code ?? (err as Error).message}); bytes ${snapshot}`);
  }
  if (text !== undefined) {
    const declared = (text.trim().split(/\s+/)[0] ?? "").toLowerCase();
    if (declared !== snapshot) throw new UsageError(`integrity mismatch: factory snapshot ${file} does not match ${basename(side)}: declared ${declared || "(empty)"}, bytes ${snapshot}`);
  }
  return { snapshot, pin: "sha256", file };
}

function printDivergence(r: DivergenceReport, io: Io): void {
  const f = r.coordinates.factory;
  io.out(`divergence · factory ${f.file ?? "?"} (${f.pin} ${f.snapshot}) · tira stream ${r.coordinates.tira.stream} at seq ${r.coordinates.tira.atSeq}`);
  io.out(`read ${r.population.factoryRecords} factory record(s) · ${r.population.tiraFxEvents} tira fx: event(s) · ${r.population.ids} event id(s) in the union`);
  io.out(VERDICTS.map((v) => `${v} ${r.counts[v]}`).join(" · "));
  io.out("");
  io.out(`findings (${r.findings.length})`);
  for (const l of table(r.findings.map((x) => ({ verdict: x.verdict, "event id": x.event_id, detail: x.detail })), ["verdict", "event id", "detail"])) io.out(l);
  io.out("");
  io.out(`severity policy ${r.severityPolicy}: divergences are attention findings; the exit code stays 0`);
}

// An empty $TIRA_FACTORY is unset, not a file named "".
const factoryFile = (values: Values, io: Io) => values.factory ?? (io.env.TIRA_FACTORY || undefined);

function factoryBytes(file: string): Buffer {
  try {
    return readFileSync(file);
  } catch (err) {
    throw new UsageError(`cannot read factory file ${file}, so it cannot be hashed: ${(err as Error).message}`);
  }
}

// The page's divergence section (render and serve): the same adapters, pin and differ as a
// live `tira divergence`, run in this process on the events the page renders. The report is
// never read back from the run log or any stored artifact, and the page appends nothing to
// it. Whatever would make the command exit 1 makes the section UNEVALUABLE, with the reason.
export function divergencePanel(file: string | undefined, events: StoredEvent[], stream: string): DivergencePanel {
  if (file === undefined) return { unevaluable: "no factory file: pass --factory FILE or set TIRA_FACTORY" };
  try {
    const pin = livePin(file, factoryBytes(file));
    const factory = readFactory(file);
    if (events.length === 0) throw new UsageError(`stream ${stream} has no events`);
    return { report: divergence({ factory, tira: events, factorySnapshot: pin, stream }) };
  } catch (err) {
    return { unevaluable: (err as Error).message };
  }
}

// One stream's events, from a store opened for this read only.
async function readStreamOnce(open: () => ClosableStore, stream: string): Promise<StoredEvent[]> {
  const store = open();
  try {
    return await store.readStream(stream);
  } finally {
    await store.close();
  }
}

async function divergenceCmd(values: Values, open: () => ClosableStore, io: Io): Promise<number> {
  const file = factoryFile(values, io);
  if (file === undefined) throw new UsageError("usage: tira divergence --factory FILE [--tira-log FILE] [--stream NAME] [--json]");
  const bytes = factoryBytes(file);
  const live = values["tira-log"] === undefined;
  const pin = live ? livePin(file, bytes) : fixturePin(file, bytes);
  const factory = readFactory(file);
  let events: StoredEvent[];
  let stream: string;
  if (live) {
    const named = values.stream ?? io.env.TIRA_STREAM;
    if (named === undefined) throw new UsageError("tira divergence reads the store by stream: pass --stream (or --tira-log FILE)");
    stream = named;
    events = await readStreamOnce(open, stream);
    if (events.length === 0) throw new UsageError(`stream ${stream} has no events in the database`);
  } else {
    events = readTiraLog(values["tira-log"] as string);
    const streams = [...new Set(events.map((e) => e.stream))];
    if (values.stream !== undefined && streams.some((s) => s !== values.stream)) throw new UsageError(`tira log holds stream(s) ${streams.join(", ")}, not ${values.stream}`);
    if (streams.length !== 1) throw new UsageError(`tira log holds ${streams.length} streams (${streams.join(", ")}): pass one stream's log`);
    stream = streams[0] as string;
  }
  const r = divergence({ factory, tira: events, factorySnapshot: pin, stream });
  if (live) {
    const row = {
      ts: new Date().toISOString(),
      factorySnapshot: r.coordinates.factory.snapshot,
      stream: r.coordinates.tira.stream,
      atSeq: r.coordinates.tira.atSeq,
      population: r.population,
      counts: r.counts,
      severityPolicy: r.severityPolicy,
    };
    appendFileSync(io.env.TIRA_DIVERGENCE_LOG ?? RUN_LOG, `${JSON.stringify(row)}\n`);
  }
  if (values.json) io.out(JSON.stringify(r));
  else printDivergence(r, io);
  return 0;
}

function types(registry: Registry, values: Values, io: Io): number {
  const defs = registry.types().map((d) => ({
    type: d.type,
    versioned: d.versioned ?? false,
    regions: Object.fromEntries(Object.entries(d.regions).map(([name, t]) => [name, { initial: t.initial, states: t.states, events: t.events }])),
  }));
  if (values.json) {
    io.out(JSON.stringify(defs));
    return 0;
  }
  for (const d of defs) {
    io.out(`${d.type}${d.versioned ? " (versioned)" : ""}`);
    for (const [name, r] of Object.entries(d.regions)) {
      io.out(`  ${name}: states ${r.states.join(", ")} (starts ${r.initial})`);
      io.out(`  ${" ".repeat(name.length)}  events ${r.events.join(", ")}`);
    }
  }
  return 0;
}

// tira import <file.db>: a one-time copy of an old SQLite log into the live Postgres database,
// every event as it was (id, seq, stream, data, metadata, record time). Into an empty schema;
// a re-run adds nothing. Each stream's fold is fingerprinted before and after: they must match.
async function importCmd(args: string[], values: Values, registry: Registry, io: Io): Promise<number> {
  const file = args[0];
  if (file === undefined || args.length > 1) throw new UsageError("usage: tira import <file.db>");
  if (!existsSync(file)) throw new UsageError(`no such file: ${file}`);
  const source = new SqliteEventStore({ path: file });
  const target = openStore(liveDatabase(values.db, io.env), io.env.TIRA_SCHEMA);
  try {
    const events = await source.readAll();
    const streams = [...new Set(events.map((e) => e.stream))].sort(compareCodeUnits);
    const lastOf = new Map(events.map((e) => [e.stream, e.seq]));
    const before = new Map(await Promise.all(streams.map(async (st) => [st, fingerprint(fold(await source.readStream(st), registry))] as const)));
    const { added } = await target.importLog(events);
    const checks = await Promise.all(streams.map(async (st) => {
      const here = (await target.readStream(st)).filter((e) => e.seq <= (lastOf.get(st) as number));
      const after = fingerprint(fold(here, registry));
      return { st, after, ok: after === before.get(st) };
    }));
    for (const { st, after, ok } of checks) {
      const n = events.filter((e) => e.stream === st).length;
      const was = ok ? "" : ` (was sha256:${before.get(st) ?? ""})`;
      io.out(`${ok ? "same" : "DIFFERENT"}  ${st} · ${n} event(s) · sha256:${after}${was}`);
    }
    const same = checks.every((c) => c.ok);
    io.out(added > 0 ? `imported ${added} event(s) from ${file}` : `already imported: nothing added (${events.length} event(s) from ${file} are here as they were)`);
    if (!same) {
      io.err("tira: the fingerprints differ: the copy doesn't fold the same; don't delete the old file");
      return 1;
    }
    return 0;
  } catch (err) {
    if (err instanceof ImportRefused) throw new UsageError(err.message);
    throw err;
  } finally {
    source.close();
    await target.close();
  }
}

// The page, live (src/serve/server.ts). Runs until Ctrl-C; the store closes on the way out.
async function serve(open: () => ClosableStore, registry: Registry, stream: string, values: Values, io: Io): Promise<number> {
  const actor = values.actor ?? io.env.TIRA_ACTOR;
  if (actor === undefined) throw new UsageError("tira serve needs --actor NAME: who the page's actions are written as");
  const port = values.port === undefined ? 4747 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be 0-65535, got "${values.port}"`);
  const store = open();
  const file = factoryFile(values, io);
  const server = tiraServer({ store, registry, stream, actor, divergence: (events) => divergencePanel(file, events, stream) });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    const at = server.address();
    io.out(`tira: serving ${stream} at http://127.0.0.1:${typeof at === "object" && at ? at.port : port} as ${actor} (Ctrl-C to stop)`);
    await new Promise<void>((resolve) => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return 0;
  } finally {
    await store.close();
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (err) {
    io.err(`tira: ${(err as Error).message}`);
    io.err("");
    io.err(HELP);
    return 1;
  }
  const [cmd, ...args] = positionals;
  if (values.help) {
    io.out(HELP);
    return 0;
  }
  if (!cmd) {
    io.err(HELP);
    return 1;
  }
  const registry = defaultRegistry();
  if (cmd === "types") return types(registry, values, io);
  if (!["create", "send", "log", "state", "replay", "dump", "tree", "render", "key", "sweep", "serve", "divergence", "import"].includes(cmd)) {
    io.err(`tira: unknown command "${cmd}"`);
    io.err("");
    io.err(HELP);
    return 1;
  }

  // The live database: Postgres only, from --db or $TIRA_DATABASE_URL; a SQLite file is refused,
  // and nothing is made in the current folder. Asked only by commands that read or write it.
  const open = (): ClosableStore => (io.openStore ? io.openStore(values.db ?? io.env.TIRA_DATABASE_URL ?? "") : openStore(liveDatabase(values.db, io.env), io.env.TIRA_SCHEMA));
  const stream = values.stream ?? io.env.TIRA_STREAM ?? "tasktree-main";
  let store: ClosableStore | undefined;
  try {
    if (cmd === "key") return key(args, values, registry, stream, io);
    if (cmd === "divergence") return await divergenceCmd(values, open, io);
    if (cmd === "import") return await importCmd(args, values, registry, io);
    if (values.now !== undefined && !isIsoTime(values.now)) throw new UsageError(`--now must be an ISO-8601 date-time with a zone (Z or +hh:mm), got "${values.now}"`);
    if (cmd === "serve") return await serve(open, registry, stream, values, io);
    store = open();
    switch (cmd) {
      case "create":
      case "send":
        return await write(cmd, args, values, store, registry, stream, io);
      case "log":
        return await log(store, stream, values, io);
      case "state":
        return await state(store, registry, stream, values.at !== undefined ? seqArg(values.at, "--at") : undefined, values, io);
      case "dump":
        return await dump(store, registry, stream, values.at !== undefined ? seqArg(values.at, "--at") : undefined, values, io);
      case "tree":
        return await tree(store, registry, stream, values.at !== undefined ? seqArg(values.at, "--at") : undefined, values, io);
      case "sweep":
        return await sweepCmd(store, registry, stream, values.at !== undefined ? seqArg(values.at, "--at") : undefined, values, io);
      case "render":
        return await render(store, registry, stream, values.at !== undefined ? seqArg(values.at, "--at") : undefined, values, io);
      default: {
        // replay <N>
        if (args[0] === undefined) throw new UsageError("usage: tira replay <N>");
        return await state(store, registry, stream, seqArg(args[0], "replay N"), values, io);
      }
    }
  } catch (err) {
    io.err(`tira: ${(err as Error).message}`);
    return 1;
  } finally {
    await store?.close();
  }
}
