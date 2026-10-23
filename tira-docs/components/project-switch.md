# Projects (the sidebar) and the way home

**JTBD:** 3 — Get interrupted and resume exactly (across more than one build).

**What / why.** A project is one task tree (one repo and one Jira board; in the store, a
stream; in the code, a workspace). Isha works in several (her projects, Devansh's factory), so
one `tira serve` serves every project the store holds, and switching is one click in the
sidebar, like Linear's teams, not a restart with another `--stream`. The tira mark is the way
home: a click on it opens the board of the project you're in, at the top, with no dialog open
(in a rendered file it goes to the top of the page).

**How to read it.** Under `tira serve`, the sidebar's **Projects** lists every project in the
store (but deleted ones), by name as people see it (renamed in Project settings: its new name), each with its mark (its first letter on its own colour, the same as in the
page's header), "N open of M" and, in a badge, how many tasks need you there (blocked, or being
worked on); the one you're in is marked. The header click folds the list away, like Linear's
sections. Arrows move between projects, Enter opens one. **Search projects**, at the top of the
sidebar, keeps the projects whose names (or the names they were made with) hold what you type (Enter opens the first, Esc clears it;
"No project named …" when none does); tasks are searched in the board's header
(`command-palette.md`). Under the views, **Project settings** opens this project's settings: its
GitHub repo, its Jira project, Sync, and **Delete** (`integrations-page.md`). On a narrow screen the sidebar is a
top bar and Projects is a dropdown (Esc or a click outside closes it). At the foot, **you**: your name,
and a menu to your Account settings (and Sign out, signed in with GitHub). The project the server started on (`--stream`) opens at
`/`, any other at `/?w=<name>`; every link and form the server makes carries that on, so a page,
its decisions and their writes stay in the project they were opened in, and an action's result
comes back to it. **+ New project** opens a page of its own (`/projects/new`, after Jira's and Vercel's): the steps
on the left, the project's name, GitHub repo and Jira project across the middle, and on the right a
preview of its mark and name as you type, with what happens next. Your accounts fill it in: your
GitHub repos as suggestions (owner/name; tira's rules want a project born linked) and, if you've
connected Jira, its projects to pick from (or none for now); if you haven't, **Connect with Jira**
does it in a tab of its own; when Atlassian says yes, the page swaps in the picker and leaves what
you typed as it was (it isn't kept anywhere but the form). **Create project** makes it as the person acting and
opens on the new project's own board, where its linked bar offers **Add Jira** and **Sync**;
**Cancel** and the tira mark go back to the board you came from. A taken name, a name that can't
be one, or a repo that isn't owner/name writes nothing: the page comes back with what you typed,
why, and the cursor on the field to fix. A deleted project leaves the list, its board says it was
deleted and by whom (its history stays in the log: tira never erases), and its name isn't
offered again. A name the store doesn't hold
is a "No project named … yet" page that says how to start it and the way home.

## Devtool hook

- `[data-home]` on the mark: the link home.
- `[data-workspaces]` on Projects (live page only); `[data-ws-menu]` holds its list, one `.ws-item` per project (`aria-current="page"` on the one you're in), each with its `.pav` mark.
- `[data-profile]` on you (live page only).
- `GET /api/workspaces` (read when the list first shows): each project's name, where it opens, its tasks, the open ones and how many need you.
- `[data-no-workspace]` on the page for a name the store doesn't hold, `[data-start-project]` on its way to start it; `[data-project-search]` on Search projects; `[data-project-settings]` on Project settings. `[data-new-project]` on + New project; `[data-new-project-page]` on its page, `[data-new-project-form]` on the form (it posts to `/projects`), `[data-np-preview]` on the preview, `[data-np-problem]` on why it wasn't made.

Assertion: a write made from a workspace's page lands in that workspace's stream and in no
other; the list's counts are the page's own (tasks as the Kanban counts them, needs-you as
Needs attention counts it).

**Falsifier.** A decision opened in one workspace writes to another, a link from a workspace's
page drops it (and lands in the first one), or a workspace with events in the store is missing
from the list.
