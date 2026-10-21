// The right half of every decision: the action as a tira command, filled in and editable
// before it runs. It is the CLI's own syntax (`tira send …`, `tira create …`), so the same text
// runs in a terminal. The page reads it back strictly: only its own verbs, on a task of a tree
// type, with only the fields the rules use, plus an optional note="…" that the history keeps.
// Anything else is explained, never guessed at.
//
// A block names what it waits on as a ticket (blocker=…): an open task, or a new one the line
// above creates under the blocked task. Those two lines are the only pair the page runs.

// The verbs a page may send, with the field each needs (the node table's guards).
// `text`: the field must have text, not only spaces, as the gate checks (2026-10-20).
// `suggest`: offer what was written before for this event in this stream (and, to block,
// "waiting on <task>" for each open task), so like reasons group together.
// ADD_SUBTASK is the page's own: it births a new task under this one (a create, not an event).
export interface PageField { name: string; text?: boolean; suggest?: boolean }
// `extra`: optional keys the verb also takes (a block's blocker ticket)
export const PAGE_VERBS: Record<string, { label: string; field?: PageField; creates?: boolean; extra?: string[] }> = {
  START: { label: "Start" },
  UNBLOCK: { label: "Unblock" },
  COMPLETE: { label: "Complete", field: { name: "evidenceRef" } },
  BLOCK: { label: "Block", field: { name: "reason", text: true }, extra: ["blocker"] },
  CANCEL: { label: "Cancel" },
  REOPEN: { label: "Reopen", field: { name: "reason", text: true, suggest: true } },
  ADD_SUBTASK: { label: "Add subtask", field: { name: "name", text: true }, creates: true },
};

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
// A word as the command shows it: bare when it can be, else in double quotes.
export const quote = (s: string) => (PLAIN.test(s) ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
// key="value", always quoted, so an empty value reads as one to fill in
const pair = (key: string, value: string) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// The command a decision opens with: complete for a verb with no field, with empty quotes
// where a value is yours to fill in. A subtask found while working on its parent (the parent
// is under way) says so; remove it for planned work.
export function commandFor(type: string, id: string, event: string, found = false): string {
  const verb = PAGE_VERBS[event];
  if (verb?.creates) return `tira create ${quote(type)} "" --parent ${quote(id)}${found ? ` kind=discovered discovered_during=${quote(id)}` : ""}`;
  // a block opens on a new ticket for what it waits on, created under the blocked task
  if (event === "BLOCK") return `${commandFor(type, id, "ADD_SUBTASK", true)}\ntira send ${quote(type)} ${quote(id)} BLOCK blocker="" reason=""`;
  return `tira send ${quote(type)} ${quote(id)} ${quote(event)}${verb?.field ? " " + pair(verb.field.name, "") : ""}`;
}

// Words, as a shell splits them: spaces separate; "…" keeps spaces (\" and \\ inside); '…' is literal.
export function words(text: string): string[] | { why: string } {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quoteChar: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoteChar === '"') {
      if (c === "\\" && i + 1 < text.length) cur += text[++i];
      else if (c === '"') quoteChar = undefined;
      else cur += c;
    } else if (quoteChar === "'") {
      if (c === "'") quoteChar = undefined;
      else cur += c;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else if (c === '"' || c === "'") {
      quoteChar = c;
      started = true;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quoteChar !== undefined) return { why: "a quote is never closed" };
  if (started) out.push(cur);
  return out;
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
    if (!allowed.includes(key)) return { why: `${what} takes ${allowed.map((k) => `${k}="…"`).join(" and ")}, not ${key}` };
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
  if (w[1] === "send") {
    const [, , type, id, event, ...rest] = w;
    if (type === undefined || id === undefined || event === undefined) return no('write it as: tira send node <task> <EVENT>, then any key="value"');
    const verb = PAGE_VERBS[event];
    if (!verb || verb.creates) return no(`the page sends ${SENDS.join(", ")}, not ${event}`);
    if (!isTreeType(type)) return no(`the page acts on tasks (node), not ${type}`);
    if (id.trim() === "") return no("name the task");
    const kv = pairsOf(rest, [...(verb.field ? [verb.field.name] : []), ...(verb.extra ?? []), "note"], event);
    if ("why" in kv) return no(kv.why as string);
    const { note, blocker, ...fields } = kv;
    if (blocker !== undefined && blocker.trim() === id.trim()) return no(`${id} can't be blocked by itself`);
    return { ok: true, action: { type, id, event, payload: { ...fields, ...(blocker?.trim() ? { blocker: blocker.trim() } : {}), ...(note?.trim() ? { note } : {}) } } };
  }
  if (w[1] === "create") {
    const [, , type, name, ...rest] = w;
    if (type === undefined || name === undefined) return no('write it as: tira create node "<name>" --parent <task>');
    if (!isTreeType(type)) return no(`the page acts on tasks (node), not ${type}`);
    const at = rest.indexOf("--parent");
    const parent = at < 0 ? undefined : rest[at + 1];
    if (parent === undefined || parent.trim() === "") return no("say where it goes: --parent <task>");
    const others = rest.filter((_, i) => i !== at && i !== at + 1);
    const kv = pairsOf(others, ["kind", "discovered_during", "note"], "Add subtask");
    if ("why" in kv) return no(kv.why as string);
    const child = subtaskName(name);
    if (child === undefined) return no('give the new subtask a name: tira create node "<name>" (1 to 80 characters)');
    const found = kv.kind !== undefined || kv.discovered_during !== undefined;
    if (found && (kv.kind !== "discovered" || kv.discovered_during !== parent)) return no(`found work is marked kind=discovered discovered_during=${quote(parent)} (the task it was found under)`);
    const note = kv.note?.trim() ? { note: kv.note } : {};
    return { ok: true, action: { type, id: parent, event: "ADD_SUBTASK", child, payload: { parent_id: parent, ...(found ? { kind: "discovered", discovered_during: parent } : {}), ...note } } };
  }
  return no('the page runs tira send … or tira create …');
}

// A value the verb needs and the command left empty: said before anything is written. A
// block on a ticket needs no more: its reason defaults to "waiting on <ticket>" (withDefaults).
export function missing(a: PageAction): string | undefined {
  const field = PAGE_VERBS[a.event]?.field;
  if (!field || PAGE_VERBS[a.event]?.creates) return undefined;
  if (a.event === "BLOCK" && blockerOf(a) !== undefined) return undefined;
  const v = a.payload[field.name];
  if (typeof v === "string" && v.trim() !== "") return undefined;
  return field.name === "evidenceRef"
    ? 'Add the proof of work: evidenceRef="…" (a file, link or note anyone can re-check).'
    : 'Add the reason: reason="…" (words, not only spaces).';
}

// What the page fills in for you before writing: a block on a ticket with no reason written
// waits on that ticket.
export function withDefaults(a: PageAction): PageAction {
  const blocker = blockerOf(a);
  const reason = a.payload.reason;
  if (a.event !== "BLOCK" || blocker === undefined || (typeof reason === "string" && reason.trim() !== "")) return a;
  return { ...a, payload: { ...a.payload, reason: `waiting on ${blocker}` } };
}
