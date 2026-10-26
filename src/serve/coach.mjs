// The board's walkthrough (Isha, 2026-10-26): when the tour ends with Get started, tooltips point at
// the real board, one at a time, each with the key that does it faster (keys.mjs): Create, Kanban or
// Graph, Search, Needs you, Project settings. Back, Next and Skip, the arrow keys and Esc; a step whose
// part isn't on the page is left out. Help's Show me around plays it again.
const STEPS = [
  ["[data-create-open]", "Create a task", "Name it, and put it under another task if it belongs there. It lands in To do, and your agents see it in what's next.", ["C"]],
  [".board-bar .seg", "Kanban or Graph", "The same tasks as columns, or as the tree they make, with what waits on what.", []],
  ["[data-open-palette]", "Find anything", "Any task or project: type a few letters, and Enter opens it.", ["/"]],
  [".attention", "Needs you", "Only what's waiting on a person. Agents work the rest, and tira closes a parent by itself once its subtasks are done.", ["J", "K"]],
  ["[data-project-settings]", "Project settings", "Connect Claude Code, add collaborators, and link GitHub and Jira.", ["G", "S"]],
];
let steps = [];
let at = 0;
let spot = null;
let box = null;

const shown = (el) => el instanceof HTMLElement && el.getClientRects().length > 0;
// the tooltip is built from nodes, never markup (the page's scripts never build markup)
const node = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const keysLine = (lead, keys, after = "") => {
  const p = node("p", "coach-key", lead);
  keys.forEach((k, i) => {
    if (i > 0) p.append(" then ");
    p.append(node("kbd", "", k));
  });
  if (after) p.append(after);
  return p;
};
const button = (label, className, data) => {
  const b = node("button", className, label);
  b.type = "button";
  b.setAttribute(data, "");
  return b;
};

const place = () => {
  const [selector, title, text, keys] = steps[at];
  const el = document.querySelector(selector);
  if (!spot || !box || !shown(el)) return;
  const r = el.getBoundingClientRect();
  Object.assign(spot.style, { top: `${r.top - 6}px`, left: `${r.left - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
  const last = at === steps.length - 1;
  const acts = node("div", "coach-acts");
  acts.append(button("Skip", "how", "data-coach-skip"), node("span"));
  if (at > 0) acts.append(button("Back", "act", "data-coach-back"));
  acts.append(button(last ? "Done" : "Next", "act primary", "data-coach-next"));
  box.replaceChildren(
    node("p", "coach-n", `${at + 1} of ${steps.length}`), node("h3", "", title), node("p", "", text),
    ...(keys.length > 0 ? [keysLine("Superhuman: press ", keys)] : []),
    ...(last ? [keysLine("Press ", ["?"], " for every shortcut.")] : []),
    acts,
  );
  const b = box.getBoundingClientRect();
  const below = r.bottom + 14 + b.height < innerHeight;
  const top = below ? r.bottom + 14 : Math.max(12, r.top - 14 - b.height);
  const left = Math.min(Math.max(12, r.left), innerWidth - b.width - 12);
  Object.assign(box.style, { top: `${top}px`, left: `${left}px` });
  box.dataset.side = below ? "below" : "above";
  box.querySelector("[data-coach-next]")?.focus();
};

const end = () => {
  spot?.remove();
  box?.remove();
  spot = box = null;
  removeEventListener("resize", place);
  removeEventListener("scroll", place, true);
};
const stepTo = (i) => {
  if (i < 0) return;
  if (i >= steps.length) return end();
  at = i;
  document.querySelector(steps[at][0])?.scrollIntoView({ block: "nearest" });
  place();
};
const start = () => {
  end();
  steps = STEPS.filter(([selector]) => shown(document.querySelector(selector)));
  if (steps.length === 0) return;
  spot = document.createElement("div");
  spot.className = "coach-spot";
  spot.setAttribute("aria-hidden", "true");
  box = document.createElement("div");
  box.className = "coach";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Walkthrough");
  box.dataset.coach = "";
  box.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest("[data-coach-next]")) stepTo(at + 1);
    else if (t?.closest("[data-coach-back]")) stepTo(at - 1);
    else if (t?.closest("[data-coach-skip]")) end();
  });
  document.body.append(spot, box);
  addEventListener("resize", place);
  addEventListener("scroll", place, true);
  stepTo(0);
};

// first, so the board's own keys don't also act while it's open
document.addEventListener("keydown", (e) => {
  if (!box) return;
  if (e.key === "Escape") { e.preventDefault(); end(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); stepTo(at + 1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); stepTo(at - 1); }
}, true);
for (const b of document.querySelectorAll("[data-coach-open]")) {
  b.addEventListener("click", () => {
    if (location.hash === "#guide") location.hash = "_"; // from Help: Help closes, the walkthrough starts
    setTimeout(start, 50);
  });
}
addEventListener("tira:coach", () => setTimeout(start, 50));
// the tour ended and the page came back (to show the checklist again): now the walkthrough
let after = null;
try { after = sessionStorage.getItem("tira-coach"); sessionStorage.removeItem("tira-coach"); } catch { /* no storage: no walkthrough after a reload */ }
if (after === "1") setTimeout(start, 300);
