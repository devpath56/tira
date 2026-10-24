// The ⌘K palette, loaded only by `tira serve` (the static page has no script at all).
// Find any task by a few letters and open its drawer (on the Graph: move to it there), or
// type a verb first ("unblock col") to act on it: acting always goes through the confirm
// page, which shows what tira will do before anything is written. Opened empty, it offers
// what needs you first (next, in progress, blocked). Ranking lives in rank.mjs, shared with
// the tests. Untrusted text is only ever set with textContent.
import { rank, parse } from "./rank.mjs";
import "./theme.mjs";
import { graph } from "./graph.mjs";
import { fx, tint } from "./layout.mjs";
import { wireDrag } from "./drag.mjs";

const VERB_LABEL = { START: "Start", UNBLOCK: "Unblock", COMPLETE: "Complete", BLOCK: "Block" };

// The workspace this page shows (?w=…, none for the one the server started on): every request
// the script makes carries it on, as the server's own links do.
// The server writes it into the page (data-q: "w=<name>", already encoded); the script never reads
// it from the address bar, so nothing typed there reaches a request or the browser's storage.
const Q = document.querySelector("main")?.dataset.q ?? "";
const withW = (path) => (/^w=[\w.%!~*'()-]+$/.test(Q) ? `${path}${path.includes("?") ? "&" : "?"}${Q}` : path);
const STREAM = document.querySelector("main")?.dataset.stream ?? "";

let tasks = [];
const load = () => fetch(withW("/api/tasks")).then((r) => r.json()).then((t) => { tasks = t; });

const root = document.createElement("div");
root.className = "palette";
root.id = "palette";
root.hidden = true;
root.innerHTML = '<div class="pal-box" role="dialog" aria-modal="true" aria-label="Find a task">'
  + '<input type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" aria-label="Find a task" placeholder="Find a task, or start / unblock / complete / block + a task" autocomplete="off" spellcheck="false">'
  + '<ul class="pal-list" id="pal-list" role="listbox" aria-label="Matches"></ul>'
  + '<div class="pal-hint">↵ open (on the Graph: go to it) · a verb first to act · esc to close</div></div>';
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
    li.id = `pal-${i}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === sel));
    li.dataset.paletteKey = task.key; // not data-key: that one marks each task once on the page (M1)
    const id = document.createElement("span"); id.className = "pid"; id.textContent = task.id;
    const path = document.createElement("span"); path.className = "ppath"; path.textContent = task.path;
    const what = document.createElement("span"); what.className = "pverb"; what.textContent = verb ? `${VERB_LABEL[verb]} →` : task.next ? "◆ next" : task.state.replace("_", " ");
    li.append(id, path, what);
    li.addEventListener("mousedown", (e) => { e.preventDefault(); sel = i; go(); });
    return li;
  }));
  if (shown.length === 0) {
    const li = document.createElement("li");
    li.textContent = parse(input.value).verb ? "No task in a state that allows that" : "No task matches";
    list.append(li);
  }
  // a screen reader hears the highlighted match as the arrows move
  if (shown[sel]) input.setAttribute("aria-activedescendant", `pal-${sel}`);
  else input.removeAttribute("aria-activedescendant");
  list.children[sel]?.scrollIntoView({ block: "nearest" });
  root.dataset.ms = fx(performance.now() - t0); // the brief's latency budget: under 100 ms
}

function go() {
  const task = shown[sel];
  if (!task) return;
  close();
  if (verb) void openConfirm(withW(`/confirm?type=${encodeURIComponent(task.type)}&id=${encodeURIComponent(task.id)}&event=${verb}`));
  else if (!(graphShown() && graph.reveal(task.key))) location.hash = `#${task.drawer}`;
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
  const link = e.target instanceof Element ? e.target.closest('a[href^="#t"], a[href^="#i"], a[href="#guide"], a[href="#history"]') : null;
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
// sends just the packet (?fragment=1), parsed here without running anything in it. Left, the
// ticket (and tira's word when it would refuse); right, what the move needs and a comment.
// Running it posts from here: a value missing or a moved log comes back into the dialog;
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
  // the first thing to fill in: what the move needs, else the comment
  const first = confirmBox.querySelector("[data-field] input:not([type=hidden]), [data-comment-field] textarea");
  first?.focus();
}
// a decision's packet, just the packet (?fragment=1): null if the answer has none
const packetAt = async (href) => packetOf(await (await fetch(`${href}&fragment=1`, { headers: { accept: "text/html" } })).text());
async function openConfirm(href) {
  try {
    const packet = await packetAt(href);
    if (!packet) throw new Error("no packet");
    show(packet);
  } catch {
    location.href = href;
  }
}
confirmBox.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (e.target === confirmBox || el?.closest("[data-close-confirm]")) return confirmBox.close();
  // a chip fills its field: an open task to wait on, a reason used before, a proof, a parent
  const chip = el?.closest("[data-fill]");
  if (chip) {
    const field = confirmBox.querySelector(`[name="${chip.dataset.fill}"]`);
    if (field instanceof HTMLInputElement) {
      field.value = chip.dataset.value ?? "";
      field.focus();
    }
    return;
  }
  const found = el?.closest("[data-fill-found]"); // a subtask found while working on its parent
  const mark = confirmBox.querySelector('input[name="discovered"]');
  if (found && mark instanceof HTMLInputElement) {
    mark.value = "1";
    found.remove();
  }
});
confirmBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target instanceof HTMLTextAreaElement) {
    e.preventDefault();
    e.target.form?.requestSubmit();
  }
});
// A decision posted from here (the dialog's form, or a drop's Start): the page comes back with
// the result; a value missing, an edited-into-another action or a moved log comes back into the
// dialog. `fallback` when there's no answer to read.
async function post(action, body, fallback) {
  body.set("fragment", "1");
  try {
    const doc = new DOMParser().parseFromString(await (await fetch(action, { method: "POST", body })).text(), "text/html"); // /act, in this project
    const go = doc.querySelector("[data-go]")?.dataset.go;
    const packet = doc.querySelector("[data-packet]");
    if (go) location.href = go;
    else if (packet) show(packet);
    else fallback();
  } catch {
    fallback();
  }
}
confirmBox.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  e.preventDefault();
  void post(form.getAttribute("action") ?? "/act", new URLSearchParams(new FormData(form)), () => form.submit()); // no answer: post it the plain way
});

// A drop that runs at once (To do → In progress: Start) posts tira's own decision as it stands,
// with no dialog. If tira would refuse it (another task is in progress, say), the dialog opens to
// say why; if the decision can't be fetched, the confirm page does.
async function runNow(href) {
  try {
    const packet = await packetAt(href);
    const form = packet?.querySelector("form[data-you]");
    if (!packet || !form) throw new Error("no packet");
    if (packet.dataset.ok !== "true") return show(packet);
    const body = new URLSearchParams();
    for (const el of form.querySelectorAll("input[name], textarea[name]")) body.set(el.getAttribute("name") ?? "", el.value);
    await post(form.getAttribute("action") ?? "/act", body, () => show(packet));
  } catch {
    location.href = href;
  }
}
// Cards dragged between the Kanban's columns (drag.mjs): the move's verb, at once or in the dialog.
wireDrag((type, id, event, now) => {
  const href = withW(`/confirm?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}&event=${event}`);
  void (now ? runNow(href) : openConfirm(href));
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

// "Show on graph" in a dialog: close it, switch the board to the Graph, and move to the task
// there (its folds open, it is ringed and focused).
const boardShown = () => document.getElementById("v-board")?.checked === true;
const graphShown = () => boardShown() && document.getElementById("bv-graph")?.checked === true;
document.addEventListener("click", (e) => {
  const b = e.target instanceof Element ? e.target.closest("[data-show-on-graph]") : null;
  if (!b) return;
  const key = b.dataset.showOnGraph ?? "";
  opener = null; // focus goes to the task on the graph, not back to what opened the dialog
  location.hash = "_"; // the dialog closes
  const board = document.getElementById("v-board");
  if (board) board.checked = true;
  const pick = document.getElementById("bv-graph");
  if (pick && !pick.checked) { pick.checked = true; pick.dispatchEvent(new Event("change")); }
  document.querySelector(".view-board")?.scrollIntoView({ block: "start" });
  requestAnimationFrame(() => graph.reveal(key));
});

// Needs attention's folded groups: the ones you opened stay open across the reload after
// every action (per tab).
const OPEN_KEY = `tira-attention-open:${STREAM}`;
const groups = [...document.querySelectorAll("details.att-group[data-reason]")];
let openReasons = [];
try {
  openReasons = JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? "[]");
} catch {
  // storage blocked or garbled: every group starts folded
}
for (const g of groups) {
  if (openReasons.includes(g.dataset.reason)) g.open = true;
  g.addEventListener("toggle", () => {
    const open = groups.filter((x) => x.open).map((x) => x.dataset.reason);
    try {
      sessionStorage.setItem(OPEN_KEY, JSON.stringify(open));
    } catch {
      // storage blocked: it lasts until the page is left
    }
  });
}

// Projects, in the sidebar (a dropdown on a narrow screen): every project in the store, read from
// /api/workspaces when the list first shows (not on every action's reload of the server's page),
// each with its mark, what's open and how many need you; the one you're in is marked. Arrows move
// between them, Enter opens one. You (the profile) open a small menu the same way. A dropdown
// closes on Esc or a click outside; the sidebar's list stays as you left it.
const wide = () => globalThis.matchMedia?.("(min-width: 900px)").matches === true;
const switcher = document.querySelector("[data-workspaces]");
if (switcher) {
  const menu = switcher.querySelector("[data-ws-menu]");
  const note = (text) => { const p = document.createElement("p"); p.className = "ws-note"; p.textContent = text; return p; };
  const entry = (w) => {
    const a = document.createElement("a");
    a.className = "ws-item";
    a.href = w.href;
    a.dataset.stream = w.stream;
    if (w.current) a.setAttribute("aria-current", "page");
    const mark = document.createElement("span");
    mark.className = `pav t${tint(w.stream)}`;
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = ([...(w.title ?? w.stream)][0] ?? "?").toUpperCase();
    const t = document.createElement("span"); t.className = "ws-t";
    const name = document.createElement("b"); name.textContent = w.title ?? w.stream;
    const said = document.createElement("small");
    said.textContent = w.tasks === 0 ? "no tasks yet" : `${w.open} open of ${w.tasks}`;
    t.append(name, said);
    const n = document.createElement("span");
    n.className = w.attention > 0 ? "ws-n" : "ws-n calm";
    n.textContent = String(w.attention);
    n.title = `${w.attention} need${w.attention === 1 ? "s" : ""} you`;
    a.append(mark, t, n);
    return a;
  };
  let loaded = false;
  const fill = async () => {
    if (loaded) return;
    try {
      const list = await (await fetch(withW("/api/workspaces"))).json();
      const head = document.createElement("p"); head.className = "ws-head"; head.textContent = "Projects";
      menu.replaceChildren(head, ...list.map(entry), ...menu.querySelectorAll("[data-ws-extra]"));
      loaded = true;
    } catch {
      menu.append(note("Couldn't load the projects: try again."));
    }
  };
  if (!wide()) switcher.open = false; // a dropdown on a narrow screen: shut until asked
  if (switcher.open) void fill();
  const search = document.querySelector("[data-project-search]");
  switcher.addEventListener("toggle", async () => {
    if (!switcher.open) return;
    await fill();
    if (!wide() && document.activeElement !== search) (menu.querySelector('[aria-current="page"]') ?? menu.querySelector("a"))?.focus();
  });
  // Search projects (the sidebar's search): the list keeps the projects whose names hold what you
  // type; Enter opens the first, Esc clears it.
  if (search) {
    const apply = () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const a of menu.querySelectorAll("a.ws-item")) {
        a.hidden = q !== "" && !`${a.querySelector("b")?.textContent ?? ""} ${a.dataset.stream ?? ""}`.toLowerCase().includes(q); // its name, or the one it was made with
        if (!a.hidden) shown++;
      }
      menu.querySelector("[data-no-project]")?.remove();
      if (shown === 0 && q !== "") {
        const p = note(`No project named "${search.value.trim()}".`);
        p.dataset.noProject = "";
        menu.append(p);
      }
    };
    search.addEventListener("input", async () => {
      if (!switcher.open) switcher.open = true;
      await fill();
      apply();
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = [...menu.querySelectorAll("a.ws-item")].find((a) => !a.hidden);
        if (first) location.href = first.href;
        e.preventDefault();
      } else if (e.key === "Escape") {
        search.value = "";
        apply();
      } else if (e.key === "ArrowDown") {
        [...menu.querySelectorAll("a.ws-item")].find((a) => !a.hidden)?.focus();
        e.preventDefault();
      }
    });
  }
  switcher.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("a.ws-item")];
    const at = items.indexOf(document.activeElement);
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length > 0) {
      items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      e.preventDefault();
    }
  });
}
// dropdowns (the projects on a narrow screen, you): Esc or a click outside closes them
const dropdowns = () => [...document.querySelectorAll("details.ws[open]")].filter((d) => d.matches("[data-profile]") || !wide());
document.addEventListener("click", (e) => {
  for (const d of dropdowns()) if (e.target instanceof Node && !d.contains(e.target)) d.open = false;
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const d of dropdowns()) {
    if (!d.contains(document.activeElement)) continue;
    d.open = false;
    d.querySelector("summary")?.focus();
    e.preventDefault();
  }
});

// Onboarding, one time: the guide opens by itself on the first visit, then only on demand.
try {
  if (!localStorage.getItem("tira-guide-seen") && location.hash === "") location.hash = "#guide";
  localStorage.setItem("tira-guide-seen", "1");
} catch {
  // storage blocked: the guide stays on demand only
}

// Live: the page follows the log by itself. Every few seconds while it's in view it asks where the
// log is (/api/live); when anyone (a person or an agent) wrote since, it reloads in place, back
// where you were, and the cards that moved glow once. While you type or a dialog is open it waits,
// then shows them. The header's numbers count up once.
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const liveMain = document.querySelector("main[data-stream]");
const LIVE_KEY = `tira-live:${STREAM}`; // one per project, named by the page, not the address
let backFromLive = false;
let triedFor = 0; // the log position the last live reload was for: never reload twice for it
try {
  const was = JSON.parse(sessionStorage.getItem(LIVE_KEY) ?? "null");
  sessionStorage.removeItem(LIVE_KEY);
  if (was) {
    backFromLive = true;
    triedFor = Number(was.for ?? 0);
    scrollTo(0, was.y ?? 0);
    const cols = document.querySelector(".cols");
    if (cols) cols.scrollLeft = was.x ?? 0;
    for (const c of document.querySelectorAll(".card[data-card-key]")) {
      if (was.states?.[c.dataset.cardKey] !== c.dataset.state) c.classList.add("changed");
    }
  }
} catch {
  // storage blocked: the page just reloads
}
if (liveMain) {
  const seen = Number(liveMain.dataset.lastSeq ?? 0);
  let waiting = false;
  const busy = () => {
    const a = document.activeElement;
    return (a instanceof HTMLElement && a.matches("input, textarea, select, [contenteditable]"))
      || (location.hash.length > 1 && location.hash !== "#_")
      || !root.hidden
      || document.querySelector("dialog[open]") !== null;
  };
  let latest = 0;
  const reload = () => {
    const states = Object.fromEntries([...document.querySelectorAll(".card[data-card-key]")].map((c) => [c.dataset.cardKey, c.dataset.state]));
    try {
      sessionStorage.setItem(LIVE_KEY, JSON.stringify({ y: scrollY, x: document.querySelector(".cols")?.scrollLeft ?? 0, states, for: latest }));
    } catch {
      // storage blocked: it reloads at the top
    }
    location.reload();
  };
  const tick = async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const { seq } = await (await fetch(withW("/api/live"), { cache: "no-store" })).json();
      // only a log position counts: anything else in the answer is ignored, never kept
      const at = Number(seq);
      if (!Number.isSafeInteger(at) || at < 0) return;
      latest = at;
      if (at > seen && at > triedFor) {
        if (busy()) waiting = true;
        else reload();
      }
    } catch {
      // the server is away for a moment: ask again next time
    }
  };
  setInterval(tick, 5000);
  // waiting changes show as soon as you're done
  const later = () => setTimeout(() => {
    if (waiting && !busy()) reload();
  }, 300);
  addEventListener("hashchange", later);
  document.addEventListener("focusout", later);
}


// the header's numbers count up, once, on a fresh load (not after a live reload, not when the
// computer asks for less motion)
if (!calm && !backFromLive) {
  for (const el of document.querySelectorAll(".big, .stats b")) {
    const node = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && /^\d+$/.test(n.textContent ?? ""));
    const to = Number(node?.textContent ?? NaN);
    if (!node || !Number.isFinite(to) || to < 2) continue;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 700);
      node.textContent = String(Math.round(to * (1 - (1 - k) ** 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
