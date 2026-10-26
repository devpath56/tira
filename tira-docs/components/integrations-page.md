# Settings: Account settings and Project settings

**JTBD:** 1 — Track a branching build depth-first (and 2 — Prove a task is done).

**What / why.** Two pages, after GitHub's settings (Isha, 2026-10-22): **Account settings** are
yours, the same in every project (`/settings`, from your profile at the foot of the sidebar), and
**Project settings** are the project's own (`/integrations`, from the sidebar's Project settings
and the board's Linked bar). The first time, the way in links the first project in one step
(`welcome.md`); these pages are for changes after, under `tira serve` only; someone who isn't
signed in is sent to the landing.

**How to read it.** Each across the whole window: the sections on the left (the tira mark goes
back to the board you came from; there is no other back link), one section at a time across the
middle, as Chrome's settings show them (Isha, 2026-10-26: all of them at once was overwhelming
the first time), and the **Help centre** on the right. Each section is a title, a line on what it
is for, then only its own rows of label and control, a footnote at most. The list on the left
marks the one shown; the address names it (`/settings#linked`), so a link, Back, or a form's
answer lands on that section, at the top of the page with its title and any result in view, and
with none named the first shows. The look, after Linear's, GitHub's and Stripe's settings (Isha,
2026-10-26): the list is grouped (Account, and This tira for its owner; Project, Connections,
Advanced), an icon on each item, the current one a tinted pill with a bar, a green dot beside a
linked GitHub or Jira and the number of agents beside Agents, and Danger zone in red. Each
section's header is its icon on a tile, its title and its line. Rows are taller, the label first
and a muted line under it where there is one. Names and your email save as
you type (a moment after you stop, or when you leave the field), with a quiet **Saved** beside
them and nothing to press; a name tira won't take says why in the same place. The Help centre is
a support chat after Intercom's and Zendesk's; it starts folded to a tab and stays open or shut as
you left it, per browser. Under a header that says it answers
right away, tira greets you by name and offers the questions people ask here as suggested replies
(how to make tira's GitHub app or the Atlassian app, where keys are kept, what Sync does, who can
sign in, why Jira needs localhost). Pick one, or type your own in the box at the foot: your
question shows on the right, tira types for a moment, and its answer shows on the left, with the
questions not asked yet under it. What you type is matched to those answers on the page (a rarer
word counts for more) and never leaves it; when nothing fits, tira says so and offers every
question again. With no script, each suggestion opens on its answer.

Account settings (no project on them), in this order:
- **Profile**: who is signed in, as GitHub and Jira show it (the initial as a picture, the name,
  @login, Owner for this tira's owner), and **Sign out**; a **Display name** to be shown by (the
  sidebar, this card, the Help centre's greeting), empty for GitHub's name; your **Email** (only
  you see it); and your **Username**, with Copy and your **Profile** (`/u/<username>`, for anyone
  signed in: your name and username, never your email), to send to a project's admin. Changes are
  still recorded under your login. When `tira serve` was started with a name and GitHub sign-in
  isn't set up, changes are recorded as that name.
- **GitHub and Jira**: your GitHub (signed in as @login; **Disconnect GitHub** forgets its token
  and signs you out) and your Jira: **Connect Jira** goes to Atlassian and back (open tira at
  `localhost`: that's where Atlassian sends you), then a site picker if you have more than one;
  **Disconnect Jira** drops your Atlassian sign-in. Your links stay until you unlink them (Isha,
  2026-10-22). Connecting Jira is yours to do, with no admin to ask (Isha, 2026-10-26); until
  whoever runs this tira has added tira's Atlassian app, once, for everyone, it says "Not available
  on this tira yet".
- **Appearance**: System, Light or Dark, each a card with a small picture (`theme-switch.md`).
- **Setup: tira's apps** (whoever runs this tira only; nobody else sees it, Isha, 2026-10-26): the
  Client ID of tira's GitHub app, and the Client ID and Secret of its Atlassian app, with **Save**
  (keys aren't saved half-typed). The secret is a hidden field and is never shown again. On
  Render, the same keys can be set as environment variables instead (`render.yaml`).
- **Removed accounts** (whoever runs this tira only, Isha, 2026-10-25): **Remove account** by GitHub
  username signs them out at once, keeps them from signing in, and stops their agents; their
  GitHub and Jira links stay until they unlink them, and their projects stay with their other
  admins. **Let back in** undoes it. Nobody's projects show here.

Project settings (the project's mark and name at the top), in this order:
- **General**: the project's name, as everyone sees it everywhere in tira, saved as you type. Its address,
  its colour and its history keep the name it was made with; two live projects can't share a name.
  A later link change (here or `tira link`) keeps the name.
- **Collaborators** (Isha, 2026-10-25; named after GitHub's, 2026-10-26): this project's admins
  and members, who alone can see it, and its agents, each with an initial on a tint of its own (an
  agent: its icon, its last call, and Active when it called in the last day, else Idle). Whoever
  made the project is its admin. Its
  admins invite someone in **Invite collaborators**, by GitHub username (Isha, 2026-10-26: an
  invite, not a way in): the invite shows here as Invited, by whom, with the bin to take it back,
  and reaches them as a letter (`invites.md`); they see the project once they accept. Its admins
  pick each person's role (**Admin** or **Member**, a picker that saves when
  changed), and remove someone with the bin (named "Remove …" for a screen reader), asked first (they no longer see it, and their agents here stop).
  Your own row never has Remove, and has no role picker while you're the only admin: a project
  always keeps an admin, so there's nothing there to refuse. Members work on it, sync it and
  connect agents; renaming, linking, collaborators and deleting are its admins'.
  A project made before then has whoever made it as admin (else the owner), and the people
  everyone had then as members, until its team is first changed. At a public address each person
  may be admin of 5 projects.
- **GitHub**: the linked repo, and a picker of your repos (**Link this repo**, **Unlink**).
- **Jira**: a picker of your Jira site's projects (**Link this project**, **Unlink**); before
  you've connected Jira, **Connect Jira** (it connects your account, for every project, from
  Account settings' GitHub and Jira). Before tira's Atlassian app is added, it says whoever runs
  this tira turns Jira on, once, for everyone (they get the way to Setup).
- **Connect agents** (Isha, 2026-10-24: "systematic and simple for a first time user"; connector
  first and Claude Code first, 2026-10-26): connect an AI agent to this project through tira's
  MCP server, each under its own name. **Claude Code** leads (Recommended). At tira's public
  address, by a connector in the person's Claude account, shown as five short steps played beside a
  small moving picture of each (`cplay.mjs`; Isha, 2026-10-26: "an animated step play"): Copy tira's
  address; Open Claude → Connectors; Add custom connector; Connect, then approve; Run /mcp in
  Claude Code (which picks up connectors added on claude.ai when signed in with that account). It
  goes round every few seconds; a step clicked shows its own; hovering holds it; under Reduce
  Motion it stays still. No command and no token; the same connector serves Claude on the
  web and the Claude app. Its command is folded in the card (for an API key, or the terminal). On
  this computer, by its command (**Set up Claude Code**), with a line saying the connector comes
  with hosted tira, since Claude reaches a connector over the internet. Then **Or Cursor, VS
  Code**, a tile each; on this computer, **Claude Desktop, the chat app?** folded under them (its
  config entry). Claude Code and Claude Desktop are different apps: the coding agent, and the chat
  app. An app picked: (2) **Name your agent**, its name suggested (`claude-code`,
  `cursor-agent`, `vscode-agent` or `claude-desktop`, numbered if taken; a person's name is caught,
  with why), and **Connect** makes its token; (3) **Finish in the app**, one thing to do: **Add to
  Cursor** or **Add to VS Code** (the app shows the server and asks first; the setup by hand folds
  under it), Claude Code's one command, or Claude Desktop's config entry (with a warning when
  tira's `.env` wouldn't reach this board). The token shows only there, for 10 minutes, to whoever
  made it. Each step is its own address; with the page's script, steps change in place, with no
  page load. A step that waits on an agent (Claude's card, or step 3) says so calmly and turns
  green by itself the moment the agent first calls tira (the page asks every few seconds, for ten
  minutes, while it's in view; **Check now** asks at once), and the list below updates. Below, the
  **Connected agents** (their app, who connected them, when, last used; **Revoke** for whoever
  connected it, or the project's admins). **More** folds the rest: tira's MCP address
  (`http://127.0.0.1:<port>/mcp`), each app by hand with `<your token>`, what agents can do, and
  whether Claude Desktop's agent would reach this tira's database (tira's own `.env`, compared,
  never shown). Only each token's fingerprint is kept; a revoked agent's next call is refused.
- **Danger zone**, last, as GitHub keeps it: type the project's name to confirm, then **Delete this project**. It leaves
  the project list and its board closes, for everyone; tira never erases, so its history stays in
  the log (a new version of its link, marked deleted). The project tira opens on (the one tira
  serve was started with) can't be deleted: it says so plainly, and points to renaming it in
  General.

Sync is the board's, in the bar above it, not a setting (`workspace-bar.md`); and the pages show
buttons and pickers, never the commands they amount to (Isha, 2026-10-26). A form's result shows
above the section it came from and goes when you pick another section. Tokens, keys
and the secret live only in the private store: on Postgres, beside the log, each sealed with
`$TIRA_SECRET_KEY` and shared by everyone on that database (a change on one computer shows on
everyone's next page); with no database, `$TIRA_HOME/credentials.json`, readable by its owner
only. The store keeps a hash of each session (30 days in a remembered browser, else 12 hours at
most), so it can't sign anyone in.

## Devtool hook

- `.set-group` on each group's label in the list, `.set-dot` on a linked one's dot, `.set-count` on Agents' count; `.grp-top` on each section's header, `.grp-icon` on its tile; `.team-row` on each collaborator, `.team-del` on Remove, `.live` (`on` while active) on an agent's status.
- `[data-settings]` on both pages; `[data-int]` on each group (`profile`, `linked`, `appearance`, `setup`, `accounts` in Account settings; `general`, `team`, `github`, `jira`, `sync`, `agents`, `delete` in Project settings), each with that id for the nav's links; `[data-default]` on the section shown when the address names none; `aria-current="page"` on the nav link of the one shown (`sections.mjs`); `[data-profile-card]` on the profile; `[data-help]` on the Help centre (`details[data-remember]` remembers it open or folded; folded at first), `[data-help-log]` on its conversation, `[data-help-ask]` on the box to type in.
- `[data-autosave]` on each form that saves as you type (display name, email, the project's name; `autosave.mjs`), `[data-save-state]` on where it says Saving…, Saved, or why not.
- `[data-agent-code]` on Claude Code's card, `[data-agent-connector]` on it at a public address (`ok` in its class once green), `[data-agent-terminal]` on its folded command, `[data-agent-desktop]` on Claude Desktop's fold (on this computer), `[data-agent-step]` on each of an app's three steps (`now`, `done` or `later` in its class), `[data-agent-tile]` on each app to choose; `[data-agent-go]` on what changes a step in place (`agents.mjs`); `[data-agent-name]` on naming the agent; `[data-agent-install]` on the app's Add to button; `[data-agent-watch]` on what asks until the agent calls (`/integrations/agents/heard` for Claude's card), `[data-agent-test]` on Check now, the answer in `[data-agent-tested]`; `[data-agents]` on the connected agents; `[data-agent-more]` on More, `[data-agent-app]` on each app's setup there (`[data-copy-target]` on every Copy); `[data-agent-database]` on the database line (`ready`, `missing` or `different`); `[data-agent-connectors]` on the word that the connector comes with hosted tira (on this computer).
- `[data-email]` on your email; `[data-username]` on your username (and on a profile's, `/u/<username>`); `[data-accounts]` on the owner's removed accounts, `[data-remove-account]` on Remove account; `[data-projects]` on your projects (`/projects`), `[data-my-project]` on each.
- `[data-link-repo-form]` on the repo picker; `[data-delete-project]` on Delete; `[data-rename-project]` on Rename; `[data-project-id]` on the project's id (it never changes: it's in its address and its tickets' keys); `[data-team]` on Collaborators (the project's people and agents), `[data-team-admin]` and `[data-team-member]` on each person, `[data-team-agent]` on each agent, `[data-team-add]` on Add collaborators (its admins'), `[data-autosubmit]` on a role picker and `[data-confirm]` on Remove (`forms.mjs`), `[data-team-remove]` on its button; `[data-display-name]` on your display name; `[data-disconnect-github]` on Disconnect GitHub.
- `[data-integrations-nav]` on the profile menu's Account settings; `[data-user]` on the profile when someone is signed in with GitHub (`[data-signout]` signs them out). For a project other than the one the server started on, every link, form and redirect on these pages keeps its `?w=` (`project-switch.md`).

Assertion: no token, key or secret appears on any page; a Jira sign-in that didn't start here is
refused; Setup is on the page only for whoever runs this tira; a name saved as you type gets its
answer alone, and a form's answer comes back to its own section (`test/sync.test.ts`).

**Falsifier.** A change is recorded as someone other than the person signed in, or a secret
appears on a page or in the history.
