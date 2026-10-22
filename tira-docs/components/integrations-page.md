# Integrations page

**JTBD:** 1 — Track a branching build depth-first (and 2 — Prove a task is done).

**What / why.** Where a signed-in person changes what a workspace is linked to, later: their
GitHub repo, their Jira connection and project, and tira's two apps. The first time, the way in
does this in one step (`welcome.md`); this page is for changes after. Under `tira serve` only, at
`/integrations` (the top bar's Integrations link); someone who isn't signed in is sent to the
landing.

**How to read it.** Grouped lists, as in Apple's Settings (a short header, rows of label and
control, a footnote at most):
- **Your account**: who is signed in, and **Sign out**. When `tira serve` was started with a name
  and GitHub sign-in isn't set up, changes are recorded as that name.
- **People**: who may sign in. The admin (the first person who signed in) sees the list, adds
  someone by GitHub username, removes someone (signed out at once; tira forgets their sign-ins),
  and sets the name and email the sign-in page shows to anyone not on the list. Everyone else
  sees who to ask.
- **GitHub**: the linked repo, and a picker of your repos (**Link this repo**, **Unlink**).
- **Jira**: **Connect Jira** goes to Atlassian and back (open tira at `localhost`: that's where
  Atlassian sends you), then a site picker (if you have more than one) and a project picker
  (**Link this project**). **Disconnect Jira** drops your Atlassian sign-in.
- **Sync**: **Sync now**, the same as `tira sync`.
- **Setup: tira's apps** (open while one is missing): the Client ID of tira's GitHub app, and the
  Client ID and Secret of its Atlassian app, with the steps to make each. The secret is a hidden
  field and is never shown again.

Every choice shows the `tira link` command it amounts to under **Show the command**. Tokens, keys
and the secret live only in the private store (`$TIRA_HOME/credentials.json`, readable by its
owner only); the store keeps a hash of each session, so it can't sign anyone in.

## Devtool hook

- `[data-int]` on each group (`account`, `people`, `contact`, `github`, `jira`, `sync`, `setup`).
- `[data-people]` on the admin's list; `[data-add-person]` on Add; `[data-admin-contact]` on how people reach the admin.
- `[data-link-repo-form]` on the repo picker; `[data-sync]` on Sync now.
- `[data-integrations-nav]` on the board's top-bar link; `[data-user]` beside it, the person signed in.

Assertion: no token, key or secret appears on any page; a Jira sign-in that didn't start here is
refused (`test/sync.test.ts`).

**Falsifier.** A change is recorded as someone other than the person signed in, or a secret
appears on a page or in the history.
