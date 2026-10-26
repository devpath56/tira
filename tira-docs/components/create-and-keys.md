# Create, superhuman keys, and the walkthrough

**JTBD:** 1 — Track a branching build depth-first.

**What / why.** A person makes a task from the board itself (Isha, 2026-10-26), not only an agent
or `tira create`. Every move on the board has a key, after the Superhuman email app, so it never
needs the mouse. And when the first-time tour ends, a walkthrough points at the real board,
bragging the keys as it goes.

**How to read it.**
- **+ Create** beside History (with its key, C): a composer, after Linear's New issue (Isha,
  2026-10-26: "modern, impressive and elegant"). On top the project and "New task"; the task's
  name large; a description under it; then its properties as pills: To do (where every task
  starts), Assignee (people, then agents), Estimate (30m to 1w) and Parent (only when it belongs
  under an open task; nothing to read first). Each pill opens a menu of its own (as Linear's, not the
  browser's): "No assignee" and the like first, a tick on what's picked, arrows, Enter and Esc; the
  pill shows its name until something's picked, and never offers its name as a choice. **Keep open for the next one** keeps it open for the next one (Linear's Create more, Jira's Create another),
  with the same assignee, estimate and parent; **Create task** (⌘↵) writes the task and, with
  any property or description given, its ticket, checked first so nothing is half made. What
  tira can't take (a name taken, an estimate it can't read) says so in the composer, which keeps
  what was typed (`create.mjs`). An empty board points at it too, and so does Get started's
  first-task step.
- **The open ticket**, in the same style: a header bar with where it sits, then its work (the title
  large, the description and steps without boxes, subtasks, comments with the button inside the
  box, history) beside a tinted sidebar of properties as rows of label and value, the status with
  what it allows, and the assignee and estimate as pills.
- **Keys** (`keys.mjs`): C creates; / searches (as ⌘K); J and K move between tasks and Enter
  opens one; in an open task S starts it, E completes it (with proof) and B blocks it, by the same
  buttons the task has; G then S opens Project settings; ? lists them all (Help → Keyboard
  shortcuts too). Never while typing in a field, nor with ⌘, Ctrl or Alt held.
- **The walkthrough** (`coach.mjs`): after the tour's Get started, five tooltips, one at a time,
  each with a spotlight on the part it's about: Create a task (C), Kanban or Graph, Find anything
  (/), Needs you (J, K), Project settings (G then S; ? for every key). Back, Next, Skip, the arrow
  keys and Esc; a part that isn't on the page is left out. Help → Show me around plays it again.

## Devtool hook

- `[data-create-open]` on + Create, `#create` (`[data-create]`) on its dialog, `[data-create-form]` on its form (POST `/tasks`), `.prop-pill` on each property, `[data-create-said]` on what it says.
- `#keys` (`[data-keys]`) on the shortcuts; `kbd` on each key.
- `.coach` on a walkthrough tooltip, `.coach-spot` on its spotlight; `[data-coach-open]` on Help's Show me around.

Assertion: Create makes a task at the top or under an open one, and refuses a name taken or a
task that isn't here (`test/sync.test.ts`).

**Falsifier.** A key acts while someone types, or Create writes a task as someone other than the
person signed in.
