// Ranking for the ⌘K palette (the D1 UI brief: "palette finds any task in ≤3 keystrokes").
// Plain JS so the browser can load it as-is under `tira serve`, and the tests import the
// same file. Deterministic: equal scores keep the tasks' tree order.
//
// A task is { id, path, state, ... }. Words in an id split on _ - . space and camelCase.

export const VERBS = { start: "START", unblock: "UNBLOCK", complete: "COMPLETE", block: "BLOCK" };

// What each state allows from the palette (the node table, as the page sees it).
export const VERBS_BY_STATE = { unstarted: ["START", "BLOCK"], in_progress: ["COMPLETE", "BLOCK"], blocked: ["UNBLOCK"] };

const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_.\-/›]+/).filter(Boolean);

// How well `q` matches `text`: higher is better, 0 is no match.
// Separators are one space on both sides, so "loading state" finds loading_state.
const norm = (s) => s.toLowerCase().replace(/[\s_.\-/›]+/g, " ").trim();

export function score(q, text) {
  q = norm(q);
  const t = norm(text);
  if (q.length === 0) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - t.length;
  const ws = words(text);
  if (ws.map((w) => w[0]).join("").startsWith(q)) return 800 - ws.length; // initials: "lst" → loading_state_tile
  const wi = ws.findIndex((w) => w.startsWith(q));
  if (wi >= 0) return 700 - wi;
  const at = t.indexOf(q);
  if (at >= 0) return 500 - at;
  // in order, with gaps: fewer, smaller gaps rank higher
  let i = 0;
  let gaps = 0;
  for (const c of q) {
    const j = t.indexOf(c, i);
    if (j < 0) return 0;
    gaps += j - i;
    i = j + 1;
  }
  return Math.max(1, 300 - gaps);
}

// Read a query as an optional verb and a task query: "unblock col" → { verb: "UNBLOCK", q: "col" }.
// A verb counts once a space follows it, so "unblock " lists everything you could unblock.
// (an index search, not a regex: nothing here can backtrack)
export function parse(query) {
  const s = query.trimStart();
  const cut = s.search(/\s/);
  const verb = cut > 0 ? VERBS[s.slice(0, cut).toLowerCase()] : undefined;
  return verb ? { verb, q: s.slice(cut).trim() } : { verb: undefined, q: query.trim() };
}

// With nothing typed yet, what needs you comes first: the next task, then work in progress,
// then blocked work, then the rest to do; closed work last.
const FIRST = { in_progress: 3, blocked: 2, unstarted: 1 };
export const priority = (task) => (task.next ? 4 : FIRST[task.state] ?? 0);

// A task's key (TIRA_<PROJECT>_<n>) counts once the query is one: its number alone, or the key itself.
// Not before, or "t" would find every task by its key's TIRA.
function keyScore(q, ticket) {
  if (!ticket) return 0;
  if (/^\d+$/.test(q)) return ticket.endsWith(`_${q}`) ? 950 : 0;
  return /^tira[\s_]/i.test(q) ? score(q, ticket) : 0;
}

// The best matches, best first. With a verb, only tasks whose state allows it.
export function rank(query, tasks, limit = 8) {
  const { verb, q } = parse(query);
  const scored = [];
  tasks.forEach((task, order) => {
    if (verb && !(VERBS_BY_STATE[task.state] ?? []).includes(verb)) return;
    const s = q === "" ? 1 + priority(task) : Math.max(score(q, task.id), keyScore(q.trim(), task.ticket), Math.floor(score(q, task.path ?? "") / 4));
    if (s > 0) scored.push({ task, s, order });
  });
  scored.sort((a, b) => b.s - a.s || a.order - b.order);
  return { verb, results: scored.slice(0, limit).map((x) => x.task) };
}
