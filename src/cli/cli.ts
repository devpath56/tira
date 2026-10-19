// tira CLI — a manual-testing rig for the Phase 1 core until the lean UI exists.
// Every write goes through the guarded WritePath; every read is a fold. The CLI
// never touches state directly, so what you see here is what the core decides.
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { renderHtml } from "../render/html.ts";
import { streamView, textTree } from "../render/tree-view.ts";
import { SqliteEventStore } from "../store/sqlite-store.ts";
import { defaultRegistry, type Registry } from "../tables/registry.ts";
import { checkCommand, type Command, type WriteResult } from "../write/write-path.ts";
import { Dispatcher, type HandoffWrite } from "../write/dispatcher.ts";
import { fxKey, transitionOf } from "../write/fxkey.ts";
import { isIsoTime } from "../time.ts";
import { sweep } from "../sweep/sweep.ts";
import { canonicalJson, fold, type FoldOptions, type FoldResult } from "../fold/fold.ts";
import { REJECTED, tableEventName, type EventData, type RejectedData } from "../fold/events.ts";
import type { StoredEvent } from "../store/types.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  env: Record<string, string | undefined>;
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
  tira render [--out FILE] [--at N]               write the read-only HTML page (D1); reload it after re-rendering
  tira dump [--at N] [--hash]                     full derived state as canonical JSON (same log => same bytes);
                                                  --hash prints its sha256 instead
  tira key <type> <id> [EVENT] [key=value ...]    the fx: event id a factory transition uses (B2): the same
                                                  flags as send; no EVENT means a birth (e.g. drop.filed)
  tira sweep [--at N] [--json]                    health checks: orphans, loops, parent/child links, counts,
                                                  depths, closed parents with open work; plus tasks with no
                                                  definition or done criteria, and finished branches that
                                                  grew new work. Exits 3 when something is broken

Options:
  --db PATH        store file (default: $TIRA_DB, else ./tira.db)
  --stream NAME    stream / tree (default: $TIRA_STREAM, else tasktree-main)
  --actor NAME     who is acting, for create/send (default: $TIRA_ACTOR)
  --version N      entity version (versioned entity types only)
  --event-id ID    idempotency key: re-sending the same command returns "duplicate"
  --payload JSON   payload as a JSON object; key=value pairs are merged in (as strings)
  --json           machine-readable output
  --hash           (dump) print sha256 of the canonical JSON
  --parent ID      (create) the parent node; discovered work: kind=discovered discovered_during=ID
  --out FILE       (render) output path (default: tira.html)
  -h, --help       this help

Event names: use the table's name (COMPLETE, ADD_CHILD) or the stored form (complete, add-child).

Writes go through the dispatcher: after your command lands it writes any handoff it
made due (factory briefs, drops and sessions; idea -> node births) as "dispatcher",
and prints them as "+ dispatcher ..." lines. tira state lists handoffs still waiting.

Exit codes: 0 ok · 2 rejected by the rules · 3 the sweep found something broken · 1 usage or other error`;

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

async function write(kind: "create" | "send", args: string[], values: Values, store: SqliteEventStore, registry: Registry, stream: string, io: Io): Promise<number> {
  if (args.length < (kind === "create" ? 2 : 3)) {
    throw new UsageError(kind === "create" ? "usage: tira create <type> <id> [key=value ...]" : "usage: tira send <type> <id> <EVENT> [key=value ...]");
  }
  const { result: r, handoffs } = await new Dispatcher(store, registry).submit(commandFrom(kind, args, values, stream, io));
  io.out(values.json ? JSON.stringify(handoffs.length > 0 ? { ...r, handoffs } : r) : describe(r, handoffs));
  return r.status === "rejected" ? 2 : 0;
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

async function log(store: SqliteEventStore, stream: string, values: Values, io: Io): Promise<number> {
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

async function state(store: SqliteEventStore, registry: Registry, stream: string, upTo: number | undefined, values: Values, io: Io): Promise<number> {
  const r = fold(await store.readStream(stream), registry, foldOptions(upTo, values));
  if (values.json) io.out(canonicalJson(r));
  else printState(r, stream, upTo, io);
  return 0;
}

// The replay oracle for demo D0 / manual tests M0–M1: every dump is a full replay of
// the raw log in this process (nothing derived is stored), so equal hashes across
// runs, copies of the store file, or machines mean the replay is deterministic.
async function dump(store: SqliteEventStore, registry: Registry, stream: string, upTo: number | undefined, values: Values, io: Io): Promise<number> {
  const r = fold(await store.readStream(stream), registry, foldOptions(upTo, values));
  const json = canonicalJson(r);
  if (values.hash) {
    const sha = sha256(json);
    io.out(values.json ? JSON.stringify({ sha256: sha, stream, lastSeq: r.lastSeq }) : `sha256:${sha}  stream ${stream} · seq ${r.lastSeq}`);
  } else {
    io.out(json);
  }
  return 0;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Health sweeps (src/sweep/sweep.ts). Exit 0 when nothing is broken (things to look at
// are fine), 3 when something is.
async function sweepCmd(store: SqliteEventStore, registry: Registry, stream: string, upTo: number | undefined, values: Values, io: Io): Promise<number> {
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

async function tree(store: SqliteEventStore, registry: Registry, stream: string, upTo: number | undefined, values: Values, io: Io): Promise<number> {
  const r = fold(await store.readStream(stream), registry, foldOptions(upTo, values));
  const v = streamView(r, stream);
  if (values.json) io.out(JSON.stringify(v.roots));
  else for (const l of textTree(v)) io.out(l);
  return 0;
}

// D1: a static page from the same fold `dump` hashes, stamped with that hash (M1 oracle).
async function render(store: SqliteEventStore, registry: Registry, stream: string, upTo: number | undefined, values: Values, io: Io): Promise<number> {
  const r = fold(await store.readStream(stream), registry, foldOptions(upTo, values));
  const hash = sha256(canonicalJson(r));
  const out = values.out ?? "tira.html";
  writeFileSync(out, renderHtml(r, stream, hash, await store.readStream(stream)));
  const nodes = streamView(r, stream).nodeCount;
  io.out(values.json ? JSON.stringify({ out, nodes, sha256: hash, lastSeq: r.lastSeq }) : `wrote ${out}  ${nodes} node(s) · seq ${r.lastSeq} · sha256:${hash}`);
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
  if (!["create", "send", "log", "state", "replay", "dump", "tree", "render", "key", "sweep"].includes(cmd)) {
    io.err(`tira: unknown command "${cmd}"`);
    io.err("");
    io.err(HELP);
    return 1;
  }

  const db = values.db ?? io.env.TIRA_DB ?? "tira.db";
  const stream = values.stream ?? io.env.TIRA_STREAM ?? "tasktree-main";
  let store: SqliteEventStore | undefined;
  try {
    if (cmd === "key") return key(args, values, registry, stream, io);
    if (values.now !== undefined && !isIsoTime(values.now)) throw new UsageError(`--now must be an ISO-8601 date-time with a zone (Z or +hh:mm), got "${values.now}"`);
    store = new SqliteEventStore({ path: db });
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
    store?.close();
  }
}
