# First-time welcome: the tour, Get started, and Help (onboarding)

**JTBD:** 1 — Track a branching build depth-first (first-run).

**What / why.** A first-time person's welcome on the board (Isha, 2026-10-26), after Jira's quick
start and the short animated tours of Linear and Notion, instead of a page of text:
- **The tour** (`src/serve/onboarding.ts`, played by `tour.mjs`): five scenes, one at a time, each a
  small moving picture made of tira's own cards. Welcome (a tree of tasks grows); the board and the
  whole tree (a card crosses the Kanban; ⌘K finds it); done means proven (a pull request proves a
  task, and tira closes the parent with its bolt); agents work beside you (an agent takes a task
  under its own name; its idea waits for Approve); bring your team (a teammate joins; GitHub and
  Jira sync). Back, Next, Skip; the arrow keys and Esc; focus stays inside and goes back after. It
  opens by itself once per person, remembered on their account (not the browser), and again from
  the **Take the tour** button in Help, as help menus have it. Under Reduce Motion each scene
  stands still, fully drawn.
- **Get started**, in the sidebar (its own row under the top bar on a narrow screen): five steps
  that tick themselves off from what the project has (its repo linked, a first task, an agent
  connected, a teammate, a task finished with proof), each linking to where it's done, with how
  many are done. **×** hides it, for that person; finishing the tour brings it back.
- **Help** opens on demand only, from Help (a ? at the foot of the sidebar). It no longer opens by
  itself. Written as Jira writes its help (Isha,
  2026-10-26): to you, plainly, what each thing is in a line and how to do something as "To …, …".
  A line on what the board is; **Find your way** (Kanban, with how to move a task; Graph; Search,
  ⌘K; Task details, select a task); **What the marks mean** (◆ Next, Need you, ⚡ Closed by tira,
  IDEA); and, under `tira serve`, **Take the tour**, kept in view at the foot of the dialog. The
  fingerprint isn't in Help: it's for checking, not for doing the work, so it stays on History's
  chip (`hash-chip.md`).

With no sign-in (`tira serve --actor`), there's one person and no welcome.

**How to read it.** The tour's dots say which scene of five; Next becomes Get started on the last.
The checklist's bar fills as steps are done; a done step is struck through.

## Devtool hook

- `[data-tour]` on the tour (`[data-auto]` on it while it opens by itself), `[data-tour-scene]` on each of its five scenes, `[data-tour-dot]` on each dot, `[data-tour-next]`, `[data-tour-back]` and `[data-tour-skip]` on its buttons; `[data-tour-open]` on Help's Take the tour.
- `[data-get-started]` on the checklist; `[data-hide-checklist]` on its ×.
- `[data-guide]` on the guide, with id `#guide`; `.help` on Help.

Assertion: the tour opens by itself once per person and never again, on any browser; the checklist
ticks a linked repo; hiding it holds, and finishing the tour brings it back (`test/sync.test.ts`);
Help has its two groups of rows and nothing about the fingerprint (`test/render.test.ts`).

**Falsifier.** A first-time person can't say what the board, proof, agents and the team are for
after the tour, or the tour comes back after they closed it, or Help can't be read at a glance.
