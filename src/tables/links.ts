// Workspace links (2026-10-21): a workspace (one project, one task tree, one stream) linked
// to a git repo and a Jira project. tira leads and Jira mirrors; GitHub and Jira changes come
// in when someone syncs (src/sync/sync.ts). Three record types beside the tasks, so the task
// table is untouched (each new table needs Devansh's sign-off):
//
//   workspace   one per stream (id "workspace"), versioned: v1 born LINKED, each change a new
//               version RELINKED. {repo?, jira_site?, jira_project?}, set by a person. Two more,
//               2026-10-22 (Isha): {title} renames the project as people see it (its stream, its
//               address and its history keep the name it was made with), and {deleted: true} takes
//               it out of tira's lists and closes its board; tira never erases, so its history
//               stays. Both stick: a later version that doesn't mention them keeps them.
//               2026-10-23 (Isha): {jira_name}, the Jira project's name as Jira shows it ("Tira
//               Board" for KAN), saved with the key when it's picked, and again, as the person
//               syncing, when a sync finds Jira calls it something else. It sticks while the same
//               project stays linked.
//   jira-issue  one per task (id = the task's id): the Jira issue tira made for it, {task, key}.
//               PUSHED records the status category tira last set, so the next sync can tell a
//               person's move in Jira from its own.
//   pr          one per (pull request, task it names): {task, repo, number, url, title}; open,
//               then merged or closed, as GitHub says.
//
// The Jira issue and PR records are written only by the sync, under its reserved name.
// A person's move in Jira is not a record: it comes back as a command on the task, written as
// "jira:<their name>", which tira's rules may refuse.
import type { GuardFn, Table } from "./table.ts";
import type { EntityTypeDef } from "./registry.ts";

export const SYNC = "sync";
export const WORKSPACE = "workspace";
export const WORKSPACE_ID = "workspace";
export const JIRA_ISSUE = "jira-issue";
export const PR = "pr";
export const LINK_TYPES = new Set([WORKSPACE, JIRA_ISSUE, PR]);

// Jira status categories: To Do, In Progress, Done, whatever a workflow names its statuses.
export const CATEGORIES = ["new", "indeterminate", "done"] as const;
export type Category = (typeof CATEGORIES)[number];

export const REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
export const JIRA_PROJECT = /^[A-Z][A-Z0-9_]{0,19}$/;
export const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d+$/;
export const JIRA_SITE = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

const s = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const optional = (v: unknown, test: RegExp) => v === undefined || (typeof v === "string" && test.test(v));
// a project's name as people see it: 1 to 80 characters, no control characters, no spaces around it
export const TITLE = /^(?! )[^\u0000-\u001f\u007f]{1,80}(?<! )$/;

export const LINK_GUARDS: Record<string, GuardFn> = {
  // a person links a workspace; a Jira project needs its site, and its name needs its key
  workspaceWellFormed: ({ actor, payload }) =>
    s(actor) && actor !== SYNC
    && optional(payload.repo, REPO) && optional(payload.jira_site, JIRA_SITE) && optional(payload.jira_project, JIRA_PROJECT)
    && (payload.jira_project === undefined || payload.jira_site !== undefined)
    && optional(payload.jira_name, TITLE) && (payload.jira_name === undefined || payload.jira_project !== undefined)
    && (payload.deleted === undefined || payload.deleted === true) && optional(payload.title, TITLE)
    && ([payload.repo, payload.jira_site, payload.jira_project, payload.title].some((v) => v !== undefined) || payload.deleted === true),
  jiraIssueLinked: ({ actor, payload }) => actor === SYNC && s(payload.task) && typeof payload.key === "string" && JIRA_KEY.test(payload.key),
  prLinked: ({ actor, payload }) =>
    actor === SYNC && s(payload.task) && typeof payload.repo === "string" && REPO.test(payload.repo)
    && Number.isInteger(payload.number) && typeof payload.url === "string" && payload.url.startsWith("https://"),
  fromSync: ({ actor }) => actor === SYNC,
  fromSyncWithCategory: ({ actor, payload }) => actor === SYNC && (CATEGORIES as readonly unknown[]).includes(payload.category)
    && (payload.tira === undefined || (CATEGORIES as readonly unknown[]).includes(payload.tira)),
};

export function linkTypes(chart: (name: string) => Table): EntityTypeDef[] {
  const onTask = [{ on: "birth", type: "node", from: "payload.task" as const }];
  return [
    { type: WORKSPACE, versioned: true, createdAs: "LINKED", revisedAs: "RELINKED", createGuard: "workspaceWellFormed", keepBirth: true, regions: { lifecycle: chart("workspace.json") } },
    { type: JIRA_ISSUE, createdAs: "LINKED", createGuard: "jiraIssueLinked", keepBirth: true, mustExist: onTask, regions: { lifecycle: chart("jira-issue.json") } },
    { type: PR, createdAs: "LINKED", createGuard: "prLinked", keepBirth: true, mustExist: onTask, regions: { lifecycle: chart("pr.json") } },
  ];
}
