// One task's commits, looked up on GitHub when it's about to be completed (the Complete dialog, and an
// agent's complete_task): only that task's, not a whole sync, and kept for it as the sync keeps them
// (src/tables/tickets.ts), under the sync's reserved name.
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { fold } from "../fold/fold.ts";
import { linksOf, tasksNamed, workspaceOf } from "../fold/workspace.ts";
import { COMMIT } from "../tables/tickets.ts";
import { WritePath } from "../write/write-path.ts";
import type { GitHubClient, TaskCommit } from "./github.ts";

// The task's commits on GitHub: straight from it when the client can (taskCommitsVia), else from
// its pull requests (a stand-in that only lists pulls).
export async function taskCommits(client: GitHubClient, repo: string, task: string, linked: readonly number[]): Promise<TaskCommit[]> {
  if (client.taskCommits) return client.taskCommits(repo, task, linked);
  const pulls = await client.pulls(repo);
  return pulls.filter((p) => linked.includes(p.number) || tasksNamed(p, new Set([task]), new Map()).includes(task))
    .flatMap((p) => (p.shas ?? []).map((sha, i) => ({ sha, message: p.commits[i] ?? "", pr: p.number, branch: p.branch })))
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha));
}

export interface Looked { found: number; kept: number }

// Look on GitHub for a task's commits and keep the new ones: how many it found, and how many were new.
// Undefined when the project links no repo.
export async function lookForCommits(store: EventStore, registry: Registry, stream: string, task: string, client: GitHubClient): Promise<Looked | undefined> {
  const r = fold(await store.readStream(stream), registry);
  const repo = workspaceOf(r, stream)?.repo;
  if (!repo) return undefined;
  const linked = (linksOf(r, stream).get(task)?.prs ?? []).map((p) => p.number);
  const found = await taskCommits(client, repo, task, linked);
  const wp = new WritePath(store, registry);
  const have = new Set(r.entities.filter((e) => e.stream === stream && e.type === COMMIT).map((e) => e.id));
  let kept = 0;
  for (const c of found) {
    const id = `${c.sha.slice(0, 12)}-${task}`;
    if (have.has(id)) continue;
    have.add(id);
    const payload = { task, repo, sha: c.sha, ...(c.pr === undefined ? {} : { pr: c.pr }), ...(c.branch ? { branch: c.branch } : {}), message: c.message.slice(0, 300) };
    const w = await wp.submitAsSync({ stream, kind: "create", entity: { type: COMMIT, id }, payload });
    if (w.status === "appended") kept++;
  }
  return { found: found.length, kept };
}

// What a look said, in words: what it found, that the project links no repo, or why GitHub couldn't be reached.
export async function lookedSaid(task: string, look: () => Promise<Looked | undefined>): Promise<string> {
  try {
    const l = await look();
    if (!l) return "No GitHub repo linked to this project.";
    if (l.found === 0) return `No commits for ${task} on GitHub yet.`;
    const noun = l.found === 1 ? "commit" : "commits";
    return `${l.found} ${noun} on GitHub${l.kept > 0 ? ` (${l.kept} new)` : ""}.`;
  } catch (err) {
    return `Couldn't reach GitHub (${(err as Error).message}).`;
  }
}
