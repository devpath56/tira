// The ⌘K palette, loaded only by `tira serve` (the static page has no script at all).
// Find any task by a few letters and open its drawer, or type a verb first
// ("unblock col") to act on it: acting always goes through the confirm page, which
// shows what tira will do before anything is written. Ranking lives in rank.mjs,
// shared with the tests. Untrusted text is only ever set with textContent.
import { rank, parse } from "/rank.mjs";

const VERB_LABEL = { START: "Start", UNBLOCK: "Unblock", COMPLETE: "Complete", BLOCK: "Block" };

let tasks = [];
const load = () => fetch("/api/tasks").then((r) => r.json()).then((t) => { tasks = t; });

const root = document.createElement("div");
root.className = "palette";
root.id = "palette";
root.hidden = true;
root.innerHTML = '<div class="pal-box" role="dialog" aria-modal="true" aria-label="Find a task">'
  + '<input type="text" aria-label="Find a task" placeholder="Find a task, or start / unblock / complete / block + a task" autocomplete="off" spellcheck="false">'
  + '<ul class="pal-list" role="listbox" aria-label="Matches"></ul>'
  + '<div class="pal-hint">↵ open · a verb first to act · esc to close</div></div>';
document.body.append(root);
const input = root.querySelector("input");
const list = root.querySelector("ul");
let shown = [];
let verb;
let sel = 0;

function draw() {
  const t0 = performance.now();
  ({ verb, results: shown } = rank(input.value, tasks));
  sel = Math.min(sel, Math.max(0, shown.length - 1));
  list.replaceChildren(...shown.map((task, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === sel));
    li.dataset.paletteKey = task.key; // not data-key: that one marks each task once on the page (M1)
    const id = document.createElement("span"); id.className = "pid"; id.textContent = task.id;
    const path = document.createElement("span"); path.className = "ppath"; path.textContent = task.path;
    const what = document.createElement("span"); what.className = "pverb"; what.textContent = verb ? `${VERB_LABEL[verb]} →` : task.state.replace("_", " ");
    li.append(id, path, what);
    li.addEventListener("mousedown", (e) => { e.preventDefault(); sel = i; go(); });
    return li;
  }));
  if (shown.length === 0) {
    const li = document.createElement("li");
    li.textContent = parse(input.value).verb ? "No task in a state that allows that" : "No task matches";
    list.append(li);
  }
  root.dataset.ms = (performance.now() - t0).toFixed(1); // the brief's latency budget: under 100 ms
}

function go() {
  const task = shown[sel];
  if (!task) return;
  close();
  if (verb) location.href = `/confirm?type=${encodeURIComponent(task.type)}&id=${encodeURIComponent(task.id)}&event=${verb}`;
  else location.hash = `#${task.drawer}`;
}

function open() {
  root.hidden = false;
  input.value = "";
  sel = 0;
  draw();
  input.focus();
  load().then(draw); // fresh after any action
}
function close() { root.hidden = true; }

input.addEventListener("input", () => { sel = 0; draw(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
  else if (e.key === "Enter") { go(); e.preventDefault(); }
  else if (e.key === "Escape") { close(); e.preventDefault(); }
});
root.addEventListener("mousedown", (e) => { if (e.target === root) close(); });
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); root.hidden ? open() : close(); }
});
for (const b of document.querySelectorAll("[data-open-palette]")) b.addEventListener("click", open);
load();

// Onboarding, one time: the guide opens by itself on the first visit, then only on demand.
try {
  if (!localStorage.getItem("tira-guide-seen") && location.hash === "") location.hash = "#guide";
  localStorage.setItem("tira-guide-seen", "1");
} catch {
  // storage blocked: the guide stays on demand only
}
