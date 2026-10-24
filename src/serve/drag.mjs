// Drag a card to another column on the Kanban, as in Todoist. The drop means the verb today's
// rules give that move (the server writes them on the board: data-moves). To do → In progress
// starts the task at once; every other move opens its decision in the dialog, as the card's own
// buttons do (In progress → Done asks for the proof of work). A move the rules don't allow isn't
// offered: those columns dim while you drag, and the card goes back. A mouse drags once it moves
// a few pixels; a finger holds the card a moment first, so a swipe still scrolls. Esc cancels.
// The keyboard acts from the task's dialog or ⌘K, as before. Loaded by app.mjs, under `tira serve`.

// Verbs a drop runs without a dialog: they take no value and are what the drag plainly says.
export const RUNS_AT_ONCE = new Set(["START"]);

// The verb for moving a card (its key, "node:colors") from one column's state to another's, or
// undefined when the rules give that move none.
export function moveFor(moves, key, from, to) {
  const type = key.slice(0, key.indexOf(":"));
  if (type === "" || from === to) return undefined;
  const move = `${type}:${from}>${to}`;
  return Object.hasOwn(moves, move) ? moves[move] : undefined;
}

const MOUSE_SLOP = 5; // px a mouse moves before it's a drag, not a click
const HOLD_MS = 300; // a finger holds this long to pick a card up
const EDGE = 48; // px from the board's sides where it scrolls along

// act(type, id, event, now): a drop's verb; `now` when it runs without a dialog (RUNS_AT_ONCE)
export function wireDrag(act) {
  const board = document.querySelector(".cols[data-moves]");
  if (!board) return;
  let moves;
  try {
    moves = JSON.parse(board.dataset.moves ?? "{}");
  } catch {
    return; // unreadable: the board stays as it was, its buttons still work
  }
  const cols = [...board.querySelectorAll(".col[data-col]")];
  let pick = null; // { card, from, key, x, y, id, timer, ghost, dx, dy, over }
  let dragged = false; // swallow the click a drop ends with, so the card's dialog doesn't open

  const colAt = (x, y) => document.elementFromPoint(x, y)?.closest(".col[data-col]") ?? null;
  const moveTo = (col) => (col ? moveFor(moves, pick.key, pick.from, col.dataset.col) : undefined);
  // while a card drags, each column says what a drop there would do: nothing (its own), a move, or none
  const dropOf = (col) => {
    if (col.dataset.col === pick.from) return "home";
    return moveTo(col) ? "ok" : "no";
  };

  function lift() {
    const { card } = pick;
    const box = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.removeAttribute("href");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.width = `${box.width}px`;
    document.body.append(ghost);
    Object.assign(pick, { ghost, dx: pick.x - box.left, dy: pick.y - box.top });
    card.classList.add("drag-src");
    document.documentElement.dataset.dragging = "";
    for (const col of cols) col.dataset.drop = dropOf(col);
  }

  function follow(x, y) {
    pick.ghost.style.transform = `translate(${x - pick.dx}px, ${y - pick.dy}px)`;
    const col = colAt(x, y);
    if (col !== pick.over) {
      pick.over?.classList.remove("drop-over");
      if (col?.dataset.drop === "ok") col.classList.add("drop-over");
      pick.over = col;
    }
    const side = board.getBoundingClientRect();
    if (x < side.left + EDGE) board.scrollLeft -= 12;
    else if (x > side.right - EDGE) board.scrollLeft += 12;
  }

  function drop(x, y) {
    const event = moveTo(colAt(x, y));
    const key = pick.key;
    end();
    if (!event) return; // not a move the rules allow: the card stays where it was
    const id = key.slice(key.indexOf(":") + 1);
    act(key.slice(0, key.indexOf(":")), id, event, RUNS_AT_ONCE.has(event));
  }

  function end() {
    if (!pick) return;
    clearTimeout(pick.timer);
    if (pick.ghost) {
      pick.ghost.remove();
      pick.card.classList.remove("drag-src");
      dragged = true;
      setTimeout(() => { dragged = false; }, 0); // the click comes first, if there is one
    }
    for (const col of cols) {
      delete col.dataset.drop;
      col.classList.remove("drop-over");
    }
    delete document.documentElement.dataset.dragging;
    pick = null;
  }

  board.addEventListener("pointerdown", (e) => {
    const card = e.target instanceof Element ? e.target.closest(".card[data-card-key]") : null;
    const from = card?.closest(".col[data-col]")?.dataset.col;
    if (!card || !from || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || pick) return;
    pick = { card, from, key: card.dataset.cardKey ?? "", x: e.clientX, y: e.clientY, id: e.pointerId, timer: 0, ghost: null, dx: 0, dy: 0, over: null };
    if (e.pointerType === "touch") pick.timer = setTimeout(() => { if (pick && !pick.ghost) lift(); }, HOLD_MS);
  });
  document.addEventListener("pointermove", (e) => {
    if (pick?.id !== e.pointerId) return;
    if (!pick.ghost) {
      const far = Math.hypot(e.clientX - pick.x, e.clientY - pick.y) > MOUSE_SLOP;
      if (!far) return;
      if (e.pointerType === "touch") return end(); // moved before the hold: a scroll
      lift();
    }
    follow(e.clientX, e.clientY);
  });
  document.addEventListener("pointerup", (e) => {
    if (pick?.id !== e.pointerId) return;
    if (pick.ghost) drop(e.clientX, e.clientY);
    else end(); // a plain click: the card's dialog opens as always
  });
  document.addEventListener("pointercancel", end);
  window.addEventListener("blur", end);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pick?.ghost) { e.preventDefault(); end(); }
  });
  // while a finger drags, the page doesn't scroll under it
  document.addEventListener("touchmove", (e) => { if (pick?.ghost) e.preventDefault(); }, { passive: false });
  // a link's own drag (its address) would take over from ours
  board.addEventListener("dragstart", (e) => { if (e.target instanceof Element && e.target.closest(".card[data-card-key]")) e.preventDefault(); });
  board.addEventListener("click", (e) => { if (dragged) { e.preventDefault(); e.stopPropagation(); } }, true);
  // a held finger brings up the browser's menu for a link: not while picking a card up
  board.addEventListener("contextmenu", (e) => { if (pick) e.preventDefault(); });
}
