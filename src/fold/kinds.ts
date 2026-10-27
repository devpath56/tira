// Work types (Isha, 2026-10-26: "engineering work is proven by a pull request or commits, spec
// hardening by a Claude artifact or an alternative"). Each task has a kind: the one its ticket says,
// or else tira's guess from the ticket's words (and the task's id), which whoever writes the ticket
// can change. The kind says what proof of the work looks like, so the agent and the reviewer know
// what to look for. Pure: words in, a kind out.

export const KINDS = ["code", "spec", "design", "research", "data", "testing", "ops", "decision", "docs", "other"] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (x: string): x is Kind => (KINDS as readonly string[]).includes(x);

export const KIND_WORD: Record<Kind, string> = {
  code: "Code", spec: "Spec", design: "Design", research: "Research", data: "Data", testing: "Testing",
  ops: "Ops", decision: "Decision", docs: "Docs", other: "Other",
};

// What counts as proof, in a line: what the agent hands in and the reviewer reads (Isha, 2026-10-26:
// "only for code a PR is a must, otherwise any link or screenshot")
const ANY_LINK = "a link to the work (a Claude artifact, a doc, a Figma frame…), or a file added on the page (a screenshot, a PDF)";
export const PROOF_FOR: Record<Kind, string> = {
  code: "a commit or a pull request on the project's repo (checked on GitHub)",
  spec: ANY_LINK, design: ANY_LINK, research: ANY_LINK, data: ANY_LINK, testing: ANY_LINK, ops: ANY_LINK, decision: ANY_LINK, docs: ANY_LINK, other: ANY_LINK,
};

// The words that point at a kind, strongest first. A word counts once, whole (so "test" doesn't
// light up "latest"), and the kind with the most words wins; a tie goes to the earlier kind. No word
// at all: code, as tira's work has always been proven (a commit or a pull request); "other" only
// when someone says so.
const SIGNS: [Kind, RegExp][] = [
  ["spec", /\b(spec|specs|specification|requirements?|prd|scope|hardening|harden|proposal|rfc|acceptance criteria|user stor(?:y|ies))\b/g],
  ["decision", /\b(decide|decision|decisions|choose|pick|sign[- ]?off|approve|approval|adr)\b/g],
  ["design", /\b(design|mockup|mock-up|wireframe|figma|ux|ui|prototype|layout|visual)\b/g],
  ["research", /\b(research|investigate|explore|compare|survey|interview|analy[sz]e|analysis|study|benchmark)\b/g],
  ["data", /\b(data|dataset|metrics?|notebook|model|eval|evals|sql|query|etl|pipeline)\b/g],
  ["testing", /\b(test|tests|testing|qa|e2e|regression|verify|coverage|smoke)\b/g],
  ["ops", /\b(deploy|deployment|release|infra|infrastructure|ci|cd|incident|on-?call|monitor|alerts?|cron|schedule|backup)\b/g],
  ["docs", /\b(docs?|documentation|readme|guide|tutorial|write-?up|blog|changelog|help)\b/g],
  ["code", /\b(build|implement|code|fix|bug|refactor|api|endpoint|function|feature|script|fetcher|reader|parser|integrate|integration|migrate|ship)\b/g],
];

export function guessKind(words: string): Kind {
  const text = words.toLowerCase().replaceAll("_", " ");
  let best: Kind = "code";
  let most = 0;
  for (const [kind, sign] of SIGNS) {
    const n = new Set(text.match(sign) ?? []).size;
    if (n > most) {
      best = kind;
      most = n;
    }
  }
  return best;
}

// A task's kind: its ticket's own, else the guess (and whether it is one)
export function kindOf(id: string, t: { kind?: string; title?: string; description?: string } | undefined): { kind: Kind; guessed: boolean } {
  if (t?.kind && isKind(t.kind)) return { kind: t.kind, guessed: false };
  return { kind: guessKind([id, t?.title ?? "", t?.description ?? ""].join(" ")), guessed: true };
}
