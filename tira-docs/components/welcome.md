# The way in: landing, sign-in, connect

**JTBD:** 1 — Track a branching build depth-first (and 2 — Prove a task is done).

**What / why.** The first thing someone sees under `tira serve` when no one is signed in: what
tira does, and one button. Then GitHub's code to approve, then one step to connect the
workspace to a GitHub repo and, if they use Jira, a Jira project. Then the board, on Kanban.
Only under `tira serve`, and only when someone has to sign in: started without `--actor`, or
once GitHub sign-in is set up (`/welcome`, `/connect`; the routes are in
`src/serve/integrations.ts`, the pages in `src/serve/welcome.ts`).

**How to read it.** Apple's Human Interface Guidelines, as in debugAssist's sign-in page: a
material card, the sign-in button in the label colour, blue for the one primary action, grouped
lists for choices, and few words. Light and dark:
- **Landing** (`/welcome`): a split card. Left, what tira does, its four steps lighting in turn
  (still under Reduce Motion). Right, **Sign up with GitHub** and **Sign in with GitHub**, with
  "New here? Sign up with GitHub: you're the admin of every project you make, and you add your
  team." A browser someone has signed in on offers **Continue with GitHub** alone. The first time
  on a machine, the right side asks for tira's GitHub app instead (its Client ID, with the three
  steps to make it), then shows the buttons.
- **Email** (`/signup/email`, once): when GitHub's profile shows no email, "One more thing" asks
  for one before anything else. Only its owner sees it; they change it in Account settings.
- **Code** (after Continue with GitHub): the same card; GitHub's code, large, with **Copy**,
  **Open GitHub** (a new tab), and a status line. The page goes on by itself once GitHub says yes
  (`signin.mjs`); without the script, "I've approved it: continue" does the same.
- **Connect** (`/connect`, signed in): steps across the top (signed in, connect, board). A repo,
  picked from your GitHub repos (or typed, if GitHub didn't list them): needed. A Jira project:
  optional, with **Connect Jira** (Atlassian and back, at `localhost`), then a project picker
  with "No Jira project". **Open the board** links both, as the person signed in (a new version
  of the workspace's link only if something changed), and opens the board.

Who gets in (Isha, 2026-10-25): anyone with GitHub, at once, with no one to approve them. Each
project is seen only by its own people: whoever makes a project is its admin, and its admins add
people by GitHub username (Project settings → Team). The first person to sign in (or the one the
server names, `TIRA_ADMIN`) is this tira's owner: its setup, and removing an account, nothing more.
Someone whose account the owner removed is turned back to the landing.

Where each page sends you: no one signed in, every page goes to the landing; signed in with no
email yet, to the email step; signed in but not in the project tira opened on, to your projects
(`/projects`: make your first one); in it with no repo linked, the board goes to Connect; in it
and linked, the landing goes to the board. A form can send you back only to tira's own steps.

## Devtool hook

- `[data-landing]` on the landing's card; `[data-signup-start]` on Sign up with GitHub (someone new: in at once), `[data-signin-start]` on Sign in (Continue with GitHub on a browser someone signed in on, which offers Sign in only); `[data-setup-github]` on the first-run form.
- `[data-newcomer]` on the word to someone new; `[data-signup-email]` on the email step's form.
- `[data-signin]` on the code step's card; `[data-user-code]` on the code; `[data-copy]` on Copy; `[data-open-github]` on Open GitHub; `[data-signin-status]` on the status line; `[data-signin-wait]` on the form that waits.
- `[data-consent-page]` on the page that approves Claude's connection (at a public address): `[data-consent-who]` on who asked, `[data-consent]` on its form, `[data-consent-allow]` and `[data-consent-cancel]` on its buttons.
- `[data-connect]` on the connect card; `[data-repo-pick]` on the repo picker; `[data-connect-jira]` on Connect Jira; `[data-open-board]` on Open the board.

Assertion: no one signed in, the board, Integrations and Connect send you to the landing, and
nothing is written; a signed-in person with no repo is sent to Connect; someone new signs up and
lands on their own projects, and someone else's project doesn't exist for them (`test/sync.test.ts`).

**Falsifier.** Someone who isn't signed in, or isn't one of a project's people, sees its board or
changes anything, or a form sends a person to an address outside tira.
