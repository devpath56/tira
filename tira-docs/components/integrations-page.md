# Settings: Account settings and Project settings

**JTBD:** 1 — Track a branching build depth-first (and 2 — Prove a task is done).

**What / why.** Two pages, after GitHub's settings (Isha, 2026-10-22): **Account settings** are
yours, the same in every project (`/settings`, from your profile at the foot of the sidebar), and
**Project settings** are the project's own (`/integrations`, from the sidebar's Project settings
and the board's Linked bar). The first time, the way in links the first project in one step
(`welcome.md`); these pages are for changes after, under `tira serve` only; someone who isn't
signed in is sent to the landing.

**How to read it.** Each across the whole window: the sections on the left (the tira mark goes
back to the board you came from; there is no other back link), the page across the middle (each
section a title, a line on what it is for, then rows of label and control, a footnote at most),
and the **Help centre** on the right, a support chat after Intercom's and Zendesk's (it folds to a
tab, and stays open or shut as you left it, per browser). Under a header that says it answers
right away, tira greets you by name and offers the questions people ask here as suggested replies
(how to make tira's GitHub app or the Atlassian app, where keys are kept, what Sync does, who can
sign in, why Jira needs localhost). Pick one, or type your own in the box at the foot: your
question shows on the right, tira types for a moment, and its answer shows on the left, with the
questions not asked yet under it. What you type is matched to those answers on the page (a rarer
word counts for more) and never leaves it; when nothing fits, tira says so and offers every
question again. With no script, each suggestion opens on its answer.

Account settings (no project on them):
- **Profile**: who is signed in, as GitHub and Jira show it (the initial as a picture, the name,
  @login, Admin or Member), and **Sign out**; a **Display name** to be shown by (the sidebar, this
  card, the Help centre's greeting), empty for GitHub's name. Changes are still recorded under your
  login. When `tira serve` was started with a name and GitHub sign-in isn't set up, changes are
  recorded as that name.
- **Accounts**: your GitHub (signed in as @login; **Disconnect GitHub** forgets its token and signs
  you out) and your Jira: **Connect Jira** goes to Atlassian and back (open tira at `localhost`:
  that's where Atlassian sends you), then a site picker if you have more than one; **Disconnect
  Jira** drops your Atlassian sign-in. Your links stay until you unlink them (Isha, 2026-10-22).
- **Appearance**: System, Light or Dark, each a card with a small picture (`theme-switch.md`).
- **People**: who may sign in. The admin (the first person who signed in) sees the list, adds
  someone by GitHub username, removes someone (signed out at once and can't sign in; their GitHub
  and Jira links stay until they unlink them),
  and sets the name and email the sign-in page shows to anyone not on the list. Everyone else
  sees who to ask.
- **Setup: tira's apps** (open while one is missing): the Client ID of tira's GitHub app, and the
  Client ID and Secret of its Atlassian app. The secret is a hidden field and is never shown again.

Project settings (the project's mark and name at the top):
- **General**: the project's name, as everyone sees it everywhere in tira (**Rename**). Its address,
  its colour and its history keep the name it was made with; two live projects can't share a name.
  A later link change (here or `tira link`) keeps the name.
- **GitHub**: the linked repo, and a picker of your repos (**Link this repo**, **Unlink**).
- **Jira**: a picker of your Jira site's projects (**Link this project**, **Unlink**); before
  you've connected Jira, **Connect Jira** (it connects your account, for every project).
- **Sync**: **Sync now**, the same as `tira sync`.
- **Connect agents** (Isha, 2026-10-24: "systematic and simple for a first time user"): connect
  an AI agent to this project through tira's MCP server, each with its own token and name, in
  three numbered steps, each its own address. (1) **Choose your app**: Claude Code, Cursor, VS Code
  or Claude Desktop. (2) **Name your agent**: its name suggested (`claude-code`, `cursor-agent`,
  `vscode-agent` or `claude-desktop`, numbered if taken; a person's name is caught, with why), and
  **Connect** makes its token. (3) **Finish in the app**, one thing to do: **Add to Cursor** or
  **Add to VS Code** (the app shows the server and asks first; the setup by hand folds under it),
  Claude Code's one command (it replaces an earlier tira entry for the project; then a new
  session, asked "what's next in tira?"), or Claude Desktop's config entry (with a warning when tira's `.env`
  wouldn't reach this board). The token shows only there, for 10 minutes, to whoever made it.
  **Test connection** says whether tira has heard from the agent yet (its first call); until then
  it says so calmly, as a wait, not an error, with the quickest way to make that call (for Claude
  Code, `claude mcp list`). Below, the **Connected agents** (their app, who connected them, when, last used;
  **Revoke** for whoever connected it, or the admin). **More** folds the rest: tira's MCP address
  (`http://127.0.0.1:<port>/mcp`), each app by hand with `<your token>`, what agents can do, and
  whether Claude Desktop's agent would reach this tira's database (tira's own `.env`, compared,
  never shown), and why Claude's own Connectors settings can't add tira yet (they need a public
  https address: tira hosted). Only each token's fingerprint is kept; a revoked agent's next call is refused.
- **Delete project**: type the project's name to confirm, then **Delete this project**. It leaves
  the project list and its board closes, for everyone; tira never erases, so its history stays in
  the log (a new version of its link, marked deleted). The project tira serve was started with
  can't be deleted here.

Every choice shows the `tira link` command it amounts to under **Show the command**. Tokens, keys
and the secret live only in the private store: on Postgres, beside the log, each sealed with
`$TIRA_SECRET_KEY` and shared by everyone on that database (a change on one computer shows on
everyone's next page); with no database, `$TIRA_HOME/credentials.json`, readable by its owner
only. The store keeps a hash of each session (it lasts 30 days), so it can't sign anyone in.

## Devtool hook

- `[data-settings]` on both pages; `[data-int]` on each group (`account`, `accounts`, `appearance`, `people`, `contact`, `setup` in Account settings; `github`, `jira`, `sync`, `delete` in Project settings), each with that id for the nav's links; `[data-profile-card]` on the profile; `[data-help]` on the Help centre (`details[data-remember]` remembers it open or folded), `[data-help-log]` on its conversation, `[data-help-ask]` on the box to type in.
- `[data-agent-step]` on each of Connect agents' three steps (`now`, `done` or `later` in its class), `[data-agent-tile]` on each app to choose; `[data-agent-name]` on naming the agent; `[data-agent-install]` on the app's Add to button; `[data-agent-test]` on Test connection, its answer in `[data-agent-tested]`; `[data-agents]` on the connected agents; `[data-agent-more]` on More, `[data-agent-app]` on each app's setup there (`[data-copy-target]` on every Copy); `[data-agent-database]` on the database line (`ready`, `missing` or `different`); `[data-agent-connectors]` on the word about Claude's Connectors (on this computer); at a public address, `[data-agent-connector]` on Claude's way in by its Connectors, with tira's address to paste.
- `[data-people]` on the admin's list; `[data-add-person]` on Add; `[data-admin-contact]` on how people reach the admin.
- `[data-link-repo-form]` on the repo picker; `[data-sync]` on Sync now; `[data-delete-project]` on Delete; `[data-rename-project]` on Rename; `[data-display-name]` on your display name; `[data-disconnect-github]` on Disconnect GitHub.
- `[data-integrations-nav]` on the profile menu's Account settings; `[data-user]` on the profile when someone is signed in with GitHub (`[data-signout]` signs them out). For a project other than the one the server started on, every link, form and redirect on these pages keeps its `?w=` (`project-switch.md`).

Assertion: no token, key or secret appears on any page; a Jira sign-in that didn't start here is
refused (`test/sync.test.ts`).

**Falsifier.** A change is recorded as someone other than the person signed in, or a secret
appears on a page or in the history.
