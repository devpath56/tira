# Projects (the sidebar) and the way home

**JTBD:** 3 — Get interrupted and resume exactly (across more than one build).

**What / why.** A project is one task tree (one repo and one Jira board; in the store, a
stream; in the code, a workspace). Isha works in several (her projects, Devansh's factory), so
one `tira serve` serves every project the store holds, and switching is one click in the
sidebar, like Linear's teams, not a restart with another `--stream`. The tira mark is the way
home: a click on it opens the board of the project you're in, at the top, with no dialog open
(in a rendered file it goes to the top of the page).

**How to read it.** Under `tira serve`, the sidebar's **Projects** lists every project in the
store, by name, each with its mark (its first letter on its own colour, the same as in the
page's header), "N open of M" and, in a badge, how many tasks need you there (blocked, or being
worked on); the one you're in is marked. The header click folds the list away, like Linear's
sections. Arrows move between projects, Enter opens one. On a narrow screen the sidebar is a
top bar and Projects is a dropdown (Esc or a click outside closes it). At the foot, **you**: who
the page acts as, and your settings. The project the server started on (`--stream`) opens at
`/`, any other at `/?w=<name>`; every link and form the server makes carries that on, so a page,
its decisions and their writes stay in the project they were opened in, and an action's result
comes back to it. **+ New project** takes a name and opens the connect step for it (its GitHub
repo, then Jira if you use one); signed in with GitHub, the new project's board opens once its
repo is linked. Without GitHub sign-in, a name the store doesn't hold is a "No project named …
yet" page that says how to start it (Settings and integrations, for that project) and the way
home.

## Devtool hook

- `[data-home]` on the mark: the link home.
- `[data-workspaces]` on Projects (live page only); `[data-ws-menu]` holds its list, one `.ws-item` per project (`aria-current="page"` on the one you're in), each with its `.pav` mark.
- `[data-profile]` on you (live page only).
- `GET /api/workspaces` (read when the list first shows): each project's name, where it opens, its tasks, the open ones and how many need you.
- `[data-no-workspace]` on the page for a name the store doesn't hold, `[data-start-project]` on its way to start it; `[data-new-project]` on + New project.

Assertion: a write made from a workspace's page lands in that workspace's stream and in no
other; the list's counts are the page's own (tasks as the Kanban counts them, needs-you as
Needs attention counts it).

**Falsifier.** A decision opened in one workspace writes to another, a link from a workspace's
page drops it (and lands in the first one), or a workspace with events in the store is missing
from the list.
