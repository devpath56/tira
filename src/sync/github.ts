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

export interface GitHubClient {
  pulls(repo: string): Promise<Pull[]>;
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
