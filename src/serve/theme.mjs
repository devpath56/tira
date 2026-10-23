// The theme (System / Light / Dark) is CSS only: radio inputs every page carries, picked in
// Account settings' Appearance (the rendered file keeps its own switch). Under `tira serve` this
// remembers the choice per browser, so it survives reloads and carries to every page. Loaded by
// each served page directly and by app.mjs on the live page.
const KEY = "tira-theme";
const radios = [...document.querySelectorAll('input[name="theme"]')];

try {
  const saved = localStorage.getItem(KEY);
  const pick = radios.find((r) => r.dataset.themeChoice === saved);
  if (pick) pick.checked = true;
} catch {
  // storage blocked: the page follows the system until a choice is made
}

for (const r of radios) {
  r.addEventListener("change", () => {
    try {
      localStorage.setItem(KEY, r.dataset.themeChoice);
    } catch {
      // storage blocked: the choice lasts until the page is left
    }
  });
}

// Panels that fold (details[data-remember], like the Help centre): open or shut as you left them,
// per browser, across the reload after every change.
for (const d of document.querySelectorAll("details[data-remember]")) {
  try {
    const was = localStorage.getItem(d.dataset.remember);
    if (was !== null) d.open = was === "1";
  } catch {
    // storage blocked: it opens as the page says
  }
  d.addEventListener("toggle", () => {
    try {
      localStorage.setItem(d.dataset.remember, d.open ? "1" : "0");
    } catch {
      // storage blocked: it lasts until the page is left
    }
  });
}

// Switches that hide a part of the page (input[data-remember], like the sidebar's ☰): on or off
// as you left them, per browser, the same way.
for (const c of document.querySelectorAll("input[type=checkbox][data-remember]")) {
  try {
    const was = localStorage.getItem(c.dataset.remember);
    if (was !== null) c.checked = was === "1";
  } catch {
    // storage blocked: it starts as the page says
  }
  c.addEventListener("change", () => {
    try {
      localStorage.setItem(c.dataset.remember, c.checked ? "1" : "0");
    } catch {
      // storage blocked: it lasts until the page is left
    }
  });
}
