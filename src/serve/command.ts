// The right half of every decision: the action as a tira command, filled in and editable
// before it runs. It is the CLI's own syntax (`tira send …`, `tira create …`), so the same text
// runs in a terminal. The page reads it back strictly: only its own verbs, on a task of a tree
// type, with only the fields the rules use, plus an optional note="…" that the history keeps.
// Anything else is explained, never guessed at.
//
// A block names what it waits on as a ticket (blocker=…): an open task, or a new one the line
// above creates under the blocked task. Those two lines are the only pair the page runs.

import type { Registry } from "../tables/registry.ts";

// The verbs a page may send, with the field each needs (the node table's guards, and the idea
// table's: a reject needs a reason, hasReason).
// `text`: the field must have text, not only spaces, as the gate checks (2026-10-20).
// `suggest`: offer what was written before for this event in this stream (and, to block,
// "waiting on <task>" for each open task), so like reasons group together.
// ADD_SUBTASK is the page's own: it births a new task under this one (a create, not an event).
export interface PageField { name: string; text?: boolean; suggest?: boolean }
// `extra`: optional keys the verb also takes (a block's blocker ticket)
// `on`: the one entity type the verb is for (an idea's two approvals, D5); without it, a task
export interface PageVerb { label: string; field?: PageField; creates?: boolean; extra?: string[]; on?: string }
export const PAGE_VERBS: Record<string, PageVerb> = {
  START: { label: "Start" },
  UNBLOCK: { label: "Unblock" },
  COMPLETE: { label: "Complete", field: { name: "evidenceRef" } },
  BLOCK: { label: "Block", field: { name: "reason", text: true }, extra: ["blocker"] },
  CANCEL: { label: "Cancel" },
  REOPEN: { label: "Reopen", field: { name: "reason", text: true, suggest: true } },
  ADD_SUBTASK: { label: "Add subtask", field: { name: "name", text: true }, creates: true },
  APPROVE_FILE: { label: "Approve file", on: "idea" },
  REJECT_FILE: { label: "Reject file", field: { name: "reason", text: true }, on: "idea" },
  APPROVE_NODE: { label: "Approve placement", field: { name: "parent_id", text: true }, on: "idea" },
  REJECT_NODE: { label: "Reject placement", field: { name: "reason", text: true }, on: "idea" },
};

// Whether a verb is for this type: its own type (`on`), else any tree type (a task).
export const verbFits = (verb: PageVerb, type: string, isTreeType: (type: string) => boolean): boolean => (verb.on === undefined ? isTreeType(type) : type === verb.on);

// A drag on the Kanban, as a verb: the card's type, the column it leaves and the one it lands
// in, to the task verb today's rules give that move (a transition, never a noop or a refusal).
// Keys read "node:unstarted>in_progress". A move two verbs could mean is left out: a drag can't
// choose between them.
export function dragMoves(registry: Registry): Record<string, string> {
  const verbs = new Map<string, string[]>();
  for (const def of registry.types()) {
    if (def.tree === undefined) continue;
    for (const p of registry.tableFor(def, def.tree.region).pairs) {
      const verb = PAGE_VERBS[p.event];
      if (p.outcome !== "transition" || p.to === undefined || !verb || verb.creates || verb.on !== undefined) continue;
      const key = `${def.type}:${p.from}>${p.to}`;
      verbs.set(key, [...(verbs.get(key) ?? []), p.event]);
    }
  }
  return Object.fromEntries([...verbs].flatMap(([key, [event, ...more]]) => (event !== undefined && more.length === 0 ? [[key, event]] : [])));
}

// What the page writes: an event on a task, or (Add subtask) a birth under it.
export interface PageAction { type: string; id: string; event: string; payload: Record<string, unknown>; child?: string }
// A block's blocker, when the payload names one (an id in the blocked task's stream).
export const blockerOf = (a: PageAction): string | undefined => (typeof a.payload.blocker === "string" && a.payload.blocker.trim() !== "" ? a.payload.blocker : undefined);

// A subtask's name, as the page takes it: trimmed, 1 to 80 characters, no control characters.
export const subtaskName = (v: string | null | undefined): string | undefined => {
  const name = (v ?? "").trim();
  return name.length > 0 && name.length <= 80 && !/\p{Cc}/u.test(name) ? name : undefined;
};

const PLAIN = /^[\w.:/@+-]+$/;
const BACKSLASH = "\\";
// inside double quotes, a backslash and a quote are written with a backslash before them
const escaped = (s: string) => s.replaceAll(BACKSLASH, BACKSLASH + BACKSLASH).replaceAll('"', BACKSLASH + '"');
// A word as the command shows it: bare when it can be, else in double quotes.
export const quote = (s: string) => (PLAIN.test(s) ? s : '"' + escaped(s) + '"');
// key="value", always quoted, so an empty value reads as one to fill in
const pair = (key: string, value: string) => key + '="' + escaped(value) + '"';

// The command a decision opens with: complete for a verb with no field, with empty quotes
// where a value is yours to fill in (or `value`, what tira proposes: an idea's parent). A subtask
// found while working on its parent (the parent is under way) says so; remove it for planned work.
export function commandFor(type: string, id: string, event: string, found = false, value = ""): string {
  const verb = PAGE_VERBS[event];
  if (verb?.creates) {
    const foundWork = found ? " kind=discovered discovered_during=" + quote(id) : "";
    return `tira create ${quote(type)} "" --parent ${quote(id)}` + foundWork;
  }
  // a block opens on a new ticket for what it waits on, created under the blocked task
  if (event === "BLOCK") return commandFor(type, id, "ADD_SUBTASK", true) + `\ntira send ${quote(type)} ${quote(id)} BLOCK blocker="" reason=""`;
  const toFill = verb?.field ? " " + pair(verb.field.name, value) : "";
  return `tira send ${quote(type)} ${quote(id)} ${quote(event)}` + toFill;
}

// Words, as a shell splits them: spaces separate; "…" keeps spaces (\" and \\ inside); '…' is literal.
// A word is a run of plain characters and quoted parts; each alternative starts differently, so
// matching is linear. Anything left over is a quote that never closes.
const WORD = /(?:[^\s"']|"(?:[^"\\]|\\.)*"|'[^']*')+/g;
const PART = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^"']+)/g;
const unquote = (_m: string, dq?: string, sq?: string, plain?: string) => (dq === undefined ? sq ?? plain ?? "" : dq.replaceAll(/\\(.)/g, "$1"));
export function words(text: string): string[] | { why: string } {
  if (text.replaceAll(WORD, "").trim() !== "") return { why: "a quote is never closed" };
  return (text.match(WORD) ?? []).map((w) => w.replaceAll(PART, unquote));
}

// `ticket`: the new blocker ticket a block's line above creates, written first.
export type Parsed = { ok: true; action: PageAction; ticket?: PageAction } | { ok: false; why: string };
const no = (why: string): Parsed => ({ ok: false, why });
const SENDS = Object.entries(PAGE_VERBS).filter(([, v]) => !v.creates).map(([k]) => k);

// key=value words, each key allowed once and only from `allowed`; a flag or a stray word is refused.
function pairsOf(rest: string[], allowed: string[], what: string): Record<string, string> | { why: string } {
  const out: Record<string, string> = {};
  for (const w of rest) {
    if (w.startsWith("--")) return { why: `the page doesn't take ${w}: it acts as its own person, in its own stream` };
    const eq = w.indexOf("=");
    if (eq <= 0) return { why: `expected key="value", got ${quote(w)}` };
    const key = w.slice(0, eq);
    if (!allowed.includes(key)) return { why: `${what} takes ${allowed.map((k) => k + '="…"').join(" and ")}, not ${key}` };
    if (key in out) return { why: `${key} is given twice` };
    out[key] = w.slice(eq + 1);
  }
  return out;
}

// What a command asks for, or why the page won't run it. isTreeType: a type whose tasks
// form the tree (node), the only ones the page acts on. One command per line; two only as a
// new blocker ticket and the block on it.
export function parseCommand(text: string, isTreeType: (type: string) => boolean): Parsed {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return no("write a command: tira send … or tira create …");
  if (lines.length === 1) return parseLine(lines[0] as string, isTreeType);
  const pairNote = "two commands only go together to block a task on a new ticket: tira create node <ticket> --parent <task>, then tira send node <task> BLOCK blocker=<ticket>";
  if (lines.length > 2) return no(pairNote);
  const first = parseLine(lines[0] as string, isTreeType);
  const second = parseLine(lines[1] as string, isTreeType);
  if (!first.ok) return no(`line 1: ${first.why}`);
  if (!second.ok) return no(`line 2: ${second.why}`);
  const t = first.action;
  const b = second.action;
  if (t.event !== "ADD_SUBTASK" || b.event !== "BLOCK" || t.id !== b.id || t.type !== b.type || blockerOf(b) !== t.child) return no(pairNote);
  return { ok: true, action: b, ticket: t };
}

function parseLine(text: string, isTreeType: (type: string) => boolean): Parsed {
  const w = words(text);
  if (!Array.isArray(w)) return no(w.why);
  if (w[0] !== "tira") return no('start with "tira": tira send … or tira create …');
  if (w[1] === "send") return parseSend(w, isTreeType);
  if (w[1] === "create") return parseCreate(w, isTreeType);
  return no('the page runs tira send … or tira create …');
}

// an optional value, kept only when it has text
const given = (key: string, value: string | undefined) => (value?.trim() ? { [key]: value } : {});

// why a verb doesn't fit the type it was sent to, and what does
function misfit(verb: PageVerb, type: string, event: string): string {
  if (verb.on !== undefined) return `${event} is for ${verb.on}s: tira send ${verb.on} <${verb.on}> ${event}`;
  const own = SENDS.filter((k) => PAGE_VERBS[k]?.on === type);
  return own.length > 0 ? `${event} is for tasks (node); an ${type} takes ${own.join(", ")}` : `the page acts on tasks (node), not ${type}`;
}

// tira send <type> <id> <EVENT> [key="value" ...]
function parseSend(w: string[], isTreeType: (type: string) => boolean): Parsed {
  const [, , type, id, event, ...rest] = w;
  if (type === undefined || id === undefined || event === undefined) return no('write it as: tira send node <task> <EVENT>, then any key="value"');
  const verb = PAGE_VERBS[event];
  if (!verb || verb.creates) return no(`the page sends ${SENDS.join(", ")}, not ${event}`);
  if (!verbFits(verb, type, isTreeType)) return no(misfit(verb, type, event));
  if (id.trim() === "") return no("name the task");
  const keys = [...(verb.field ? [verb.field.name] : []), ...(verb.extra ?? []), "note"];
  const kv = pairsOf(rest, keys, event);
  if ("why" in kv) return no(kv.why as string);
  const { note, blocker, ...fields } = kv;
  if (blocker?.trim() === id.trim()) return no(`${id} can't be blocked by itself`);
  return { ok: true, action: { type, id, event, payload: { ...fields, ...given("blocker", blocker?.trim()), ...given("note", note) } } };
}

// tira create <type> <name> --parent <id> [kind=discovered discovered_during=<id>] [note="…"]
function parseCreate(w: string[], isTreeType: (type: string) => boolean): Parsed {
  const [, , type, name, ...rest] = w;
  if (type === undefined || name === undefined) return no('write it as: tira create node "<name>" --parent <task>');
  if (!isTreeType(type)) return no(`the page acts on tasks (node), not ${type}`);
  const at = rest.indexOf("--parent");
  const parent = at < 0 ? undefined : rest[at + 1];
  if (parent === undefined || parent.trim() === "") return no("say where it goes: --parent <task>");
  const kv = pairsOf(rest.filter((_, i) => i !== at && i !== at + 1), ["kind", "discovered_during", "note"], "Add subtask");
  if ("why" in kv) return no(kv.why as string);
  const child = subtaskName(name);
  if (child === undefined) return no('give the new subtask a name: tira create node "<name>" (1 to 80 characters)');
  const found = kv.kind !== undefined || kv.discovered_during !== undefined;
  if (found && (kv.kind !== "discovered" || kv.discovered_during !== parent)) return no(`found work is marked kind=discovered discovered_during=${quote(parent)} (the task it was found under)`);
  const discovered = found ? { kind: "discovered", discovered_during: parent } : {};
  return { ok: true, action: { type, id: parent, event: "ADD_SUBTASK", child, payload: { parent_id: parent, ...discovered, ...given("note", kv.note) } } };
}

// A value the verb needs and the command left empty: said before anything is written. A
// block on a ticket needs no more: its reason defaults to "waiting on <ticket>" (withDefaults).
export function missing(a: PageAction): string | undefined {
  const field = PAGE_VERBS[a.event]?.field;
  if (!field || PAGE_VERBS[a.event]?.creates) return undefined;
  if (a.event === "BLOCK" && blockerOf(a) !== undefined) return undefined;
  const v = a.payload[field.name];
  if (typeof v === "string" && v.trim() !== "") return undefined;
  if (field.name === "evidenceRef") return "Pick the proof of work: one of the task's commits.";
  if (field.name === "parent_id") return 'Say where it goes: parent_id="…" (the task it becomes a subtask of).';
  return 'Add the reason: reason="…" (words, not only spaces).';
}

// What the page fills in for you before writing: a block on a ticket with no reason written
// waits on that ticket.
export function withDefaults(a: PageAction): PageAction {
  const blocker = blockerOf(a);
  const reason = a.payload.reason;
  if (a.event !== "BLOCK" || blocker === undefined || (typeof reason === "string" && reason.trim() !== "")) return a;
  return { ...a, payload: { ...a.payload, reason: `waiting on ${blocker}` } };
}
