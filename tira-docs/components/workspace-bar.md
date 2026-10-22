# The project's links (GitHub and Jira, beside its name)

**JTBD:** 1 — Track a branching build depth-first (and 2 — Prove a task is done).

**What / why.** A project (a workspace, in the code) is one task tree, linked to one GitHub repo
and one Jira project. On the right of the project's name, its links say what it's linked to, so
where its pull requests and its Jira issues live is one click away. tira leads and Jira mirrors; nothing moves
in Jira until someone syncs.

**How to read it.** GitHub's mark and owner/name, Jira's mark and its KEY, each a link out.
Under `tira serve`, only while nothing is linked, one way in instead: **Connect GitHub and Jira**,
to Project settings (`integrations-page.md`). Once linked, **Sync** (the same sync as Project
settings', as the person signed in; the result shows in the banner), and **Add Jira** or **Add
GitHub** while one is missing (straight to that section of Project settings). Project settings
themselves are in the sidebar.

Each task's card carries its Jira key, and its dialog lists its Jira issue (with the status tira
last set) and its pull requests (open, merged or closed). Completing a task with a merged pull
request offers it as the proof.

## Devtool hook

- `[data-workspace]` on the links (`.proj-links`); `[data-link-repo]` and `[data-link-jira]` on each.
- `[data-integrations]` on its way to Project settings, `[data-add-jira]` on Add Jira, and `[data-sync]` on its Sync button, live only.
- `[data-jira-key]` on a card's Jira chip; `[data-task-links]` on a task dialog's Jira and pull request lines.

Assertion: the rendered file shows the links and none of the actions; the token never appears on
any page (`test/sync.test.ts`).

**Falsifier.** A task's Jira status disagrees with tira after a sync with no problem reported, or
a token appears in the history or on a page.
