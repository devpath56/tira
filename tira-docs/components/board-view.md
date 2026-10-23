# Board (Kanban and Graph)

**JTBD:** 1 — Track a branching build depth-first.

**What / why.** One view of the work in two styles, switched in the board's own bar, so
"how much is done, and what's left" is one glance in whichever shape reads best. Kanban
puts each task in its status column; Graph shows the whole tree, so where a task sits (and
what a parent is waiting on) is visible too. Kanban by default; under `tira serve` the
choice is remembered per browser, so it survives the reload after every action.

**How to read it.** Kanban: columns To do, In progress, Blocked (only when something is),
Done and Dropped, always in one row (wider than the page, the row scrolls sideways; on a phone
you swipe one column at a time); every ticket is a card, naming its parent, and ◆ marks the
next task. A card's title wraps after an underscore, never inside a word. Done and Dropped only
grow, so they show their newest 8 cards (the last to close first) and keep the rest behind
"Show N more" (it opens with no script); opened, "Show fewer" sits after the older cards, at the
foot of the column. To do, In progress and Blocked show every card. Each card shows who moved it
last: a person's initial, or an agent's spark on a gradient (an AI coding agent, a factory
session, tira itself, the sync: told by the names agents run under). A card in progress has a
slowly turning edge: someone, often an agent, is on it now.

**Live (tira serve).** The board follows the log by itself: every few seconds it asks where the
log is, and when anyone, a person or an agent, wrote since, it reloads in place (where you were
scrolled) and the cards that moved glow once. While you're typing or a dialog is open it waits,
then shows them. The header's numbers count up once on a fresh load; with less motion asked for,
none of this moves.

**Drag a card (tira serve).** As in Todoist, a Kanban card drags to another column, and the drop
means the move's verb under today's rules. To do → In progress starts the task at once; every
other move opens its decision in the dialog, as the card's buttons do: In progress → Done asks
for the proof of work, Blocked asks what it waits on, Dropped and back to In progress ask too.
While you drag, the columns it can go to are outlined and the rest dim; dropped on one of those,
or with Esc, the card goes back and nothing is written. If tira would refuse a start (another
task is already in progress), the dialog opens to say why. A mouse drags once it moves a few
pixels, so a click still opens the card; a finger holds the card a moment first, so a swipe
still scrolls. The keyboard acts from the task's dialog or ⌘K.

**Big trees (100+ tasks).** The layout packs a short branch beside a deep one's lower rows.
In a tree of more than 40 shown tasks, the lowest branches hang as indented columns under
their parent (a bracket joins each task; steps indent under their task), so the tree grows
down instead of across: 212 tasks fit in about 4,800 × 1,000 px instead of 20,000 px wide.

**Live canvas (`tira serve`).** The graph moves like Figma or Excalidraw:

| Do | How |
|---|---|
| Pan | Drag anywhere (a click on a task still opens it), scroll or swipe, arrow keys |
| Zoom | Pinch, or ⌘/Ctrl + scroll, around the pointer; − / + / the % button (life size); + − 0 keys |
| See it all | Fit (or the 1 key); ◆ Next centres the next task and opens any fold hiding it |
| Full screen | The corner button; Esc leaves (after closing any open dialog). The result of an action shows on the canvas |
| Fold | The button under a parent hides its whole branch and shows "+N" (red when a blocked task is inside, ringed when the next one is); the parent stays where it was on screen |
| Tidy up | Collapse done folds every finished branch (the outermost); Expand all opens everything; Found links hides the dotted lines |
| Zoomed out | Below 50% each task becomes a tile in its state's colour (blocked red, in progress blue, done green, the next one ringed) and each branch gets a label at a readable size, shown only where it has room (from 22%, every level) |
| Minimap | The whole tree in the corner, with the part on screen outlined; click or drag on it to move there |
| Find | ⌘K, or "Show on graph" in a task's dialog: the folds above it open, the view glides to it, and it is ringed and focused |
| Motion | Fit, Next, the zoom buttons and Find glide there (eased like GSAP's power3.out); folding or opening a branch moves the boxes to their new places. Reduced motion: no glides, no moving boxes |
| After an action | The task it changed (and a block's new ticket) glows once on its card and its box; if it is out of sight or folded away, the view glides to it |

Folds are remembered per browser and stream, the view and full screen per tab, so all of
it survives the reload after every action. A rendered file has no script: the graph shows
every task and scrolls.

## Devtool hook

- `#bv-kanban` and `#bv-graph`, the two radio inputs, each with `[data-board-style]`; `.board-bar` holds the switch (`.seg`) and the graph's `.legend`.
- `.bv-kanban` and `.bv-graph` hold the two styles; `.graph` holds the nodes (`.gn`) over the lines (`.edges`).
- `[data-key]` on each task's graph node, exactly once, with `[data-state]`, `[data-cursor]`, `[data-active]` and `[data-drained]`.
- `[data-from]` and `[data-to]` on each line (parent and child), `[data-found]` on each found-while line, `[data-blocks]` on each blocks arc and on a Kanban card's "blocks" chip; `[data-parent]` on each node with a parent.
- `[data-graph]` on the box the live page turns into a canvas; `.canvas-tools` (`[data-canvas-tools]`) holds its tools; `.fold` with `[data-fold]` (the parent's key) under each parent; `.canvas-flash` repeats an action's result in full screen.
- `.more` (`[data-more]`: how many it holds) on the older Done or Dropped cards; `.more-btn` on its Show more / Show fewer, after them.
- `[data-card-key]` (the task's key) and `[data-state]` on each Kanban card, which the live page compares across a reload; `.mover` on the card's who-moved-it (`.mover.agent` for an agent).
- Live only: `[data-moves]` on the Kanban's `.cols` (what each move means, from the rules), `[data-col]` on each status column (its state); while a card drags, `[data-drop]` on each column (home, ok or no) and `[data-dragging]` on the page.
- `.minimap` (`[data-minimap]`) on the canvas's map; `.branch-label` on each branch's zoomed-out label (below 50% the canvas carries the class far).
- `.changed` on the card and node (and the needs-attention row) the last action wrote to, live only.
- `[data-node-count]` and `[data-fold-tree-count]` on the page: they must be equal.

Assertion: every fold node appears once with the fold's flags (manual test M1); a parent
sits one row above its children, centred over them; no two nodes overlap, folded or not, at
any size (`test/layout.test.ts`: random trees up to 250 tasks).

**Falsifier.** A task on the board disagrees with `tira dump`, or a node sits under the
wrong parent.
