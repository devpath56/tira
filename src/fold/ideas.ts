// Ideas to tickets (the vapor catch, build plan D5): what an idea says, and where tira puts it.
//
// An agent pushes an idea in a sentence (`tira idea "<summary>" --why "<why>" [--under <task>]`).
// tira drafts its file record from those two lines, and once a person approves the file, tira
// proposes the task it goes under (fold/handoffs.ts writes both, as the dispatcher). The parent is
// worked out from two sources together: the task the idea was declared under, if any, and the
// tasks its text names. When they agree, or only one gives a task that can take a new subtask,
// that task is proposed. When they disagree, or neither gives one, the proposal names no parent
// and lists the candidates: a person picks one when approving the placement.
//
// Everything here is a pure function of the stream as folded (and the registry's rules), so the
// dispatcher, the fold's replay check, the CLI and the page all reach the same answer.
import type { StoredEvent } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import type { FoldResult } from "./fold.ts";
import { evaluate } from "./evaluate.ts";
import { REJECTED, type EventData } from "./events.ts";
import type { EntityState, StateView } from "./types.ts";
import { compareCodeUnits } from "./view.ts";

export const IDEA = "idea";
export const TASK = "node"; // the tree type an approved idea is born into (handoff F1)

// The idea's file record: exactly two lines of text, what it is and why.
export interface IdeaFile { summary: string; why?: string }

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

// The file a payload carries (a declaration or a drafted file), or undefined without a summary.
export function fileFrom(p: Record<string, unknown> | undefined): IdeaFile | undefined {
  const summary = text(p?.summary);
  if (summary === undefined) return undefined;
  const why = text(p?.why);
  return why === undefined ? { summary } : { summary, why };
}

// Where tira would put an idea: the parent, when it is settled, else the candidates for a person.
export interface Placement {
  parent?: string;
  candidates: string[];
  basis: string; // plain words: how it was decided, or why it needs a person
}

// The proposal as PROPOSE_NODE carries it.
export const proposalPayload = (p: Placement): Record<string, unknown> => ({
  ...(p.parent === undefined ? {} : { parent_id: p.parent }),
  candidates: p.candidates,
  basis: p.basis,
});

const STATE_WORD: Record<string, string> = { unstarted: "to do", in_progress: "in progress", blocked: "blocked", done: "done", cancelled: "cancelled" };

// Why `parent` can't take the task an idea becomes, in plain words, or undefined when it can. The
// same check the birth itself runs (evaluate), judged for a stand-in id, so a taken id doesn't
// read as the parent's fault.
export function parentProblem(view: StateView, registry: Registry, parent: string): string | undefined {
  const p = view.get({ type: TASK, id: parent });
  if (!p?.tree) return `there is no task ${parent}`;
  let stand = "(an idea)";
  while (view.get({ type: TASK, id: stand })) stand += "'";
  const entities = new Map(view.all().map((e) => [e.key, e]));
  const ev = evaluate(registry, entities, view, { kind: "create", entity: { type: TASK, id: stand }, payload: { parent_id: parent }, actor: undefined });
  if (ev.ok) return undefined;
  const state = p.regions[registry.get(TASK)?.tree?.region ?? "lifecycle"] ?? "";
  if (ev.code === "denied") return `${parent} is ${STATE_WORD[state] ?? state}: it can't take a new task`;
  if (ev.code === "tree-cap") return `${parent} can't take another task (${ev.detail})`;
  return `${parent} can't take it (${ev.code}: ${ev.detail})`;
}

// Why an idea can't be approved into a task under `parent`, or undefined when it can: the task it
// becomes keeps its id, so that id must be free, and the parent must take a new task.
export function placeProblem(view: StateView, registry: Registry, ideaId: string, parent: string): string | undefined {
  if (view.get({ type: TASK, id: ideaId })) return `a task named ${ideaId} already exists, so the idea can't become one`;
  return parentProblem(view, registry, parent);
}

// Words as the matcher compares them: lowercase letters and digits, single spaces, padded.
const words = (s: string) => ` ${s.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

// Words that say nothing about which task: never a task's name to match, never in an id.
const FILLER = new Set(("a an the and or but of to in on at for with by from into onto under over about as is are was were be been being it its "
  + "this that these those we i you they he she would could should will can may might must shall do does did have has had need needs "
  + "needed want wants good nice great better more less some any all add adding make making get please also just really very so too "
  + "then than there here when what which who how why maybe idea ideas let lets our my your").split(" "));

// The tasks an idea's text names, by id ("metrics_card" reads as "metrics card"; a plural "s" is
// fine), most specific only: a task drops out when another one it names sits under it.
export function mentioned(view: StateView, said: string): string[] {
  const t = words(said);
  const hits = view.all(TASK).filter((n) => {
    const name = words(n.id);
    if (name.trim().length < 3 || FILLER.has(name.trim())) return false;
    return t.includes(name) || t.includes(`${name.trimEnd()}s `);
  });
  const above = (a: EntityState, b: EntityState) => {
    for (let k = b.tree?.parent; k !== undefined; k = view.getKey(k)?.tree?.parent) if (k === a.key) return true;
    return false;
  };
  return hits.filter((h) => !hits.some((o) => o !== h && above(h, o))).map((h) => h.id).sort(compareCodeUnits);
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// The parent for an idea: the task it was declared under and the tasks its summary names (its why,
// when the summary names none) together. Disagreement, or nothing usable, goes to a person.
export function placement(view: StateView, registry: Registry, file: IdeaFile, under?: string): Placement {
  const named = text(under);
  const summaryHits = mentioned(view, file.summary);
  const hits = summaryHits.length > 0 || file.why === undefined ? summaryHits : mentioned(view, file.why);
  const usable = hits.filter((h) => parentProblem(view, registry, h) === undefined);
  const textSays = usable.length > 0 ? `; its text names ${list(usable)}` : "";
  if (named !== undefined) {
    const problem = parentProblem(view, registry, named);
    if (problem !== undefined) return { candidates: usable, basis: `needs you: it was declared under ${named}, but ${problem}${textSays}` };
    if (usable.length === 0) return { parent: named, candidates: [named], basis: `declared under ${named}` };
    if (usable.includes(named)) return { parent: named, candidates: [named], basis: `declared under ${named}, and its text names ${named} too` };
    return { candidates: [named, ...usable], basis: `needs you: it was declared under ${named}, but its text names ${list(usable)}` };
  }
  if (usable.length === 1) return { parent: usable[0] as string, candidates: usable, basis: `its text names ${usable[0]}` };
  if (usable.length > 1) return { candidates: usable, basis: `needs you: its text names ${list(usable)}` };
  const blocked = hits.map((h) => parentProblem(view, registry, h)).filter((x): x is string => x !== undefined);
  if (blocked.length > 0) return { candidates: [], basis: `needs you: ${blocked.join("; ")}` };
  return { candidates: [], basis: "needs you: it names no task, and it wasn't declared under one" };
}

// An id for a new idea, from its summary: up to three words that aren't filler or its parent's
// name ("pagination would be good in table" under table: pagination), free as an idea and as a
// task (the task it becomes takes the same id).
export function ideaId(view: StateView, summary: string, parent?: string): string {
  const skip = new Set(parent === undefined ? [] : words(parent).trim().split(" ").flatMap((w) => [w, `${w}s`]));
  const picked = words(summary).trim().split(" ").filter((w) => w !== "" && !FILLER.has(w) && !skip.has(w)).slice(0, 3);
  const base = picked.length > 0 ? picked.join("_") : "idea";
  const free = (id: string) => !view.get({ type: IDEA, id }) && !view.get({ type: TASK, id });
  if (free(base)) return base;
  let n = 2;
  while (!free(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

// ---------- the ideas as the page and `tira ideas` read them ----------

// Each stage in a few words. A placement with no parent waits for a person to pick one.
export const STAGE: Record<string, string> = {
  declared: "declared",
  file_pending: "file to approve",
  filed: "file approved",
  node_pending: "placement to approve",
  materialized: "a task now",
  dropped: "dropped",
};
export const OPEN_STAGES = new Set(["declared", "file_pending", "filed", "node_pending"]);

export interface IdeaRow {
  key: string;
  id: string;
  stage: string; // the idea's lifecycle state
  summary?: string; // the file record (as drafted, else as declared)
  why?: string;
  under?: string; // the task it was declared under, if any
  declaredBy?: string;
  declaredSeq: number;
  proposal?: Placement & { seq: number }; // tira's latest proposal, once made
  placedUnder?: string; // the parent the placement was approved with
  reason?: string; // why it was dropped
}

export const stageWord = (i: IdeaRow): string => (i.stage === "node_pending" && i.proposal?.parent === undefined ? "needs a parent" : STAGE[i.stage] ?? i.stage);

// tira's proposal, as a propose-node event carried it.
function proposalFrom(p: Record<string, unknown>, seq: number): Placement & { seq: number } {
  const parent = text(p.parent_id);
  const candidates = Array.isArray(p.candidates) ? p.candidates.filter((c): c is string => typeof c === "string") : [];
  return { ...(parent === undefined ? {} : { parent }), candidates, basis: text(p.basis) ?? "", seq };
}

// What one idea event adds to its row.
function applyIdeaEvent(row: IdeaRow, ev: string, p: Record<string, unknown>, seq: number): void {
  if (ev === "created" || ev === "draft-file") Object.assign(row, fileFrom(p) ?? {});
  const under = text(p.under);
  const parent = text(p.parent_id);
  const reason = text(p.reason);
  if (ev === "created" && under !== undefined) row.under = under;
  if (ev === "propose-node") row.proposal = proposalFrom(p, seq);
  if (ev === "approve-node" && parent !== undefined) row.placedUnder = parent;
  if ((ev === "reject-file" || ev === "reject-node") && reason !== undefined) row.reason = reason;
}

// Every idea in a stream, in the order they were declared, from the events replay applied.
export function ideaRows(r: FoldResult, events: readonly StoredEvent[], stream: string): IdeaRow[] {
  const skip = new Set(r.anomalies.filter((a) => a.stream === stream).map((a) => a.seq));
  const rows = new Map<string, IdeaRow>();
  for (const e of r.entities) {
    if (e.stream === stream && e.type === IDEA) rows.set(e.key, { key: e.key, id: e.id, stage: e.regions.lifecycle ?? "", declaredSeq: e.createdSeq, ...(e.createdBy === undefined ? {} : { declaredBy: e.createdBy }) });
  }
  for (const e of events) {
    if (e.stream !== stream || e.seq > r.lastSeq || skip.has(e.seq) || e.type === REJECTED || !e.type.startsWith(`${IDEA}.`)) continue;
    const d = e.data as unknown as EventData;
    const row = rows.get(`${IDEA}:${d?.entity?.id}`);
    if (!row) continue;
    applyIdeaEvent(row, e.type.slice(IDEA.length + 1), d.payload ?? {}, e.seq);
  }
  return [...rows.values()].sort((a, b) => a.declaredSeq - b.declaredSeq);
}
