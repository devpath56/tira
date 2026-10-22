// Jira Cloud, as the sync uses it (REST API v3): make an issue, read a project's tira issues
// with who last moved each (or every issue, to bring the ones people made in Jira into tira),
// move an issue to a status category, add or remove labels; and list projects, to link one. Signed in either way: Atlassian's own sign-in (JiraRest over
// api.atlassian.com, src/auth/atlassian.ts), or an email and API token (JiraCloud, for a terminal).
// Statuses are judged by their category (To Do, In Progress, Done), so any workflow works.
// Errors name the call and Jira's answer, never the login.
import type { Category } from "../tables/links.ts";

// s without the run of ch at its end (a loop, not a /ch+$/ regex: that one backtracks on a long run)
const trimEnd = (s: string, ch: string): string => {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
};

export interface JiraIssue {
  key: string;
  summary: string;
  status: string; // the status's own name, e.g. "In Review"
  category: Category;
  labels: string[];
  movedBy?: { name: string; at: string; id: string }; // the last status change, from the changelog
  parent?: string; // the issue above it: its epic, or the issue a subtask belongs to
  createdBy?: string; // who made it in Jira
}

export interface JiraClient {
  myself(): Promise<{ name: string }>;
  createIssue(project: string, summary: string, description: string): Promise<{ key: string }>;
  issues(project: string): Promise<JiraIssue[]>; // the project's issues labelled "tira"
  everyIssue(project: string): Promise<JiraIssue[]>; // all of them, oldest first, with parent and maker
  moveTo(key: string, category: Category): Promise<string>; // the status it moved to
  setLabels(key: string, add: string[], remove: string[]): Promise<void>;
  projects(): Promise<{ key: string; name: string }[]>; // to pick one to link
}

export const TIRA_LABEL = "tira";

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

interface RawIssue {
  key: string;
  fields: { summary?: string; status?: { name?: string; statusCategory?: { key?: string } }; labels?: string[]; parent?: { key?: string }; creator?: { displayName?: string } };
  changelog?: { histories?: { id: string; created: string; author?: { displayName?: string }; items?: { field?: string }[] }[] };
}

const category = (k: unknown): Category => (k === "new" || k === "indeterminate" || k === "done" ? k : "new");

// a plain paragraph in Atlassian's document format, the only form v3 takes for a description
const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

export class JiraError extends Error {}

// Jira's REST API at `base` (a site, or api.atlassian.com/ex/jira/<cloud id>), with whatever
// authorization `auth` gives for each call (a fresh one when a sign-in has to be refreshed).
export class JiraRest implements JiraClient {
  private readonly base: string;
  private readonly auth: () => Promise<string>;
  private readonly fetchFn: Fetch;

  constructor(base: string, auth: () => Promise<string>, fetchFn: Fetch = fetch as unknown as Fetch) {
    this.base = trimEnd(base, "/");
    this.auth = auth;
    this.fetchFn = fetchFn;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { authorization: await this.auth(), accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchFn(`${this.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) {
      const said = (await res.text().catch(() => "")).replaceAll(/\s+/g, " ").slice(0, 200);
      throw new JiraError(`Jira ${method} ${path.split("?")[0]}: ${res.status}${said ? ` ${said}` : ""}`);
    }
    return res.status === 204 ? undefined : res.json().catch(() => undefined);
  }

  async myself(): Promise<{ name: string }> {
    const me = (await this.call("GET", "/rest/api/3/myself")) as { displayName?: string; emailAddress?: string };
    return { name: me.displayName ?? me.emailAddress ?? "you" };
  }

  async createIssue(project: string, summary: string, description: string): Promise<{ key: string }> {
    const made = (await this.call("POST", "/rest/api/3/issue", {
      fields: { project: { key: project }, summary, issuetype: { name: "Task" }, labels: [TIRA_LABEL], description: adf(description) },
    })) as { key?: string };
    if (typeof made?.key !== "string") throw new JiraError("Jira made the issue but sent no key");
    return { key: made.key };
  }

  issues(project: string): Promise<JiraIssue[]> {
    return this.search(`project = "${project}" AND labels = "${TIRA_LABEL}" ORDER BY key ASC`, "summary,status,labels");
  }

  everyIssue(project: string): Promise<JiraIssue[]> {
    return this.search(`project = "${project}" ORDER BY created ASC`, "summary,status,labels,parent,creator");
  }

  private async search(query: string, fields: string): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    const jql = encodeURIComponent(query);
    let next: string | undefined;
    for (let page = 0; page < 50; page++) {
      const at = next === undefined ? "" : `&nextPageToken=${encodeURIComponent(next)}`;
      const got = (await this.call("GET", `/rest/api/3/search/jql?jql=${jql}&fields=${fields}&expand=changelog&maxResults=100${at}`)) as { issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean };
      for (const i of got?.issues ?? []) out.push(toIssue(i));
      next = got?.nextPageToken;
      if (got?.isLast !== false || next === undefined) break;
    }
    return out;
  }

  async moveTo(key: string, to: Category): Promise<string> {
    const k = encodeURIComponent(key);
    const got = (await this.call("GET", `/rest/api/3/issue/${k}/transitions`)) as { transitions?: { id: string; to?: { name?: string; statusCategory?: { key?: string } } }[] };
    const t = (got?.transitions ?? []).find((x) => x.to?.statusCategory?.key === to);
    if (!t) throw new JiraError(`Jira ${key}: no transition to a "${to}" status from where it is`);
    await this.call("POST", `/rest/api/3/issue/${k}/transitions`, { transition: { id: t.id } });
    return t.to?.name ?? to;
  }

  async setLabels(key: string, add: string[], remove: string[]): Promise<void> {
    if (add.length + remove.length === 0) return;
    await this.call("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: [...add.map((a) => ({ add: a })), ...remove.map((r) => ({ remove: r }))] } });
  }

  async projects(): Promise<{ key: string; name: string }[]> {
    const got = (await this.call("GET", "/rest/api/3/project/search?maxResults=100&orderBy=name")) as { values?: { key?: string; name?: string }[] };
    return (got?.values ?? []).flatMap((p) => (typeof p.key === "string" ? [{ key: p.key, name: p.name ?? p.key }] : []));
  }
}

// An email and API token (tira connect-jira), on the site itself.
export class JiraCloud extends JiraRest {
  constructor(site: string, email: string, token: string, fetchFn: Fetch = fetch as unknown as Fetch) {
    const basic = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    super(site, async () => basic, fetchFn);
  }
}

function toIssue(i: RawIssue): JiraIssue {
  const moves = (i.changelog?.histories ?? []).filter((h) => (h.items ?? []).some((x) => x.field === "status"));
  const last = moves.reduce<(typeof moves)[number] | undefined>((a, h) => (a === undefined || h.created > a.created ? h : a), undefined);
  return {
    key: i.key,
    summary: i.fields.summary ?? "",
    status: i.fields.status?.name ?? "",
    category: category(i.fields.status?.statusCategory?.key),
    labels: i.fields.labels ?? [],
    ...(last ? { movedBy: { name: last.author?.displayName ?? "someone", at: last.created, id: last.id } } : {}),
    ...(i.fields.parent?.key ? { parent: i.fields.parent.key } : {}),
    ...(i.fields.creator?.displayName ? { createdBy: i.fields.creator.displayName } : {}),
  };
}
