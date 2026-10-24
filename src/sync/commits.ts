// What a task can be completed with, looked up on GitHub: its own commits (only that task's, not a
// whole sync: an agent's complete_task looks for its newest first), kept for it as the sync keeps them
// (src/tables/tickets.ts), under the sync's reserved name; and any one commit or pull request of the
// repo someone names (the Complete dialog checks it as it's typed), checked on GitHub and kept for
// the task once it's completed with it.
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { fold } from "../fold/fold.ts";
import { linksOf, tasksNamed, workspaceOf } from "../fold/workspace.ts";
import { COMMIT, SHA } from "../tables/tickets.ts";
import { PR } from "../tables/links.ts";
import { WritePath } from "../write/write-path.ts";
import { firstLine } from "../fold/tickets.ts";
import type { GitHubClient, RepoCommit, RepoPull, TaskCommit } from "./github.ts";

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

// A proof someone named, read: a pull request (#12, a number up to 6 digits, or its link) or a commit
// (its id, or 7 or more of its first characters, or its link) of the project's repo; undefined if
// it's neither (another repo's link, words).
type Named = { pr: number } | { sha: string };
export function namedProof(repo: string, ref: string): Named | undefined {
  const said = /^https?:\/\//i.test(ref.trim()) ? ref.trim().replace(/[?#].*$/, "") : ref.trim(); // a link's own query or anchor isn't part of it
  const name = repo.replaceAll(".", String.raw`\.`);
  const at = String.raw`^https?://(?:www\.)?github\.com/${name}`;
  const pr = /^#(\d{1,7})$/.exec(said) ?? /^(\d{1,6})$/.exec(said) ?? new RegExp(String.raw`${at}/pull/(\d{1,7})(?:/(?:files|commits|checks))?/?$`, "i").exec(said);
  if (pr) return { pr: Number(pr[1]) };
  const sha = /^([0-9a-f]{7,40})$/i.exec(said) ?? new RegExp(String.raw`${at}/(?:pull/\d{1,7}/commits|commit)/([0-9a-f]{7,40})/?$`, "i").exec(said);
  return sha ? { sha: (sha[1] ?? "").toLowerCase() } : undefined;
}

// What a named proof is on GitHub, looked up (nothing is written): the pull request or commit, or why not.
type Found = { pr: RepoPull } | { commit: RepoCommit };
export async function findProof(client: GitHubClient, repo: string, ref: string): Promise<Found | { why: string }> {
  const named = namedProof(repo, ref);
  if (!named) return { why: "Name a commit (its id or link) or a pull request (#12, or its link)." };
  if ("pr" in named) {
    const p = client.pull ? await client.pull(repo, named.pr) : undefined;
    return p ? { pr: p } : { why: `No pull request #${named.pr} in ${repo}.` };
  }
  const c = client.commit ? await client.commit(repo, named.sha) : undefined;
  return c && SHA.test(c.sha) ? { commit: c } : { why: `No commit ${named.sha} in ${repo}.` };
}

// A proof someone named, checked on GitHub against the project's repo and kept for the task (a commit
// as one of its commits, a pull request linked to it): the proof to write (a commit's whole id, a
// pull request's link), or why it can't be.
export async function proveWith(store: EventStore, registry: Registry, stream: string, task: string, client: GitHubClient, ref: string): Promise<{ ref: string } | { why: string }> {
  const r = fold(await store.readStream(stream), registry);
  const repo = workspaceOf(r, stream)?.repo;
  if (!repo) return { why: "No GitHub repo linked to this project." };
  const got = await findProof(client, repo, ref);
  if ("why" in got) return got;
  const wp = new WritePath(store, registry);
  if ("pr" in got) {
    const p = got.pr;
    const id = `${repo}#${p.number}/${task}`;
    if (!r.entities.some((e) => e.stream === stream && e.type === PR && e.id === id)) {
      const w = await wp.submitAsSync({ stream, kind: "create", entity: { type: PR, id }, payload: { task, repo, number: p.number, url: p.url, title: p.title.slice(0, 200) } });
      if (w.status !== "appended") return { why: `Couldn't link #${p.number} to ${task}.` };
    }
    return { ref: p.url };
  }
  const c = got.commit;
  const id = `${c.sha.slice(0, 12)}-${task}`;
  if (!r.entities.some((e) => e.stream === stream && e.type === COMMIT && e.id === id)) {
    const w = await wp.submitAsSync({ stream, kind: "create", entity: { type: COMMIT, id }, payload: { task, repo, sha: c.sha, message: c.message.slice(0, 300) } });
    if (w.status !== "appended") return { why: `Couldn't keep ${c.sha.slice(0, 7)} for ${task}.` };
  }
  return { ref: c.sha };
}

// A proof typed into the Complete dialog, checked as it's typed: what tira found on GitHub (a commit's
// first line; a pull request's number, title and state), or why it can't be one. Nothing is written:
// Complete checks it again, and keeps it for the task.
export async function proofSaid(store: EventStore, registry: Registry, stream: string, client: GitHubClient, ref: string): Promise<{ ok: boolean; text: string }> {
  const repo = workspaceOf(fold(await store.readStream(stream), registry), stream)?.repo;
  if (!repo) return { ok: false, text: "No GitHub repo linked to this project." };
  try {
    const got = await findProof(client, repo, ref);
    if ("why" in got) return { ok: false, text: got.why };
    if ("pr" in got) return { ok: true, text: `Found: #${got.pr.number} ${got.pr.title} · ${got.pr.merged ? "merged" : got.pr.state}` };
    return { ok: true, text: `Found: ${firstLine(got.commit.message)}` };
  } catch (err) {
    return { ok: false, text: `Couldn't reach GitHub (${(err as Error).message}).` };
  }
}

// What a look said, in words: what it found, that the project links no repo, or why GitHub couldn't be reached.
export async function lookedSaid(task: string, look: () => Promise<Looked | undefined>): Promise<string> {
  try {
    const l = await look();
    if (!l) return "No GitHub repo linked to this project.";
    if (l.found === 0) return `No commits for ${task} on GitHub yet.`;
    const noun = l.found === 1 ? "commit" : "commits";
    const fresh = l.kept > 0 ? ` (${l.kept} new)` : "";
    return `${l.found} ${noun} on GitHub${fresh}.`;
  } catch (err) {
    return `Couldn't reach GitHub (${(err as Error).message}).`;
  }
}
