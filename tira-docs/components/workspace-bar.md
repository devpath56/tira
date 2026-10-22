# Workspace bar (git and Jira links)

**JTBD:** 1 — Track a branching build depth-first (and 2 — Prove a task is done).

**What / why.** A workspace is one project: one task tree, linked to one GitHub repo and one
Jira project. The bar under the header says what this one is linked to, so where its pull
requests and its Jira issues live is one click away. tira leads and Jira mirrors; nothing moves
in Jira until someone syncs.

**How to read it.** "Workspace" then GitHub owner/name and Jira KEY, each a link out. Not
linked yet, it says so and, under `tira serve`, offers one way in: **Connect GitHub and Jira**,
to the Integrations page (`integrations-page.md`). Once linked, it offers **Sync** (the same sync
as the Integrations page's, as the person signed in; the result shows in the banner) and
**Integrations**.

Each task's card carries its Jira key, and its dialog lists its Jira issue (with the status tira
last set) and its pull requests (open, merged or closed). Completing a task with a merged pull
request offers it as the proof.

## Devtool hook

- `[data-workspace]` on the bar; `[data-link-repo]` and `[data-link-jira]` on its links.
- `[data-integrations]` on its way to the Integrations page and `[data-sync]` on its Sync button, live only.
- `[data-jira-key]` on a card's Jira chip; `[data-task-links]` on a task dialog's Jira and pull request lines.

Assertion: the rendered file shows the links and none of the actions; the token never appears on
any page (`test/sync.test.ts`).

**Falsifier.** A task's Jira status disagrees with tira after a sync with no problem reported, or
a token appears in the history or on a page.
