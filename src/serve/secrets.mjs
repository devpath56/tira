// tira's own app keys in Setup, as Render shows environment secrets: dots until you ask. Show fetches
// that one value (the admin only: POST /integrations/setup/reveal, never cached) and shows it until
// you hide it, or for 30 seconds; Copy fetches it to the clipboard and says so with a tick (where a
// browser allows no copying, it shows the value selected, for ⌘C). The page itself only ever holds dots.
// The same Copy serves the Agents section: a button with data-copy-target copies that element's text.
const token = document.querySelector('input[name="token"]')?.value ?? "";
const valueOf = async (key) => {
  const res = await fetch("/integrations/setup/reveal", { method: "POST", body: new URLSearchParams({ token, key }), credentials: "same-origin", cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text;
};

// The clipboard, or, where a browser refuses it (some embedded ones do), the older copy command on a
// hidden field; false when neither works.
const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.append(field);
    field.select();
    let done = false;
    try {
      done = document.execCommand("copy");
    } catch {
      // nothing more to try
    }
    field.remove();
    return done;
  }
};

// Agents: Copy puts the address, the command (or Claude Desktop's entry) on the clipboard, or selects
// it for ⌘C. Asked of the page, not each button, so a step changed in place (agents.mjs) copies too.
document.addEventListener("click", async (e) => {
  const b = e.target instanceof Element ? e.target.closest("button[data-copy-target]") : null;
  const target = b ? document.getElementById(b.dataset.copyTarget ?? "") : null;
  if (!b || !target) return;
  if (await copyText(target.textContent ?? "")) {
    b.dataset.done = "";
    b.title = "Copied";
    setTimeout(() => { delete b.dataset.done; b.title = "Copy"; }, 1500);
    return;
  }
  getSelection()?.selectAllChildren(target);
  b.title = "Press ⌘C to copy";
});

for (const row of document.querySelectorAll("[data-env]")) {
  const key = row.dataset.env;
  const out = row.querySelector("[data-env-value]");
  const show = row.querySelector("[data-env-show]");
  const copy = row.querySelector("[data-env-copy]");
  if (!out) continue;
  const dots = out.textContent;
  let timer;
  const hide = () => {
    clearTimeout(timer);
    out.textContent = dots;
    out.classList.remove("shown");
    show?.setAttribute("aria-pressed", "false");
    if (show) show.title = "Show";
  };
  show?.addEventListener("click", async () => {
    if (show.getAttribute("aria-pressed") === "true") return hide();
    try {
      out.textContent = await valueOf(key);
      out.classList.add("shown");
      show.setAttribute("aria-pressed", "true");
      show.title = "Hide";
      timer = setTimeout(hide, 30_000);
    } catch (err) {
      out.textContent = err.message;
    }
  });
  copy?.addEventListener("click", async () => {
    try {
      const value = await valueOf(key);
      if (await copyText(value)) {
        copy.dataset.done = "";
        copy.title = "Copied";
        setTimeout(() => { delete copy.dataset.done; copy.title = "Copy"; }, 1500);
        return;
      }
      // no way to copy here: show it, selected, for ⌘C
      out.textContent = value;
      out.classList.add("shown");
      getSelection()?.selectAllChildren(out);
      copy.title = "Press ⌘C to copy";
      clearTimeout(timer);
      timer = setTimeout(hide, 30_000);
    } catch (err) {
      copy.title = err.message || "Couldn't copy";
    }
  });
}
