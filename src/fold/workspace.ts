// What a workspace's links say, read from the fold (src/tables/links.ts): the workspace's
// current link, each task's Jira issue and pull requests, and which tasks a pull request names.
// Read-only: the page, the CLI and the sync (src/sync/sync.ts) share it.
import type { FoldResult } from "./fold.ts";
import { compareCodeUnits } from "./view.ts";
import { JIRA_ISSUE, JIRA_KEY, PR, WORKSPACE, type Category } from "../tables/links.ts";
import type { Pull } from "../sync/github.ts";

// s without the run of ch at its end (a loop, not a /ch+$/ regex: that one backtracks on a long run)
const trimEnd = (s: string, ch: string): string => {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
};

export interface WorkspaceLink { version: number; repo?: string; jira_site?: string; jira_project?: string; by?: string; title?: string; deleted?: true }

// The workspace's current link: its latest version's links; its name (title) and whether it was
// deleted as the latest version that said so (a later link change that doesn't mention them keeps them).
export function workspaceOf(r: FoldResult, stream: string): WorkspaceLink | undefined {
  const all = r.entities.filter((e) => e.stream === stream && e.type === WORKSPACE).sort((a, b) => (a.version ?? 0) - (b.version ?? 0));
  const latest = all.at(-1);
  if (!latest) return undefined;
  const b = latest.born ?? {};
  const str = (k: string) => (typeof b[k] === "string" ? { [k]: b[k] as string } : {});
  const title = all.reduce<string | undefined>((t, e) => (typeof e.born?.title === "string" ? e.born.title : t), undefined);
  const deleted = all.some((e) => e.born?.deleted === true);
  return { version: latest.version ?? 1, ...str("repo"), ...str("jira_site"), ...str("jira_project"), ...(latest.createdBy ? { by: latest.createdBy } : {}), ...(title !== undefined ? { title } : {}), ...(deleted ? { deleted: true as const } : {}) };
}

export interface TaskLinks {
  // category/status: where the issue was in Jira when tira last looked or set it; tira: where its
  // task was then (absent on older records: the same as category)
  jira?: { key: string; category?: Category; status?: string; tira?: Category };
  prs: { repo: string; number: number; url: string; title: string; state: string; mergedAt?: string }[];
}

// Each task's Jira issue and pull requests, by task id.
export function linksOf(r: FoldResult, stream: string): Map<string, TaskLinks> {
  const out = new Map<string, TaskLinks>();
  const at = (task: string) => {
    let l = out.get(task);
    if (!l) out.set(task, (l = { prs: [] }));
    return l;
  };
  for (const e of r.entities) {
    if (e.stream !== stream) continue;
    const b = e.born ?? {};
    if (typeof b.task !== "string") continue;
    const ctx = e.context?.lifecycle ?? {};
    if (e.type === JIRA_ISSUE && typeof b.key === "string") {
      at(b.task).jira = {
        key: b.key,
        ...(typeof ctx.category === "string" ? { category: ctx.category as Category } : {}),
        ...(typeof ctx.status === "string" ? { status: ctx.status } : {}),
        ...(typeof ctx.tira === "string" ? { tira: ctx.tira as Category } : {}),
      };
    }
    if (e.type === PR) {
      at(b.task).prs.push({
        repo: String(b.repo), number: Number(b.number), url: String(b.url), title: String(b.title ?? ""), state: e.regions.lifecycle ?? "open",
        ...(typeof ctx.merged_at === "string" ? { mergedAt: ctx.merged_at } : {}),
      });
    }
  }
  for (const l of out.values()) l.prs.sort((a, b) => a.number - b.number);
  return out;
}

// The tasks a pull request names: "tira: <id>" anywhere, a branch segment equal to an id, or a
// task's Jira key. Only tasks that exist count.
export function tasksNamed(p: Pull, tasks: ReadonlySet<string>, byKey: ReadonlyMap<string, string>): string[] {
  const text = [p.title, p.body, ...p.commits].join("\n");
  const found = new Set<string>();
  for (const m of text.matchAll(/\btira:\s*([A-Za-z0-9][\w.-]*)/gi)) {
    const id = trimEnd(m[1] ?? "", ".");
    if (tasks.has(id)) found.add(id);
  }
  for (const seg of p.branch.split("/")) if (tasks.has(seg)) found.add(seg);
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{0,19}-\d+\b/g)) {
    const task = byKey.get(m[0]);
    if (task !== undefined && JIRA_KEY.test(m[0])) found.add(task);
  }
  return [...found].sort(compareCodeUnits);
}
