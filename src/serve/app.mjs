// The ⌘K palette, loaded only by `tira serve` (the static page has no script at all).
// Find any task by a few letters and open its drawer, or type a verb first
// ("unblock col") to act on it: acting always goes through the confirm page, which
// shows what tira will do before anything is written. Ranking lives in rank.mjs,
// shared with the tests. Untrusted text is only ever set with textContent.
import { rank, parse } from "./rank.mjs";
import "./theme.mjs";
import "./graph.mjs";

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
  if (verb) void openConfirm(`/confirm?type=${encodeURIComponent(task.type)}&id=${encodeURIComponent(task.id)}&event=${verb}`);
  else location.hash = `#${task.drawer}`;
}

function open() {
  root.hidden = false;
  input.value = "";
  sel = 0;
  draw();
  input.focus();
  load().then(draw).catch(() => {}); // fresh after any action; if it fails, the list it has stays
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
load().catch(() => {}); // the first ⌘K loads it again

// Task dialogs open over the page with CSS alone (:target). Live, Esc closes the open one
// (unless the palette took that Esc), focus moves into a dialog when it opens, and back to
// whatever opened it when it closes.
let opener = null;
const openDialog = () => document.querySelector(".drawer:target");
document.addEventListener("click", (e) => {
  const link = e.target instanceof Element ? e.target.closest('a[href^="#t"], a[href="#guide"]') : null;
  if (link) opener = link;
});
window.addEventListener("hashchange", () => {
  const dialog = openDialog();
  if (dialog) dialog.querySelector(".close")?.focus();
  else if (opener) { opener.focus(); opener = null; }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.defaultPrevented && root.hidden && !confirmBox.open && openDialog()) { location.hash = "_"; e.preventDefault(); }
});

// Every action opens its decision in a dialog over the page, never a new page: the server
// sends just the packet (?fragment=1), parsed here without running anything in it. Left, what
// tira recommends; right, the command it will run, editable. Running it posts from here: a
// value missing, an edited-into-another action or a moved log comes back into the dialog;
// otherwise the page comes back with the result. Esc or a click outside closes it. If the
// packet can't be fetched, the confirm page opens instead.
const confirmBox = document.createElement("dialog");
confirmBox.className = "confirm-dialog";
confirmBox.setAttribute("aria-label", "Confirm the action");
document.body.append(confirmBox);
const packetOf = (html) => new DOMParser().parseFromString(html, "text/html").querySelector("[data-packet]");
function show(packet) {
  confirmBox.replaceChildren(document.importNode(packet, true));
  if (!confirmBox.open) confirmBox.showModal();
  const box = confirmBox.querySelector("textarea[data-command]");
  if (!box) return;
  const name = confirmBox.querySelector("[data-blocked-by] input"); // to block: what it waits on first
  if (name) return name.focus();
  box.focus();
  const at = box.value.indexOf('""'); // the first value to fill in
  const caret = at < 0 ? box.value.length : at + 1;
  box.setSelectionRange(caret, caret);
}
async function openConfirm(href) {
  try {
    const packet = packetOf(await (await fetch(`${href}&fragment=1`, { headers: { accept: "text/html" } })).text());
    if (!packet) throw new Error("no packet");
    show(packet);
  } catch {
    location.href = href;
  }
}
// key="value" in a command: replaced if it's there, else added
const BACKSLASH = "\\";
const quoted = (v) => '"' + v.replaceAll(BACKSLASH, BACKSLASH + BACKSLASH).replaceAll('"', BACKSLASH + '"') + '"';
function fill(box, key, value) {
  const re = new RegExp(String.raw`(^|\s)${key}=("(?:[^"\\]|\\.)*"|\S*)`);
  box.value = re.test(box.value) ? box.value.replace(re, (_m, pre) => `${pre}${key}=${quoted(value)}`) : `${box.value.trimEnd()} ${key}=${quoted(value)}`;
  box.focus();
}
// Blocking: name what it waits on, and the command becomes two lines (a new ticket under the
// task, found while working on it, then the block on it), or one line for an open task picked
// from the chips. A note you added is kept.
const bare = (s) => (/^[\w.:/@+-]+$/.test(s) ? s : quoted(s));
function composeBlock(name) {
  const holder = confirmBox.querySelector("[data-blocked-by]");
  const box = confirmBox.querySelector("textarea[data-command]");
  if (!holder || !box) return;
  const id = bare(holder.dataset.blockedBy ?? "");
  const type = bare(holder.dataset.type ?? "node");
  const open = [...confirmBox.querySelectorAll("[data-fill-blocker]")].map((b) => b.dataset.fillBlocker);
  const note = /(?:^|\s)note=("(?:[^"\\]|\\.)*"|\S*)/.exec(box.value)?.[1];
  const n = name.trim();
  const reason = n ? "waiting on " + n : "";
  const noted = note ? " note=" + note : "";
  const block = `tira send ${type} ${id} BLOCK blocker=${quoted(n)} reason=${quoted(reason)}` + noted;
  const ticket = `tira create ${type} ${n ? bare(n) : '""'} --parent ${id} kind=discovered discovered_during=${id}`;
  box.value = n !== "" && open.includes(n) ? block : `${ticket}\n${block}`;
}
confirmBox.addEventListener("input", (e) => {
  if (e.target instanceof HTMLInputElement && e.target.closest("[data-blocked-by]")) composeBlock(e.target.value);
});
confirmBox.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (e.target === confirmBox || el?.closest("[data-close-confirm]")) return confirmBox.close();
  const box = confirmBox.querySelector("textarea[data-command]");
  const pick = el?.closest("[data-fill-blocker]");
  if (pick) {
    const name = confirmBox.querySelector("[data-blocked-by] input");
    if (name) name.value = pick.dataset.fillBlocker ?? "";
    return composeBlock(pick.dataset.fillBlocker ?? "");
  }
  const chip = el?.closest("[data-fill], [data-fill-found]");
  if (!box || !chip) return;
  if (chip.dataset.fill) fill(box, chip.dataset.fill, chip.dataset.value ?? "");
  else { fill(box, "kind", "discovered"); fill(box, "discovered_during", chip.dataset.fillFound ?? ""); chip.remove(); }
});
confirmBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target instanceof HTMLTextAreaElement) {
    e.preventDefault();
    e.target.form?.requestSubmit();
  }
});
confirmBox.addEventListener("submit", async (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  e.preventDefault();
  const body = new URLSearchParams(new FormData(form));
  body.set("fragment", "1");
  try {
    const doc = new DOMParser().parseFromString(await (await fetch("/act", { method: "POST", body })).text(), "text/html");
    const go = doc.querySelector("[data-go]")?.dataset.go;
    const packet = doc.querySelector("[data-packet]");
    if (go) location.href = go;
    else if (packet) show(packet);
    else form.submit();
  } catch {
    form.submit(); // no answer: post it the plain way
  }
});
document.addEventListener("click", (e) => {
  const link = e.target instanceof Element ? e.target.closest('a.act[href^="/confirm"]') : null;
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // a new tab still opens the page
  e.preventDefault();
  void openConfirm(link.getAttribute("href")); // it handles its own failure (the confirm page)
});

// The board's style (Kanban or Graph) is CSS only, like the theme. Live, the choice is
// remembered per browser, so it survives the reload after every action.
const BOARD_KEY = "tira-board-style";
const styles = [...document.querySelectorAll('input[name="board-style"]')];
try {
  const pick = styles.find((r) => r.dataset.boardStyle === localStorage.getItem(BOARD_KEY));
  if (pick) pick.checked = true;
} catch {
  // storage blocked: the board opens as Kanban
}
for (const r of styles) {
  r.addEventListener("change", () => {
    try {
      localStorage.setItem(BOARD_KEY, r.dataset.boardStyle);
    } catch {
      // storage blocked: the choice lasts until the page is left
    }
  });
}

// Onboarding, one time: the guide opens by itself on the first visit, then only on demand.
try {
  if (!localStorage.getItem("tira-guide-seen") && location.hash === "") location.hash = "#guide";
  localStorage.setItem("tira-guide-seen", "1");
} catch {
  // storage blocked: the guide stays on demand only
}
