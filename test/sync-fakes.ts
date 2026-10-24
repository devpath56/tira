// Stand-ins for Jira and GitHub, for the sync's tests (and the docs page): they keep their
// state in memory and behave as the sync expects the real ones to.
import type { Category } from "../src/tables/links.ts";
import type { JiraClient, JiraIssue } from "../src/sync/jira.ts";
import type { GitHubClient, Pull } from "../src/sync/github.ts";

const WORD: Record<Category, string> = { new: "To Do", indeterminate: "In Progress", done: "Done" };

export class FakeJira implements JiraClient {
  readonly issuesByKey = new Map<string, JiraIssue>();
  readonly calls: string[] = [];
  private n = 0;
  private history = 0;
  fail?: string | undefined; // make every call throw this

  private check(call: string) {
    this.calls.push(call);
    if (this.fail) throw new Error(this.fail);
  }
  async myself() {
    this.check("myself");
    return { name: "Isha" };
  }
  async createIssue(project: string, summary: string) {
    this.check(`create ${summary}`);
    const key = `${project}-${++this.n}`;
    this.issuesByKey.set(key, { key, summary, status: "To Do", category: "new", labels: ["tira"] });
    return { key };
  }
  async issues() {
    this.check("issues");
    return [...this.issuesByKey.values()].filter((i) => i.labels.includes("tira")).map((i) => ({ ...i, labels: [...i.labels] }));
  }
  async everyIssue() {
    this.check("every issue");
    return [...this.issuesByKey.values()].map((i) => ({ ...i, labels: [...i.labels] }));
  }
  // an issue a person made in Jira itself (not tira's: no "tira" label)
  made(summary: string, to: Category = "new", o: { parent?: string; by?: string; project?: string } = {}): string {
    const key = `${o.project ?? "DOG"}-${++this.n}`;
    this.issuesByKey.set(key, { key, summary, status: WORD[to], category: to, labels: [], createdBy: o.by ?? "Devansh", ...(o.parent ? { parent: o.parent } : {}) });
    return key;
  }
  async moveTo(key: string, to: Category) {
    this.check(`move ${key} ${to}`);
    const i = this.issuesByKey.get(key);
    if (!i) throw new Error(`no ${key}`);
    i.category = to;
    i.status = WORD[to];
    return i.status;
  }
  // the projects' names, as Jira shows them (a person may rename one there)
  readonly names = new Map([["DOG", "Dogma"], ["WEB", "Website"]]);
  async projects() {
    this.check("projects");
    return [...this.names].map(([key, name]) => ({ key, name }));
  }
  async setLabels(key: string, add: string[], remove: string[]) {
    if (add.length + remove.length === 0) return;
    this.check(`labels ${key} +${add.join(",")} -${remove.join(",")}`);
    const i = this.issuesByKey.get(key);
    if (i) i.labels = [...i.labels.filter((l) => !remove.includes(l)), ...add.filter((a) => !i.labels.includes(a))];
  }
  // a person moving an issue in Jira's own screen
  person(key: string, to: Category, who = "Isha", status = WORD[to]) {
    const i = this.issuesByKey.get(key);
    if (!i) throw new Error(`no ${key}`);
    i.category = to;
    i.status = status;
    i.movedBy = { name: who, at: `2026-10-21T10:00:${String(++this.history).padStart(2, "0")}.000Z`, id: String(10000 + this.history) };
  }
}

export class FakeGitHub implements GitHubClient {
  readonly pullsByNumber = new Map<number, Pull>();
  repoCommits: { sha: string; message: string }[] = []; // commits on the default branch, no pull request's
  fail?: string | undefined;
  private pullOf(p: Pull) {
    return { number: p.number, title: p.title, url: p.url, state: p.state, merged: !!p.mergedAt, branch: p.branch };
  }
  async commit(_repo: string, sha: string) {
    if (this.fail) throw new Error(this.fail);
    const all = [...this.repoCommits, ...[...this.pullsByNumber.values()].flatMap((p) => (p.shas ?? []).map((s, i) => ({ sha: s, message: p.commits[i] ?? "" })))];
    return all.find((c) => c.sha.startsWith(sha));
  }
  async pull(_repo: string, number: number) {
    if (this.fail) throw new Error(this.fail);
    const p = this.pullsByNumber.get(number);
    return p ? this.pullOf(p) : undefined;
  }
  add(p: Partial<Pull> & { number: number }) {
    this.pullsByNumber.set(p.number, { title: "", body: "", branch: "", url: `https://github.com/acme/app/pull/${p.number}`, state: "open", commits: [], ...p });
  }
  async pulls() {
    if (this.fail) throw new Error(this.fail);
    return [...this.pullsByNumber.values()];
  }
}
