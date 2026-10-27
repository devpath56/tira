// Review before done (Isha, 2026-10-26: "an adversarial check of the work, by a model from Muse; if
// any issue gets flagged, a subtask is created to fix it, and that also gets reviewed"; then "a human
// marks a task REVIEW, and only then it needs one"). When a task marked for review is completed, by a person on the page or an agent through tira's MCP server, tira first asks a
// reviewer (Meta's Muse, through the Meta Model API) to check the work against its ticket: its
// description, steps, kind of work and proof. Passed: tira says so on the task, and the task is done.
// Problems: each becomes a fix subtask under the task, found while reviewing it, so tira's own rule
// (subtasks close first) keeps the task open until they're fixed; completing it again asks for a new
// review. A person has the final say: on the page they can complete it without review, and after
// MAX_ROUNDS reviews that asked for changes, only a person can. The reviewer is never the one who did
// the work. Its words go on the task as comments, under its own name, with what the review used.
// The API: https://dev.meta.ai/docs/features/chat-completion (OpenAI-compatible chat completions).
import type { Kind } from "../fold/kinds.ts";

export const REVIEWER = "muse-review-bot"; // reads as an agent's name (src/render/html.ts AGENT)
export const MUSE_URL = "https://api.meta.ai/v1/chat/completions";
export const MUSE_MODEL = "muse-spark-1.3";
export const MAX_ROUNDS = 3;
export const MAX_FINDINGS = 5;
const MAX_FIELD = 400;

export interface Finding { title: string; why: string; fix: string }
// what the reviewer is shown: the ticket, its kind and what proof of it looks like, the proof given
// (and what tira knows of it: a commit's message), and the latest comments on it
export interface ReviewAsk { key: string; title: string; kind: Kind; proofFor: string; description: string; steps: string[]; proof: string; proofDetail: string; comments: string[] }
export type Verdict = { ok: true; pass: boolean; summary: string; findings: Finding[]; tokens: number } | { ok: false; why: string };
export type Reviewer = (a: ReviewAsk) => Promise<Verdict>;

// the Meta Model API key, from tira's settings (TIRA_MODEL_API_KEY, else MODEL_API_KEY): none, no review
export const reviewKey = (env: Record<string, string | undefined>): string | undefined => env.TIRA_MODEL_API_KEY?.trim() || env.MODEL_API_KEY?.trim() || undefined;

export const REVIEW_PROMPT = [
  "You review finished work before it is marked done, as an adversarial reviewer: your job is to find what is missing, wrong or unproven, not to praise.",
  "Judge the work only against its ticket (title, description, steps) and its proof. The proof is the only evidence: a step the proof doesn't show was done is a finding.",
  "Keep to real problems a reasonable lead would send back, at most five, each with a short title (under 80 characters), why it matters, and the fix.",
  "If the work does what the ticket asks and the proof shows it, the verdict is pass, with no findings.",
].join(" ");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "changes"] },
    summary: { type: "string", description: "one or two sentences on the work as it stands" },
    findings: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["title", "why", "fix"], properties: { title: { type: "string" }, why: { type: "string" }, fix: { type: "string" } } },
    },
  },
};

// what the reviewer reads, in plain text
export function reviewInput(a: ReviewAsk): string {
  const steps = a.steps.length === 0 ? "(none written)" : a.steps.map((x, i) => `${i + 1}. ${x}`).join("\n");
  const said = a.comments.length === 0 ? "(none)" : a.comments.join("\n");
  return [
    `Task ${a.key}: ${a.title}`, `Work type: ${a.kind}. Proof for it should be ${a.proofFor}.`,
    `Description:\n${a.description || "(none written)"}`, `Steps:\n${steps}`,
    `Proof given: ${a.proof}${a.proofDetail ? "\n" + a.proofDetail : ""}`, `Latest comments:\n${said}`,
  ].join("\n\n");
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// A reviewer's answer, read strictly: a verdict, a summary, and findings (at most MAX_FINDINGS, each
// with words); "pass" with findings, or "changes" with none, isn't an answer.
export function verdictOf(content: unknown, tokens: number): Verdict {
  let v: { verdict?: unknown; summary?: unknown; findings?: unknown };
  try {
    v = JSON.parse(String(content)) as typeof v;
  } catch {
    return { ok: false, why: "its answer wasn't the verdict it was asked for" };
  }
  const findings = (Array.isArray(v.findings) ? v.findings : []).map((f: { title?: unknown; why?: unknown; fix?: unknown }) => ({ title: clip(text(f.title), 80), why: clip(text(f.why), MAX_FIELD), fix: clip(text(f.fix), MAX_FIELD) }))
    .filter((f) => f.title !== "").slice(0, MAX_FINDINGS);
  const pass = v.verdict === "pass";
  if ((v.verdict !== "pass" && v.verdict !== "changes") || pass !== (findings.length === 0)) return { ok: false, why: "its answer wasn't the verdict it was asked for" };
  return { ok: true, pass, summary: clip(text(v.summary), MAX_FIELD), findings, tokens };
}

// Muse, through the Meta Model API: one chat completion, its answer held to the verdict's shape
export function museReviewer(key: string, model = MUSE_MODEL): Reviewer {
  return async (a) => {
    try {
      const r = await fetch(MUSE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: REVIEW_PROMPT }, { role: "user", content: reviewInput(a) }],
          response_format: { type: "json_schema", json_schema: { name: "Review", strict: true, schema: SCHEMA } },
          reasoning_effort: "medium",
          max_completion_tokens: 4000,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: unknown } }[]; usage?: { total_tokens?: unknown } };
      if (r.status === 401 || r.status === 403) return { ok: false, why: "the Meta Model API key was refused" };
      if (r.status === 429) return { ok: false, why: "the Meta Model API is busy or out of quota" };
      if (!r.ok) return { ok: false, why: `the Meta Model API answered HTTP ${r.status}` };
      const tokens = Number(body.usage?.total_tokens ?? 0);
      return verdictOf(body.choices?.[0]?.message?.content, Number.isFinite(tokens) ? tokens : 0);
    } catch {
      return { ok: false, why: "the Meta Model API didn't answer in time" };
    }
  };
}

// The comment the reviewer leaves on the task, by verdict; and how many reviews asked for changes
export const PASSED = "Review: passed.";
export const CHANGES = "Review: changes asked.";
export const passedText = (v: { summary: string; tokens: number }) => `${PASSED} ${v.summary} (${v.tokens.toLocaleString("en")} tokens)`.trim();
export function changesText(v: { summary: string; findings: Finding[]; tokens: number }): string {
  const list = v.findings.map((f, i) => `${i + 1}. ${f.title}: ${f.why}`).join("\n");
  return `${CHANGES} ${v.summary}\n\n${list}\n\nEach is a fix subtask under this task. (${v.tokens.toLocaleString("en")} tokens)`;
}
export const roundsOf = (comments: readonly { by: string; text: string }[]) => comments.filter((c) => c.by === REVIEWER && c.text.startsWith(CHANGES)).length;
