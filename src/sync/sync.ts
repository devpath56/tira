// One sync of a workspace with its git repo and Jira project (`tira sync`, or Sync on the
// page). tira leads, Jira mirrors, and changes come in only when someone syncs:
//
// 1. In from GitHub: each recently updated pull request that names a task ("tira: <task>" in
//    its title, body or a commit, a branch segment equal to the task's id, or the task's Jira
//    key) is linked to that task, and follows GitHub to merged or closed. Its commits are kept
//    for the task (src/tables/tickets.ts): a person or an agent completes it with one of them as
//    the proof of work.
// 1b. In from Jira: the linked project's name, as Jira shows it ("Tira Board" for KAN). When the
//    link has another, or none, the link follows, written as the person syncing.
// 2. In from Jira: issues people made in Jira itself become tasks, keeping Jira's structure (an
//    epic above its issues, an issue above its subtasks), written as whoever made each one in
//    Jira. Each is linked to its issue (now labelled "tira") and brought to where it is there:
//    in progress started; done completed, with the issue's own link as its proof.
// 2b. Out to Jira: every task without an issue gets one (labelled "tira").
// 3. In from Jira: an issue whose status category differs from the one tira last saw was moved
//    by a person. That move comes back as a command on the task, written as "jira:<their
//    name>" (moved to In Progress: start, unblock or re-open; to Done: complete, with the
//    merged pull request as proof if there is one). tira's rules may refuse it: the refusal is
//    in the log and in the report.
// 4. Out to Jira again: an issue whose task moved in tira since the last sync, or whose
//    person's move tira refused, is moved to the category its task is in now (to do: To Do;
//    in progress or blocked: In Progress; done or cancelled: Done), with "blocked" and
//    "cancelled" as labels. Both sides are recorded (where the issue is, where its task is),
//    so neither is moved again until one of them changes: an issue tira couldn't match when
//    it came in (tira keeps one task in progress at a time) stays as it is in Jira.
//
// Every write goes through the write path: links as the reserved "sync", people's Jira moves
// as themselves. A step that fails is reported and the rest carries on.
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { fold, type FoldResult } from "../fold/fold.ts";
import { byBirth } from "../fold/view.ts";
import type { EntityState } from "../fold/types.ts";
import { Dispatcher } from "../write/dispatcher.ts";
import type { WriteResult } from "../write/write-path.ts";
import { JIRA_ISSUE, PR, WORKSPACE, WORKSPACE_ID, type Category } from "../tables/links.ts";
import { linksOf, tasksNamed, workspaceOf, type WorkspaceLink } from "../fold/workspace.ts";

export { linksOf, tasksNamed, workspaceOf, type TaskLinks, type WorkspaceLink } from "../fold/workspace.ts";
import { projectName, TIRA_LABEL, type JiraClient, type JiraIssue } from "./jira.ts";
import type { GitHubClient, Pull } from "./github.ts";
import { COMMIT, SHA } from "../tables/tickets.ts";

const TASK = "node";

const CATEGORY_WORD: Record<Category, string> = { new: "To Do", indeterminate: "In Progress", done: "Done" };
export const categoryWord = (c: Category): string => CATEGORY_WORD[c];

// The category and labels an issue should have, from its task's state.
function wanted(state: string): { category: Category; labels: { blocked: boolean; cancelled: boolean } } {
  const category: Category = state === "unstarted" ? "new" : state === "in_progress" || state === "blocked" ? "indeterminate" : "done";
  return { category, labels: { blocked: state === "blocked", cancelled: state === "cancelled" } };
}

// What a person's move in Jira asks of the task, or undefined when tira has no such move.
function requestFor(to: Category, state: string, key: string, who: string, proof: string | undefined): { event: string; payload: Record<string, unknown> } | undefined {
  const note = `from Jira ${key}`;
  if (to === "indeterminate") {
    if (state === "unstarted") return { event: "START", payload: { note } };
    if (state === "blocked") return { event: "UNBLOCK", payload: { note } };
    if (state === "done" || state === "cancelled") return { event: "REOPEN", payload: { reason: `moved back to In Progress in Jira (${key}) by ${who}`, note } };
    return undefined;
  }
  if (to === "done" && state !== "done" && state !== "cancelled") return { event: "COMPLETE", payload: { ...(proof ? { evidenceRef: proof } : {}), note } };
  return undefined;
}

// a refusal in a few plain words, where it's a common one
function plainWhy(why: string): string {
  if (why.includes("one active task")) return "tira keeps one task in progress at a time";
  if (why.includes("subtree not drained")) return "some of its issues are still open";
  return why;
}

export interface SyncReport {
  linked: { repo?: string; jira?: string };
  jiraName?: string; // the Jira project's name, saved to the link by this sync (Jira calls it that now)
  prs: { task: string; pr: string; url: string; change: string }[]; // change: linked, merged, closed, reopened
  commits?: { task: string; sha: string }[]; // commits kept for a task, new this sync
  created: { task: string; key: string }[];
  imported: { key: string; task: string; to: string }[]; // issues made in Jira, now tasks
  requests: { key: string; task: string; who: string; to: string; result: string }[]; // result: what tira did with it
  pushed: { key: string; task: string; to: string }[];
  problems: string[];
}

export interface SyncOptions {
  store: EventStore;
  registry: Registry;
  stream: string;
  github?: GitHubClient; // absent: the repo isn't read
  jira?: JiraClient; // absent: Jira isn't read or written
  by?: string; // the person syncing: when Jira calls the linked project by another name, the link follows, as them
}

const said = (r: WriteResult) => (r.status === "appended" || r.status === "duplicate" ? "" : r.status === "rejected" || r.status === "refused" ? `${r.code}: ${r.detail}` : r.status);

// 1b, for sync(): when the link names its Jira project by another name than Jira's (or none, linked
// before tira kept names), the link follows, written as the person syncing (a person links a
// workspace). With no one named, nothing is written.
async function followJiraName(o: SyncOptions, d: Dispatcher, ws: WorkspaceLink, jira: JiraClient, report: SyncReport): Promise<void> {
  if (!o.by || !ws.jira_site || !ws.jira_project) return;
  const name = await projectName(jira, ws.jira_project);
  if (name === undefined || name === ws.jira_name) return;
  const payload = { ...(ws.repo ? { repo: ws.repo } : {}), jira_site: ws.jira_site, jira_project: ws.jira_project, jira_name: name };
  const why = said((await d.submit({ stream: o.stream, kind: "create", entity: { type: WORKSPACE, id: WORKSPACE_ID, version: ws.version + 1 }, actor: o.by, payload })).result);
  if (why) report.problems.push(`saving Jira's name for ${ws.jira_project}: ${why}`);
  else report.jiraName = name;
}

export async function sync(o: SyncOptions): Promise<SyncReport> {
  const d = new Dispatcher(o.store, o.registry);
  const wp = d.writePath;
  const report: SyncReport = { linked: {}, prs: [], created: [], imported: [], requests: [], pushed: [], problems: [] };
  const now = async () => fold(await o.store.readStream(o.stream), o.registry);
  // in the order they were made, so issue numbers follow the tree as it grew
  const tasksIn = (r: FoldResult) => r.entities.filter((e) => e.stream === o.stream && e.type === TASK).sort(byBirth);
  // each task's links, tasks in the order they were made
  const linked = (r: FoldResult) => {
    const ls = linksOf(r, o.stream);
    return tasksIn(r).flatMap((t) => {
      const l = ls.get(t.id);
      return l ? [[t.id, l] as const] : [];
    });
  };
  let r = await now();
  const ws = workspaceOf(r, o.stream);
  if (!ws) {
    report.problems.push("this workspace isn't linked yet: tira link --repo <owner/name> --jira-site <https://…> --jira <KEY>");
    return report;
  }
  report.linked = { ...(ws.repo ? { repo: ws.repo } : {}), ...(ws.jira_project ? { jira: ws.jira_project } : {}) };
  const asSync = async (what: string, cmd: Parameters<typeof wp.submitAsSync>[0]) => {
    const w = await wp.submitAsSync(cmd);
    const why = said(w);
    if (why) report.problems.push(`${what}: ${why}`);
    return why === "";
  };

  // a pull request's commits, for a task: each one not kept yet (its id: the commit's, short, and the task's)
  const keptNow = new Set<string>(); // this sync's, before the log is read again (a commit on two pull requests)
  const keepCommits = async (p: Pull, task: string, repo: string) => {
    for (const [i, sha] of (p.shas ?? []).entries()) {
      if (!SHA.test(sha)) continue;
      const id = `${sha.slice(0, 12)}-${task}`;
      if (keptNow.has(id) || r.entities.some((e) => e.stream === o.stream && e.type === COMMIT && e.id === id)) continue;
      keptNow.add(id);
      const message = (p.commits[i] ?? "").slice(0, 300);
      if (await asSync(`keep commit ${sha.slice(0, 7)} for ${task}`, { stream: o.stream, kind: "create", entity: { type: COMMIT, id }, payload: { task, repo, sha, pr: p.number, ...(p.branch ? { branch: p.branch } : {}), message } })) {
        (report.commits ??= []).push({ task, sha });
      }
    }
  };

  // 1. pull requests
  if (ws.repo && o.github) {
    try {
      const pulls = await o.github.pulls(ws.repo);
      const tasks = new Set(tasksIn(r).map((e) => e.id));
      const byKey = new Map([...linksOf(r, o.stream)].flatMap(([task, l]) => (l.jira ? [[l.jira.key, task] as const] : [])));
      for (const p of pulls) {
        for (const task of tasksNamed(p, tasks, byKey)) {
          const id = `${ws.repo}#${p.number}/${task}`;
          const pr = `${ws.repo}#${p.number}`;
          const existing = r.entities.find((e) => e.stream === o.stream && e.type === PR && e.id === id);
          if (!existing && await asSync(`link ${pr} to ${task}`, { stream: o.stream, kind: "create", entity: { type: PR, id }, payload: { task, repo: ws.repo, number: p.number, url: p.url, title: p.title.slice(0, 200) } })) {
            report.prs.push({ task, pr, url: p.url, change: "linked" });
          }
          const state = existing?.regions.lifecycle ?? "open";
          const event = p.mergedAt ? (state === "merged" ? undefined : "MERGED") : p.state === "closed" ? (state === "closed" ? undefined : "CLOSED") : state === "closed" ? "REOPENED" : undefined;
          if (event && await asSync(`${pr} ${event.toLowerCase()}`, { stream: o.stream, kind: "event", entity: { type: PR, id }, event, payload: p.mergedAt ? { merged_at: p.mergedAt } : {} })) {
            report.prs.push({ task, pr, url: p.url, change: event.toLowerCase() });
          }
          await keepCommits(p, task, ws.repo);
        }
      }
    } catch (err) {
      report.problems.push(`GitHub: ${(err as Error).message}`);
    }
    r = await now();
  }

  if (!ws.jira_project || !o.jira) return report;
  const jira = o.jira;
  const project = ws.jira_project;

  // 1b. the project's name, as Jira shows it now (followJiraName)
  await followJiraName(o, d, ws, jira, report);

  // 2. issues people made in Jira, as tasks
  const site = ws.jira_site ?? "";
  let every: JiraIssue[];
  try {
    every = await jira.everyIssue(project);
  } catch (err) {
    report.problems.push(`reading Jira ${project}: ${(err as Error).message}`);
    return report; // Jira can't be read: nothing is written to it either
  }
  await bringIn(every);
  r = await now();

  async function bringIn(all: JiraIssue[]): Promise<void> {
    const keyOf = new Map<string, string>(); // Jira key -> task
    for (const [task, l] of linksOf(r, o.stream)) if (l.jira) keyOf.set(l.jira.key, task);
    const byKey = new Map(all.map((i) => [i.key, i]));
    // tira's own issues (here or in another workspace) stay out: only what people made in Jira
    const fresh = all.filter((i) => !keyOf.has(i.key) && !i.labels.includes(TIRA_LABEL));
    if (fresh.length === 0) return;
    const depth = (i: JiraIssue, seen = new Set<string>()): number => {
      const up = i.parent ? byKey.get(i.parent) : undefined;
      return up && !seen.has(up.key) ? 1 + depth(up, seen.add(i.key)) : 0;
    };
    const num = (k: string) => Number(k.slice(k.lastIndexOf("-") + 1)) || 0;
    // parents before their children; within a level, in the order Jira numbered them
    const order = fresh.map((i) => ({ i, level: depth(i) })).sort((a, b) => a.level - b.level || num(a.i.key) - num(b.i.key));
    const names = new Set(tasksIn(r).map((t) => t.id));
    const made: { i: JiraIssue; task: string; level: number }[] = [];
    for (const { i, level } of order) {
      const base = i.summary.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) || i.key;
      const task = names.has(base) ? `${base.slice(0, 80 - i.key.length - 3)} (${i.key})` : base;
      const parent = i.parent ? keyOf.get(i.parent) : undefined;
      const who = `jira:${i.createdBy ?? "someone"}`;
      const born = (await d.submit({ stream: o.stream, kind: "create", entity: { type: TASK, id: task }, actor: who, payload: parent ? { parent_id: parent } : {}, eventId: `jira:${i.key}:born` })).result;
      const why = said(born);
      if (why) {
        report.problems.push(`bringing in ${i.key} ("${i.summary}"): ${why}`);
        continue;
      }
      names.add(task);
      keyOf.set(i.key, task);
      if (!(await asSync(`link ${task} to ${i.key}`, { stream: o.stream, kind: "create", entity: { type: JIRA_ISSUE, id: task }, payload: { task, key: i.key } }))) continue;
      try {
        await jira.setLabels(i.key, [TIRA_LABEL], []);
      } catch (err) {
        report.problems.push(`labelling ${i.key}: ${(err as Error).message}`);
      }
      made.push({ i, task, level });
    }
    // then to where each is in Jira: done ones children first, so a parent's work is closed
    // before it is; then the ones in progress, those whose children are all done last (tira
    // closes such a parent when work moves on elsewhere: not during this sync); then the rest
    const kidsDone = (k: string) => all.some((x) => x.parent === k) && all.every((x) => x.parent !== k || x.category === "done");
    const deepFirst = (a: (typeof made)[number], b: (typeof made)[number]) => b.level - a.level || num(a.i.key) - num(b.i.key);
    const inOrder = [
      ...made.filter((m) => m.i.category === "done").sort((a, b) => deepFirst(a, b)),
      ...made.filter((m) => m.i.category === "indeterminate").sort((a, b) => Number(kidsDone(a.i.key)) - Number(kidsDone(b.i.key)) || deepFirst(a, b)),
      ...made.filter((m) => m.i.category === "new").sort((a, b) => deepFirst(a, b)),
    ];
    for (const { i, task } of inOrder) {
      const by = `jira:${i.movedBy?.name ?? i.createdBy ?? "someone"}`;
      const steps = i.category === "new" ? [] : i.category === "indeterminate" ? ["START"] : ["START", "COMPLETE"];
      let to = "To Do";
      for (const event of steps) {
        const payload = event === "COMPLETE" ? { evidenceRef: `${site}/browse/${i.key}`, note: `done in Jira ${i.key}` } : { note: `from Jira ${i.key}` };
        const w = (await d.submit({ stream: o.stream, kind: "event", entity: { type: TASK, id: task }, event, payload, actor: by, eventId: `jira:${i.key}:${event.toLowerCase()}` })).result;
        const why = said(w);
        if (why) {
          // tira couldn't follow Jira here: say where it is in tira, and why (Jira is left as it is)
          const now2 = (await now()).entities.find((e) => e.stream === o.stream && e.type === TASK && e.id === task)?.regions.lifecycle;
          to = now2 === "done" ? "Done (tira closed it: all its work is done)" : `${to} (${categoryWord(i.category)} in Jira: ${plainWhy(why)})`;
          break;
        }
        to = event === "START" ? "In Progress" : "Done";
      }
      report.imported.push({ key: i.key, task, to });
    }
    // both sides on record, as they are now: neither is moved until one of them changes
    const after = await now();
    for (const { i, task } of made) {
      const state = after.entities.find((e) => e.stream === o.stream && e.type === TASK && e.id === task)?.regions.lifecycle ?? "unstarted";
      await asSync(`${i.key} as it is in Jira`, { stream: o.stream, kind: "event", entity: { type: JIRA_ISSUE, id: task }, event: "PUSHED", payload: { category: i.category, status: i.status, tira: wanted(state).category } });
    }
  }

  // 2b. an issue for every task that has none
  const links = linksOf(r, o.stream);
  const pathOf = (e: EntityState) => {
    const up: string[] = [];
    for (let k = e.tree?.parent; k !== undefined; k = r.entities.find((x) => x.stream === o.stream && x.key === k)?.tree?.parent) up.unshift(k.replace(/^node:/, ""));
    return up.length > 0 ? up.join(" › ") : "top level";
  };
  for (const t of tasksIn(r)) {
    if (links.get(t.id)?.jira) continue;
    try {
      const { key } = await jira.createIssue(project, t.id, `tira task ${t.id} · ${pathOf(t)} · workspace ${o.stream}. tira leads: change it in tira, or move it here and sync.`);
      if (await asSync(`link ${t.id} to ${key}`, { stream: o.stream, kind: "create", entity: { type: JIRA_ISSUE, id: t.id }, payload: { task: t.id, key } })) {
        report.created.push({ task: t.id, key });
        await asSync(`${key} starts in To Do`, { stream: o.stream, kind: "event", entity: { type: JIRA_ISSUE, id: t.id }, event: "PUSHED", payload: { category: "new", status: "To Do", tira: "new" } });
      }
    } catch (err) {
      report.problems.push(`making a Jira issue for ${t.id}: ${(err as Error).message}`);
    }
  }
  r = await now();

  let issues: Map<string, JiraIssue>;
  try {
    issues = new Map((await jira.issues(project)).map((i) => [i.key, i]));
  } catch (err) {
    report.problems.push(`reading Jira ${project}: ${(err as Error).message}`);
    return report;
  }

  // 3. people's moves in Jira, as requests tira's rules judge; one tira won't take is put back
  const putBack = new Set<string>();
  for (const [task, l] of linked(r)) {
    const issue = l.jira ? issues.get(l.jira.key) : undefined;
    if (!l.jira || !issue || l.jira.category === undefined || issue.category === l.jira.category) continue;
    const t = r.entities.find((e) => e.stream === o.stream && e.type === TASK && e.id === task);
    const state = t?.regions.lifecycle ?? "";
    const who = issue.movedBy?.name ?? "someone";
    const proof = l.prs.find((p) => p.state === "merged")?.url;
    const ask = requestFor(issue.category, state, issue.key, who, proof);
    const entry = { key: issue.key, task, who, to: issue.status || categoryWord(issue.category) };
    if (!ask) {
      putBack.add(task);
      report.requests.push({ ...entry, result: `tira has no move from ${state.replace("_", " ")} to ${categoryWord(issue.category)}: put back` });
      continue;
    }
    const eventId = `jira:${issue.key}:${issue.movedBy?.id ?? `${issue.category}-${issue.movedBy?.at ?? "unknown"}`}`;
    try {
      const { result } = await d.submit({ stream: o.stream, kind: "event", entity: { type: TASK, id: task }, event: ask.event, payload: ask.payload, actor: `jira:${who}`, eventId });
      const why = said(result);
      if (why) putBack.add(task);
      report.requests.push({ ...entry, result: why ? `refused (${why}): put back` : `${ask.event.toLowerCase()} ${task}` });
    } catch (err) {
      report.problems.push(`${issue.key}'s move: ${(err as Error).message}`);
    }
  }
  r = await now();

  // 4. every issue where its task is now
  for (const [task, l] of linked(r)) {
    const issue = l.jira ? issues.get(l.jira.key) : undefined;
    const t = r.entities.find((e) => e.stream === o.stream && e.type === TASK && e.id === task);
    if (!l.jira || !issue || !t) continue;
    const want = wanted(t.regions.lifecycle ?? "");
    const tiraWas = l.jira.tira ?? l.jira.category;
    try {
      let status = issue.status;
      let jiraNow = issue.category;
      if ((want.category !== tiraWas || putBack.has(task)) && issue.category !== want.category) {
        status = await jira.moveTo(issue.key, want.category);
        jiraNow = want.category;
        report.pushed.push({ key: issue.key, task, to: status });
      }
      const has = new Set(issue.labels);
      const add = (["blocked", "cancelled"] as const).filter((x) => want.labels[x] && !has.has(x));
      const remove = (["blocked", "cancelled"] as const).filter((x) => !want.labels[x] && has.has(x));
      await jira.setLabels(issue.key, add, remove);
      if (l.jira.category !== jiraNow || l.jira.status !== status || l.jira.tira !== want.category) {
        await asSync(`${issue.key} set to ${status}`, { stream: o.stream, kind: "event", entity: { type: JIRA_ISSUE, id: task }, event: "PUSHED", payload: { category: jiraNow, status, tira: want.category } });
      }
    } catch (err) {
      report.problems.push(`moving ${issue.key}: ${(err as Error).message}`);
    }
  }
  return report;
}

// The report in a few lines, for the terminal and the page.
export function reportLines(rep: SyncReport): string[] {
  const out: string[] = [];
  const linked = [rep.linked.repo ? `GitHub ${rep.linked.repo}` : "", rep.linked.jira ? `Jira ${rep.linked.jira}` : ""].filter(Boolean).join(" and ");
  if (linked) out.push(`synced with ${linked}`);
  if (rep.jiraName) out.push(`Jira calls ${rep.linked.jira} "${rep.jiraName}": the link shows that name now`);
  for (const p of rep.prs) out.push(`${p.pr} ${p.change}${p.change === "linked" ? ` to ${p.task}` : ` (${p.task})`}`);
  const kept = rep.commits ?? [];
  if (kept.length > 0) out.push(`${kept.length} ${kept.length === 1 ? "commit" : "commits"} kept for ${[...new Set(kept.map((c) => c.task))].join(", ")}`);
  for (const m of rep.imported) out.push(`${m.key} brought in as ${m.task} (${m.to})`);
  for (const c of rep.created) out.push(`${c.task}: made Jira ${c.key}`);
  for (const q of rep.requests) out.push(`${q.key} moved to ${q.to} in Jira by ${q.who}: ${q.result}`);
  for (const p of rep.pushed) out.push(`${p.key} (${p.task}) set to ${p.to}`);
  for (const p of rep.problems) out.push(`problem: ${p}`);
  if (out.length <= 1 && rep.problems.length === 0) out.push("nothing to change");
  return out;
}
