// The New project page, what "+ New project" opens (after Jira's and Vercel's): the steps on the
// left (the tira mark goes back to the board you came from), the project's name, GitHub repo and
// Jira project across the middle, and a preview of it on the right with what happens next. Your
// accounts fill it in: your repos as suggestions and, once you've connected Jira, its projects to
// pick from (else a way to connect it, in a tab of its own: when it's done, this page swaps in its
// Jira row alone, so what you typed stays as it is).
// Created, it opens on its own board. A name, repo or Jira project that can't be one comes back here
// with what was typed and why; nothing is written.
import { brand, CSS, projectMark, SIDE_SHUT, SIDE_TOGGLE, THEME_RADIOS } from "../render/html.ts";
import { esc } from "../render/escape.ts";
import type { JiraState } from "./integrations.ts";

// the patterns the fields show (the server's checks are the rule: NEW_NAME and REPO)
const NAME_FIELD = "[A-Za-z0-9][A-Za-z0-9_.\\-]{0,79}";
const REPO_FIELD = "[A-Za-z0-9][\\w.\\-]*/[\\w.\\-]+";

export interface NewProject {
  token: string;
  back: string; // the board it was opened from
  action: string; // where the form posts
  repos: string[]; // yours, from GitHub
  jira: JiraState | { state: "signin" }; // where your Jira stands (signin: no GitHub sign-in to keep it under)
  name?: string;
  repo?: string;
  jiraProject?: string;
  problem?: { field: "name" | "repo" | "jira" | "who"; text: string };
}

// the Jira row: pick one of your Jira's projects, or connect Jira first (or why you can't yet)
function jiraRow(p: NewProject): string {
  const j = p.jira;
  const label = (hint: string) => `<span class="grp-k">Jira project<small>${hint}</small></span>`;
  const bad = p.problem?.field === "jira" ? ` aria-invalid="true" aria-describedby="np-problem"` : "";
  if (j.state === "connected" && j.cloudId) {
    const options = j.projects.map((x) => `<option value="${esc(x.key)}"${x.key === p.jiraProject ? " selected" : ""}>${esc(x.name)} (${esc(x.key)})</option>`).join("");
    return `<label class="grp-row np-field">${label(`Optional. From your Jira, ${esc(j.site ?? "")}.`)}<select name="jira_project" aria-label="Jira project"${bad} data-np-jira><option value="">None for now</option>${options}</select></label>`
      + (j.problem ? `<div class="grp-row"><span class="grp-k no">${esc(j.problem)}</span></div>` : "");
  }
  const row = (hint: string, v: string) => `<div class="grp-row np-field">${label(hint)}${v}</div>`;
  if (j.state === "connected") return row("Optional. Pick your Jira site first.", `<a class="how" href="/settings#account">Pick it in Account settings</a>`);
  if (j.state === "disconnected") return row("Optional. Connect your Atlassian account to pick one now, or add it later.", `<a class="act" href="${esc("/integrations/jira/connect?back=/projects/new&tab=1")}" target="_blank" rel="noopener" data-connect-jira>Connect with Jira</a>`);
  if (j.state === "elsewhere") return row("Optional. Atlassian sends you back to localhost.", `<a class="how" href="${esc(j.localhost)}">Open tira at localhost to connect</a>`);
  if (j.state === "signin") return row("Optional. Sign in with GitHub to connect Jira; add it later from the board.", `<span class="grp-v">Later</span>`);
  return row("Optional. tira's Atlassian app isn't set up yet.", `<a class="how" href="/settings#setup">Set it up in Account settings</a>`);
}

export function newProjectPage(p: NewProject): string {
  const name = p.name ?? "";
  const repo = p.repo ?? "";
  const bad = (f: "name" | "repo") => (p.problem?.field === f ? ` aria-invalid="true" aria-describedby="np-problem"` : "");
  // the cursor starts where there's something to fix, else on the name
  const first = p.problem?.field === "repo" ? "repo" : "name";
  const focus = (f: "name" | "repo") => (f === first ? " autofocus" : "");
  const steps = [["Name, repo and Jira", "on"], ["Its board opens", ""], ["Sync", ""]]
    .map(([t, on], i) => `<li${on ? ` class="on" aria-current="step"` : ""}><span class="np-n">${i + 1}</span>${t}</li>`).join("");
  const nav = `<nav class="set-nav" aria-label="New project">${brand(p.back)}<p class="set-k">New project</p><ol class="np-steps">${steps}</ol></nav>`;
  const field = (f: "name" | "repo", label: string, hint: string, input: string) =>
    `<label class="grp-row np-field"><span class="grp-k">${label}<small>${hint}</small></span>${input.replace("<input ", `<input${bad(f)}${focus(f)} `)}</label>`;
  const mine = p.repos.length > 0 ? `<datalist id="np-repos">${p.repos.map((r) => `<option value="${esc(r)}">`).join("")}</datalist>` : "";
  const form = `<form method="post" action="${esc(p.action)}" class="grp-list np-form" data-new-project-form><input type="hidden" name="token" value="${esc(p.token)}">`
    + field("name", "Project name", "Letters, digits, dots, dashes or underscores.", `<input name="name" value="${esc(name)}" required maxlength="80" pattern="${NAME_FIELD}" placeholder="mobile-app" autocomplete="off" spellcheck="false" data-np-name>`)
    + field("repo", "GitHub repository", `${mine ? "One of yours, or any" : "As"} owner/name. Its pull requests link to tasks; a merged one is the proof.`, `<input name="repo" value="${esc(repo)}" required pattern="${REPO_FIELD}" placeholder="owner/name" autocomplete="off" spellcheck="false"${mine ? ` list="np-repos"` : ""} data-np-repo>`) + mine
    + `<div class="np-jira" data-np-jira-row>${jiraRow(p)}</div>`
    + `<div class="grp-row np-acts"><a class="act" href="${esc(p.back)}">Cancel</a><button class="act primary" type="submit">Create project</button></div></form>`;
  const main = `<div class="set-main"><header class="int-head"><h1>Create a new project</h1><p>A project is one task tree with its own board, linked to one GitHub repo and, if you use one, one Jira project.</p></header>`
    + (p.problem ? `<div class="flash no" role="alert" id="np-problem" data-np-problem>${esc(p.problem.text)}</div>` : "")
    + form + `</div>`;
  const shown = name || "your-project";
  const aside = `<aside class="set-help np-side" aria-label="Preview"><div class="np-card" data-np-preview><p class="np-k">Preview</p>`
    + `<p class="np-who">${projectMark(shown)}<span><b data-np-show-name>${esc(shown)}</b><small data-np-show-repo>${esc(repo || "owner/name")}</small></span></p></div>`
    + `<p class="np-k">What happens next</p><ol class="np-next"><li>tira creates the project, as you, linked to its repo and its Jira project, if you picked one.</li><li>Its board opens, empty: add the first task with <code>tira create</code>.</li><li>Sync from its Linked bar: pull requests link to tasks, and each task gets its Jira issue.</li></ol></aside>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tira · New project</title><style>${CSS}</style></head><body>${THEME_RADIOS}${SIDE_SHUT}<main class="settings-page np-page" data-new-project-page>${SIDE_TOGGLE}${nav}${main}${aside}</main>`
    + `<script type="module" src="/theme.mjs"></script><script type="module" src="/tabs.mjs"></script><script type="module" src="/new-project.mjs"></script></body></html>\n`;
}
