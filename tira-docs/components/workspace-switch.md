# Workspace switch and the way home

**JTBD:** 3 — Get interrupted and resume exactly (across more than one build).

**What / why.** A workspace is one task tree: a stream in the store. Isha works in several
(her projects, Devansh's factory), so one `tira serve` serves every workspace the store holds,
and switching is one click, not a restart with another `--stream`. The tira mark is the way
home: a click on it opens the board of the workspace you're in, at the top, with no dialog
open (in a rendered file it goes to the top of the page).

**How to read it.** Under `tira serve`, the button next to the mark names the workspace you're
in. Opened, it lists every workspace in the store, by name, each with "N open of M tasks" and,
in a badge, how many tasks need you there (blocked, or being worked on); the one you're in is
marked. Arrows move between them, Enter opens one, Esc or a click outside closes the list. The
workspace the server started on (`--stream`) opens at `/`, any other at `/?w=<name>`; every
link and form the server makes carries that on, so a page, its decisions and their writes stay
in the workspace they were opened in, and an action's result comes back to it. A name the store
doesn't hold is a "No workspace named …" page with the way home.

## Devtool hook

- `[data-home]` on the mark: the link home.
- `[data-workspaces]` on the switch (live page only); `[data-ws-menu]` holds its list, one `.ws-item` per workspace (`aria-current="page"` on the one you're in).
- `GET /api/workspaces` (read when the list opens): each workspace's name, where it opens, its tasks, the open ones and how many need you.
- `[data-no-workspace]` on the page for a name the store doesn't hold.

Assertion: a write made from a workspace's page lands in that workspace's stream and in no
other; the list's counts are the page's own (tasks as the Kanban counts them, needs-you as
Needs attention counts it).

**Falsifier.** A decision opened in one workspace writes to another, a link from a workspace's
page drops it (and lands in the first one), or a workspace with events in the store is missing
from the list.
