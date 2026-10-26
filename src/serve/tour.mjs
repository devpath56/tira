// The first-time tour on the board (onboarding.ts; Isha, 2026-10-26): five scenes, one at a time,
// with Back, Next and Skip, the arrow keys and Esc. It opens by itself once per person (the page
// says so: data-auto), and from the Take the tour button in Help. Closing it, either way, tells tira the person
// has seen it, on their account; finishing it (Get started) brings the checklist back if it was
// hidden, then the board's walkthrough (coach.mjs). Focus stays inside while it's open and goes back
// where it was after.
const tour = document.querySelector("[data-tour]");
if (tour instanceof HTMLElement) play(tour);

function play(tour) {
  const scenes = [...tour.querySelectorAll("[data-tour-scene]")];
  const dots = [...tour.querySelectorAll("[data-tour-dot]")];
  const back = tour.querySelector("[data-tour-back]");
  const next = tour.querySelector("[data-tour-next]");
  const token = tour.querySelector('input[name="token"]')?.value ?? "";
  let at = 0;
  let before = null;

  const show = (i) => {
    at = Math.max(0, Math.min(i, scenes.length - 1));
    scenes.forEach((s, k) => {
      s.hidden = k !== at;
      s.classList.toggle("on", k === at);
    });
    dots.forEach((d, k) => (k === at ? d.setAttribute("aria-current", "step") : d.removeAttribute("aria-current")));
    tour.setAttribute("aria-labelledby", `tour-t${at + 1}`);
    if (back) back.disabled = at === 0;
    if (next) next.textContent = at === scenes.length - 1 ? "Get started" : "Next";
  };

  const open = () => {
    if (location.hash === "#guide") location.hash = "_"; // from Help: Help closes, the tour opens
    before = document.activeElement;
    tour.hidden = false;
    document.documentElement.style.overflow = "hidden";
    show(0);
    next?.focus();
  };

  // seen, on the person's account (finished: the checklist comes back too)
  const tell = (finished) => {
    const body = new URLSearchParams({ token, do: finished ? "tour-finished" : "tour-seen", fragment: "1" });
    fetch(tour.dataset.action ?? "/onboarding", { method: "POST", body, keepalive: true }).catch(() => {});
  };

  const close = (finished) => {
    if (tour.hidden) return;
    tour.hidden = true;
    document.documentElement.style.overflow = "";
    tell(finished);
    if (before instanceof HTMLElement) before.focus();
    if (!finished) return;
    // Get started: the walkthrough of the real board follows (coach.mjs), after the page comes back
    // when the checklist was hidden and shows it again
    if (document.querySelector("[data-get-started]")) return void dispatchEvent(new Event("tira:coach"));
    try { sessionStorage.setItem("tira-coach", "1"); } catch { /* no storage: no walkthrough after the reload */ }
    location.reload();
  };

  back?.addEventListener("click", () => show(at - 1));
  next?.addEventListener("click", () => (at === scenes.length - 1 ? close(true) : show(at + 1)));
  for (const s of tour.querySelectorAll("[data-tour-skip]")) s.addEventListener("click", () => close(false));
  tour.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(false); }
    else if (e.key === "ArrowRight") { e.preventDefault(); if (at < scenes.length - 1) show(at + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); show(at - 1); }
    else if (e.key === "Tab") keepFocus(e);
  });
  // Tab goes round the tour's own buttons while it's open
  const keepFocus = (e) => {
    const stops = [...tour.querySelectorAll("button:not([disabled])")].filter((b) => b.offsetParent !== null);
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  for (const a of document.querySelectorAll("[data-tour-open]")) {
    a.addEventListener("click", (e) => { e.preventDefault(); open(); });
  }
  // by itself, once: not over a task someone was sent to (an address with #…)
  if (tour.dataset.auto === "1" && location.hash === "") open();
}
