// A field with a list to pick from (Isha, 2026-10-26: the Block dialog's "Blocked by", a dropdown
// rather than a wall of chips): the list opens as the field is used, narrows to what's typed, and
// says nothing when nothing matches (what's typed is then a new ticket's name). Arrows move, Enter
// picks, Esc closes the list (not the dialog); a click picks too (app.mjs fills the field, as it did
// for the chips). The dialogs come in later, so this listens on the page.
const listOf = (input) => document.getElementById(input.getAttribute("aria-controls") ?? "");
const comboInput = (el) => (el instanceof HTMLInputElement && el.closest("[data-combo]") ? el : null);
const visible = (list) => [...list.querySelectorAll(".combo-opt")].filter((o) => !o.hidden);

const close = (input) => {
  const list = listOf(input);
  if (list) list.hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
};
const open = (input) => {
  const list = listOf(input);
  if (!list) return;
  const q = input.value.trim().toLowerCase();
  let shown = 0;
  for (const o of list.querySelectorAll(".combo-opt")) {
    const hit = q === "" || (o.dataset.value ?? "").toLowerCase().includes(q);
    o.hidden = !hit;
    o.removeAttribute("aria-selected");
    if (hit) shown += 1;
  }
  list.hidden = shown === 0;
  input.setAttribute("aria-expanded", String(shown > 0));
};
const mark = (input, opts, i) => {
  opts.forEach((o, k) => (k === i ? o.setAttribute("aria-selected", "true") : o.removeAttribute("aria-selected")));
  const o = opts[i];
  if (!o) return;
  input.setAttribute("aria-activedescendant", o.id);
  o.scrollIntoView({ block: "nearest" });
};

document.addEventListener("focusin", (e) => {
  const input = comboInput(e.target);
  if (input) open(input);
});
document.addEventListener("input", (e) => {
  const input = comboInput(e.target);
  if (input) open(input);
});
document.addEventListener("focusout", (e) => {
  const input = comboInput(e.target);
  if (input) setTimeout(() => close(input), 120); // after a click on the list has picked
});
document.addEventListener("keydown", (e) => {
  const input = comboInput(e.target);
  const list = input ? listOf(input) : null;
  if (!input || !list) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (list.hidden) open(input);
    const opts = visible(list);
    const at = opts.findIndex((o) => o.getAttribute("aria-selected") === "true");
    const next = e.key === "ArrowDown" ? Math.min(opts.length - 1, at + 1) : Math.max(0, at - 1);
    mark(input, opts, next);
  } else if (e.key === "Enter" && !list.hidden) {
    const picked = visible(list).find((o) => o.getAttribute("aria-selected") === "true");
    if (!picked) return; // nothing picked: Enter sends the form, with a new ticket's name
    e.preventDefault();
    input.value = picked.dataset.value ?? "";
    close(input);
  } else if (e.key === "Escape" && !list.hidden) {
    e.preventDefault();
    e.stopPropagation();
    close(input);
  }
}, true);
// a click picks (app.mjs fills the field); the list then closes, and the field keeps its focus
document.addEventListener("mousedown", (e) => {
  if (e.target instanceof Element && e.target.closest(".combo-opt")) e.preventDefault();
});
document.addEventListener("click", (e) => {
  const o = e.target instanceof Element ? e.target.closest(".combo-opt") : null;
  const input = o?.closest("[data-combo]")?.querySelector("input");
  if (input instanceof HTMLInputElement) close(input);
});
