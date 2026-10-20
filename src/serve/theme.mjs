// The theme switch (System / Light / Dark) is CSS only: radio inputs the page carries. Under
// `tira serve` this remembers the choice per browser, so it survives reloads and carries to
// the confirm page. Loaded by the confirm page directly and by app.mjs on the live page.
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
