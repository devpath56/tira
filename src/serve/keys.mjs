// Superhuman actions (Isha, 2026-10-26, after the Superhuman email app): the board answers the
// keyboard. C creates a task; / searches (as ⌘K does); J and K move between tasks and Enter opens
// one; in an open task, S starts it, E completes it and B blocks it; G then S opens Project settings;
// ? lists them all. Never while typing in a field, nor with ⌘, Ctrl or Alt held (those are the
// browser's and the page's own).
const typing = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
const cards = () => [...document.querySelectorAll(".view-board a.card[data-card-key]")].filter((a) => a.offsetParent !== null);
const press = (selector, scope = document) => {
  const el = scope.querySelector(selector);
  if (!(el instanceof HTMLElement)) return false;
  el.click();
  return true;
};
const TASK_KEYS = { s: "START", e: "COMPLETE", b: "BLOCK" };
let waitingFor = "";
let timer = 0;

// ? is Shift and / on most keyboards; some report the / with Shift held instead
const keyOf = (e) => {
  if (e.key === "/" && e.shiftKey) return "?";
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
};
// J and K: the next or the one before, among the tasks on the board
const move = (key) => {
  const list = cards();
  if (list.length === 0) return false;
  const at = list.indexOf(document.activeElement);
  const step = key === "j" ? 1 : -1;
  const next = at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + step));
  list[next].focus();
  list[next].scrollIntoView({ block: "nearest" });
  return true;
};
// in an open task: its own moves, by the same links its buttons are
const inTask = (open, key) => {
  const act = /^t\d+$/.test(open.id) ? TASK_KEYS[key] : undefined;
  return act !== undefined && press(`[data-act="${act}"]`, open);
};
// on the board itself; true when the key did something
const onBoard = (key) => {
  if (key === "c" && document.getElementById("create")) {
    location.hash = "create";
    return true;
  }
  if (key === "/") return press("[data-open-palette]");
  if (key === "j" || key === "k") return move(key);
  if (key === "?") {
    location.hash = "keys";
    return true;
  }
  if (key === "g") {
    waitingFor = "g";
    clearTimeout(timer);
    timer = setTimeout(() => { waitingFor = ""; }, 1200);
  }
  return false;
};

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
  const key = keyOf(e);
  if (waitingFor === "g") {
    waitingFor = "";
    if (key === "s" && press("[data-project-settings]")) e.preventDefault();
    return;
  }
  const open = document.querySelector(".drawer:target");
  const done = open ? inTask(open, key) : onBoard(key);
  if (done) e.preventDefault();
});

// Create opens on its name, ready to type
window.addEventListener("hashchange", () => {
  if (location.hash === "#create") setTimeout(() => document.querySelector('#create input[name="name"]')?.focus(), 0);
});
if (location.hash === "#create") document.querySelector('#create input[name="name"]')?.focus();
