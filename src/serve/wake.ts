// An agent that starts when it's @mentioned (Isha, 2026-10-26: "when I tag claude in tira, it should
// start working on it by default"). Its Claude Code routine (claude.ai/code/routines: a saved prompt,
// its repository and connectors, tira's among them) has an API trigger: an address and a token. When
// a person @mentions the agent in a task's comments, or gives it a task, tira starts the routine
// once, with what was asked; the routine runs in Anthropic's cloud, reads the task through tira's
// connector, does the work and answers on the task. The answer comes back to tira as the session's
// address, kept with the task. Only Anthropic's own routine address is called (nothing else can be
// named), the token is never shown again once saved, and the same agent isn't started on the same
// task twice within a few minutes: a run already going reads the new comments itself.
// The API: https://platform.claude.com/docs/en/api/claude-code/routines-fire

export const ROUTINE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]{6,64}\/fire$/;
export const ROUTINE_TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{16,256}$/;
export const ANTHROPIC_VERSION = "2026-10-21";
export const AGAIN_AFTER_MS = 2 * 60_000;
const MAX_TEXT = 65_536;

// what's wrong with a routine as given, in plain words (undefined: it's fine)
export function routineProblem(url: string, token: string): string | undefined {
  if (!ROUTINE_URL.test(url)) return "That isn't a routine's API address: it looks like https://api.anthropic.com/v1/claude_code/routines/trig_…/fire.";
  if (!ROUTINE_TOKEN.test(token)) return "That isn't a routine's token: it starts with sk-ant-oat01-.";
  return undefined;
}

// What the run is started with, beside the routine's own prompt: who asked what, on which task, and
// how to answer through tira.
export interface Asked { agent: string; by: string; key: string; title: string; project: string; why: "mentioned" | "assigned"; words?: string }
export function wakeText(a: Asked): string {
  const what = a.why === "mentioned" ? `${a.by} mentioned you (@${a.agent}) on ${a.key}` : `${a.by} gave you ${a.key}`;
  const said = a.words ? `\n\nWhat they wrote:\n${a.words}` : "";
  return (`tira: ${what}, "${a.title}", in the project "${a.project}".${said}\n\n`
    + `Through tira's connector, as ${a.agent}: get_task ${a.key} to read the ticket and its comments, do the work, `
    + `reply on the task with add_comment, and complete_task with its proof. If a person has to decide something, `
    + `@mention them in a comment and stop there.\n\n${REPLY_STYLE}`).slice(0, MAX_TEXT);
}

// How an agent answers on a task (Isha, 2026-10-26: "very precise and clear, fewer words, only bullet points")
export const REPLY_STYLE = "Reply in a few short bullet points ('- ' at the start of each line): what you did, what's left, what you need. No preamble, no restating the question, no sign-off.";
// The prompt to give the routine, once, when it's made: what each run is for.
export const WAKE_PROMPT = "You work tasks in tira, through its connector. Each run starts with what someone asked, and on which task. "
  + "Read the task with get_task, do the work in this repository, reply on the task with add_comment, and finish with complete_task, "
  + "giving its proof (for code, a commit or pull request). If a person has to decide something, @mention them in a comment and stop there. "
  + REPLY_STYLE;

export type Fired = { ok: true; session: string } | { ok: false; why: string };
export type Fire = (url: string, token: string, text: string) => Promise<Fired>;

// The call itself: once (the endpoint has no idempotency key, so a retry would start a second run).
export const fireRoutine: Fire = async (url, token, text) => {
  if (!ROUTINE_URL.test(url)) return { ok: false, why: "its address isn't a routine's" };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "anthropic-version": ANTHROPIC_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await r.json().catch(() => ({}))) as { claude_code_session_url?: unknown; error?: { message?: unknown } };
    if (r.ok && typeof body.claude_code_session_url === "string" && body.claude_code_session_url.startsWith("https://claude.ai/")) return { ok: true, session: body.claude_code_session_url };
    if (r.status === 401) return { ok: false, why: "the routine's token was refused: make a new one and save it again" };
    if (r.status === 429) return { ok: false, why: "the routine has been started too often this hour" };
    if (r.status === 400) return { ok: false, why: "the routine is paused, or refused the request" };
    return { ok: false, why: `the routine didn't start (HTTP ${r.status})` };
  } catch {
    return { ok: false, why: "Anthropic didn't answer in time" };
  }
};

// Not twice on the same task within a few minutes, per process: the run already going reads what's new.
export class WakeGate {
  private readonly last = new Map<string, number>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  open(stream: string, task: string, agent: string): boolean {
    const key = `${stream}\u0000${task}\u0000${agent}`;
    const t = this.now();
    const was = this.last.get(key);
    if (was !== undefined && t - was < AGAIN_AFTER_MS) return false;
    this.last.set(key, t);
    if (this.last.size > 500) this.last.delete(this.last.keys().next().value as string);
    return true;
  }
}
