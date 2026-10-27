// Claude's Connectors steps, played (Isha, 2026-10-26): each step's small moving picture in turn,
// round again every few seconds, the step it is lit and a bar filling under the picture. A step
// clicked shows its own and the play goes on from there; hovering holds it. Under Reduce Motion it
// doesn't move by itself (a step clicked still shows its picture). A player drawn in later, when a
// step changes in place (agents.mjs), starts too.
const EVERY = 3400;
const still = matchMedia("(prefers-reduced-motion: reduce)");

const start = (root) => {
  if (root.dataset.ready) return;
  root.dataset.ready = "1";
  const steps = [...root.querySelectorAll("[data-cplay-go]")];
  const scenes = [...root.querySelectorAll("[data-cplay-scene]")];
  let at = 0;
  let timer = 0;
  let held = false;
  // a scene's own moves start over each time it's shown: taken off, then put back two frames on
  const show = (i) => {
    at = (i + scenes.length) % scenes.length;
    scenes.forEach((s) => s.classList.remove("on"));
    steps.forEach((b, k) => {
      b.classList.toggle("on", k === at);
      if (k === at) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
    root.classList.remove("ticking");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      scenes[at]?.classList.add("on");
      if (!held && !still.matches) root.classList.add("ticking");
    }));
  };
  const tick = () => {
    clearTimeout(timer);
    if (!root.isConnected || held || still.matches) return;
    timer = setTimeout(() => {
      show(at + 1);
      tick();
    }, EVERY);
  };
  steps.forEach((b, k) => b.addEventListener("click", () => { show(k); tick(); }));
  root.addEventListener("mouseenter", () => { held = true; root.classList.remove("ticking"); clearTimeout(timer); });
  root.addEventListener("mouseleave", () => { held = false; show(at); tick(); });
  // a play folded away (Set it up) starts from its first step when it's opened
  root.closest("details")?.addEventListener("toggle", (e) => {
    if (!(e.target instanceof HTMLDetailsElement) || !e.target.open) return;
    show(0);
    tick();
  });
  show(0);
  tick();
};

const all = () => document.querySelectorAll("[data-cplay]").forEach(start);
all();
addEventListener("tira:swapped", all);
