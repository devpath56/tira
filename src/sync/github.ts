// GitHub, as the sync uses it: a repo's most recently updated pull requests, with their commit
// messages, read through the GitHub CLI the person is already signed in to (`gh auth login`).
// tira never sees or keeps a GitHub token. gh is run from a fixed system directory, never
// resolved through PATH (as git is, in cli.ts).
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";

export interface Pull {
  number: number;
  title: string;
  body: string;
  branch: string;
  url: string;
  state: "open" | "closed";
  mergedAt?: string;
  commits: string[]; // messages
  shas?: string[]; // their commit ids, in the same order (a task is completed with one of them)
}

// taskCommits: one task's commits only, straight from GitHub (taskCommitsVia); a client without it
// is asked for its pulls instead (src/sync/commits.ts)
// commit, pull: what a task can be completed with besides its own commits: any one commit or pull
// request of the repo, looked up (repoVia)
export interface GitHubClient {
  pulls(repo: string): Promise<Pull[]>;
  taskCommits?(repo: string, task: string, linked: readonly number[]): Promise<TaskCommit[]>;
  commit?(repo: string, sha: string): Promise<RepoCommit | undefined>;
  pull?(repo: string, number: number): Promise<RepoPull | undefined>;
}

export interface RepoCommit { sha: string; message: string }
export interface RepoPull { number: number; title: string; url: string; state: "open" | "closed"; merged: boolean; branch: string }
const pullOf = (p: RawPull): RepoPull => ({ number: p.number, title: p.title ?? "", url: p.html_url, state: p.state === "open" ? "open" : "closed", merged: !!p.merged_at, branch: p.head?.ref ?? "" });
// a lookup that found nothing is an answer, not a failure: GitHub's 404, and its 422 for a commit id
// it has no commit for
const orNone = async <T>(ask: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await ask();
  } catch (err) {
    if (/\b(?:404|422)\b|Not Found|No commit found/.test((err as Error).message)) return undefined;
    throw err;
  }
};

// One commit or pull request of the repo, looked up.
export function repoVia(get: (path: string) => Promise<unknown>) {
  return {
    commit: (repo: string, sha: string) => orNone(async () => {
      const c = (await get(`repos/${repo}/commits/${encodeURIComponent(sha)}`)) as RawCommit;
      return /^[0-9a-f]{40}$/.test(c.sha ?? "") ? { sha: c.sha as string, message: c.commit?.message ?? "" } : undefined;
    }),
    pull: (repo: string, number: number) => orNone(async () => pullOf((await get(`repos/${repo}/pulls/${number}`)) as RawPull)),
  };
}

// A commit for a task: on a pull request that names it (pr), or on a branch named after it.
export interface TaskCommit { sha: string; message: string; pr?: number; branch: string }
type RawCommit = { sha?: string; commit?: { message?: string } };

// whether a text says "tira: <task>" (a trailing full stop isn't part of the name)
export const saysTask = (text: string, task: string) => [...text.matchAll(/\btira:\s*([A-Za-z0-9][\w.-]*)/gi)].some((m) => (m[1] ?? "").replace(/\.+$/, "") === task);

// One task's commits, straight from GitHub, to complete it with one: those of the pull requests that
// name it (a branch segment equal to its id, "tira: <id>" in the title or body, or one linked to it
// already), and of a branch named after it with no pull request yet (its commits since the default
// branch). Three calls at once, then one per such pull request or branch, at once: about two
// seconds, where the whole sync reads every recent pull request's commits, and Jira.
export async function taskCommitsVia(get: (path: string) => Promise<unknown>, repo: string, task: string, linked: readonly number[]): Promise<TaskCommit[]> {
  const [pulls, branches, info] = await Promise.all([
    get(`repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=50`) as Promise<RawPull[]>,
    get(`repos/${repo}/branches?per_page=100`) as Promise<{ name?: string }[]>,
    get(`repos/${repo}`) as Promise<{ default_branch?: string }>,
  ]);
  const named = (branch: string) => branch.split("/").includes(task);
  const prs = pulls.filter((p) => linked.includes(p.number) || named(p.head?.ref ?? "") || saysTask(`${p.title ?? ""}\n${p.body ?? ""}`, task));
  const heads = new Set(prs.map((p) => p.head?.ref ?? ""));
  const base = info.default_branch ?? "main";
  const lone = branches.map((b) => b.name ?? "").filter((b) => named(b) && !heads.has(b) && b !== base);
  const ofPull = async (p: RawPull) => ((await get(`repos/${repo}/pulls/${p.number}/commits?per_page=100`)) as RawCommit[]).map((c) => ({ sha: c.sha ?? "", message: c.commit?.message ?? "", pr: p.number, branch: p.head?.ref ?? "" }));
  const ofBranch = async (b: string) => ((((await get(`repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(b)}`)) as { commits?: RawCommit[] }).commits) ?? []).map((c) => ({ sha: c.sha ?? "", message: c.commit?.message ?? "", branch: b }));
  const lists = await Promise.all([...prs.map(ofPull), ...lone.map(ofBranch)]);
  return lists.flat().filter((c) => /^[0-9a-f]{40}$/.test(c.sha));
}

const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].find((p) => existsSync(p));

type Run = (args: string[]) => Promise<string>;
const runGh: Run = (args) =>
  new Promise((resolve, reject) => {
    if (!GH) return reject(new Error("the GitHub CLI (gh) isn't installed in /opt/homebrew/bin, /usr/local/bin or /usr/bin: install it and run gh auth login"));
    execFile(GH, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`gh ${args[1] ?? ""}: ${stderr.trim() || err.message}`)) : resolve(stdout)));
  });

interface RawPull { number: number; title?: string; body?: string | null; html_url: string; state: string; merged_at?: string | null; head?: { ref?: string } }

export class GhCli implements GitHubClient {
  private readonly run: Run;
  private readonly limit: number;

  private readonly api = async (path: string) => JSON.parse(await this.run(["api", path])) as unknown;
  readonly taskCommits = (repo: string, task: string, linked: readonly number[]) => taskCommitsVia(this.api, repo, task, linked);
  readonly commit = (repo: string, sha: string) => repoVia(this.api).commit(repo, sha);
  readonly pull = (repo: string, number: number) => repoVia(this.api).pull(repo, number);

  constructor(run: Run = runGh, limit = 50) {
    this.run = run;
    this.limit = limit;
  }

  async pulls(repo: string): Promise<Pull[]> {
    const raw = JSON.parse(await this.run(["api", `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${this.limit}`])) as RawPull[];
    // commit messages, a few pulls at a time
    const out: Pull[] = [];
    for (let i = 0; i < raw.length; i += 8) {
      const batch = raw.slice(i, i + 8);
      out.push(...await Promise.all(batch.map(async (p) => {
        const commits = JSON.parse(await this.run(["api", `repos/${repo}/pulls/${p.number}/commits?per_page=100`])) as { sha?: string; commit?: { message?: string } }[];
        return {
          number: p.number, title: p.title ?? "", body: p.body ?? "", branch: p.head?.ref ?? "", url: p.html_url,
          state: p.state === "open" ? "open" as const : "closed" as const,
          ...(p.merged_at ? { mergedAt: p.merged_at } : {}),
          commits: commits.map((c) => c.commit?.message ?? ""),
          shas: commits.map((c) => c.sha ?? ""),
        };
      })));
    }
    return out;
  }
}
