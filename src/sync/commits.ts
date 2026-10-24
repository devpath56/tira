// What a task can be completed with, looked up on GitHub when it's about to be (the Complete dialog,
// and an agent's complete_task): its own commits (only that task's, not a whole sync), kept for it as
// the sync keeps them (src/tables/tickets.ts), under the sync's reserved name; the repo's latest
// commits and pull requests, to pick from; and any one commit or pull request of the repo, checked
// on GitHub and kept for the task once it's picked.
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { fold } from "../fold/fold.ts";
import { linksOf, tasksNamed, workspaceOf } from "../fold/workspace.ts";
import { COMMIT, SHA } from "../tables/tickets.ts";
import { PR } from "../tables/links.ts";
import { WritePath } from "../write/write-path.ts";
import type { GitHubClient, Recent, TaskCommit } from "./github.ts";

// The task's commits on GitHub: straight from it when the client can (taskCommitsVia), else from
// its pull requests (a stand-in that only lists pulls).
export async function taskCommits(client: GitHubClient, repo: string, task: string, linked: readonly number[]): Promise<TaskCommit[]> {
  if (client.taskCommits) return client.taskCommits(repo, task, linked);
  const pulls = await client.pulls(repo);
  return pulls.filter((p) => linked.includes(p.number) || tasksNamed(p, new Set([task]), new Map()).includes(task))
    .flatMap((p) => (p.shas ?? []).map((sha, i) => ({ sha, message: p.commits[i] ?? "", pr: p.number, branch: p.branch })))
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha));
}

export interface Looked { found: number; kept: number; recent?: Recent }

// Look on GitHub for a task's commits and keep the new ones: how many it found, and how many were new.
// Undefined when the project links no repo.
export async function lookForCommits(store: EventStore, registry: Registry, stream: string, task: string, client: GitHubClient): Promise<Looked | undefined> {
  const r = fold(await store.readStream(stream), registry);
  const repo = workspaceOf(r, stream)?.repo;
  if (!repo) return undefined;
  const linked = (linksOf(r, stream).get(task)?.prs ?? []).map((p) => p.number);
  const [found, recent] = await Promise.all([taskCommits(client, repo, task, linked), client.recent ? client.recent(repo) : undefined]);
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
  return { found: found.length, kept, ...(recent ? { recent } : {}) };
}

// A proof someone named (a commit id, 7 or more of its first characters, or a pull request: #12, 12
// or its link), checked on GitHub against the project's repo and kept for the task (a commit as one
// of its commits, a pull request linked to it): the proof to write (a commit's whole id, a pull
// request's link), or why it can't be.
export async function proveWith(store: EventStore, registry: Registry, stream: string, task: string, client: GitHubClient, ref: string): Promise<{ ref: string } | { why: string }> {
  const r = fold(await store.readStream(stream), registry);
  const repo = workspaceOf(r, stream)?.repo;
  if (!repo) return { why: "No GitHub repo linked to this project." };
  const wp = new WritePath(store, registry);
  const said = ref.trim();
  // #12 or a link is a pull request; a bare number too, up to 6 digits (7 or more reads as a commit's id)
  const pr = /^#(\d{1,7})$/.exec(said) ?? /^(\d{1,6})$/.exec(said) ?? new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, "\\.")}/pull/(\\d{1,7})/?$`, "i").exec(said);
  if (pr) {
    const p = client.pull ? await client.pull(repo, Number(pr[1])) : undefined;
    if (!p) return { why: `No pull request #${pr[1]} in ${repo}.` };
    const id = `${repo}#${p.number}/${task}`;
    if (!r.entities.some((e) => e.stream === stream && e.type === PR && e.id === id)) {
      const w = await wp.submitAsSync({ stream, kind: "create", entity: { type: PR, id }, payload: { task, repo, number: p.number, url: p.url, title: p.title.slice(0, 200) } });
      if (w.status !== "appended") return { why: `Couldn't link #${p.number} to ${task}.` };
    }
    return { ref: p.url };
  }
  if (!/^[0-9a-f]{7,40}$/i.test(said)) return { why: "Name a commit (its id) or a pull request (#12, or its link)." };
  const c = client.commit ? await client.commit(repo, said.toLowerCase()) : undefined;
  if (!c || !SHA.test(c.sha)) return { why: `No commit ${said} in ${repo}.` };
  const id = `${c.sha.slice(0, 12)}-${task}`;
  if (!r.entities.some((e) => e.stream === stream && e.type === COMMIT && e.id === id)) {
    const w = await wp.submitAsSync({ stream, kind: "create", entity: { type: COMMIT, id }, payload: { task, repo, sha: c.sha, message: c.message.slice(0, 300) } });
    if (w.status !== "appended") return { why: `Couldn't keep ${said} for ${task}.` };
  }
  return { ref: c.sha };
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
