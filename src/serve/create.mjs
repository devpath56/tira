// + Create, live (Isha, 2026-10-26): it posts from here and gets the answer alone, so what was typed
// stays when tira says why it can't (a name taken, an estimate it can't read). Created: the board
// comes back with the new task marked; kept open for the next one, the composer stays, keeping
// its assignee, estimate and parent, and the board catches up once it closes. The description grows
// as it's typed. Its property pills get a menu of their own (below). Without this script the form posts
// as usual, the pills are plain pickers, and Create opens again with the answer.
const form = document.querySelector("form[data-create-form]");
if (form instanceof HTMLFormElement) {
  const said = form.querySelector("[data-create-said]");
  const name = form.querySelector('input[name="name"]');
  const description = form.querySelector('textarea[name="description"]');
  const more = form.querySelector('input[name="more"]');
  const go = form.querySelector(".composer-go");
  let madeAny = false;
  const say = (text, ok) => {
    if (!said) return;
    said.textContent = text;
    said.classList.toggle("no", !ok);
  };
  const fit = () => {
    if (!(description instanceof HTMLTextAreaElement)) return;
    description.style.height = "auto";
    description.style.height = `${Math.min(description.scrollHeight, 320)}px`;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) return form.reportValidity();
    const body = new URLSearchParams(new FormData(form));
    body.set("fragment", "1");
    if (go instanceof HTMLButtonElement) go.disabled = true;
    try {
      const answer = await (await fetch(form.action, { method: "POST", body })).json();
      if (!answer.ok) return say(answer.text, false);
      if (!(more instanceof HTMLInputElement && more.checked)) return location.assign(answer.go);
      madeAny = true;
      say(`✓ ${answer.text}`, true);
      if (description instanceof HTMLTextAreaElement) description.value = "";
      fit();
      if (name instanceof HTMLInputElement) {
        name.value = "";
        name.focus();
      }
    } catch {
      form.submit(); // no answer: post it the plain way
    } finally {
      if (go instanceof HTMLButtonElement) go.disabled = false;
    }
  });
  form.addEventListener("input", (e) => {
    if (e.target === description) fit();
    if (e.target === name && said?.classList.contains("no")) say("", true); // a new try clears why the last didn't take
  });
  addEventListener("hashchange", () => {
    if (madeAny && location.hash !== "#create") location.reload();
  });

  // Property pills (Isha, 2026-10-26: "Assignee and No assignee shouldn't be there together"): a menu
  // of their own, as Linear's, not the browser's (Safari lists the pill's name as a choice). The pill
  // says its property until something's picked, then what's picked; the menu marks it with a tick,
  // its groups (People, Agents) as headings; arrows move, Enter picks, Esc closes. The picker under
  // it still holds the value the form sends.
  let open = null;
  const close = () => {
    open?.menu.remove();
    open?.pill.setAttribute("aria-expanded", "false");
    open = null;
  };
  const pillSays = (pill) => {
    const pick = pill.querySelector("select");
    const words = pill.querySelector(".prop-said");
    if (!(pick instanceof HTMLSelectElement) || !words) return;
    words.textContent = pick.value ? pick.selectedOptions[0]?.textContent ?? pick.value : pill.dataset.pill ?? "";
    pill.classList.toggle("set", pick.value !== "");
  };
  const menuFor = (pill) => {
    close();
    const pick = pill.querySelector("select");
    if (!(pick instanceof HTMLSelectElement)) return;
    const menu = document.createElement("div");
    menu.className = "pill-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", pill.dataset.pill ?? "");
    const items = [];
    const add = (o) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill-opt";
      b.setAttribute("role", "option");
      b.dataset.value = o.value;
      b.textContent = o.textContent;
      if (o.value === pick.value) b.setAttribute("aria-selected", "true");
      items.push(b);
      menu.append(b);
    };
    for (const el of pick.children) {
      if (el instanceof HTMLOptGroupElement) {
        const h = document.createElement("p");
        h.className = "pill-group";
        h.textContent = el.label;
        menu.append(h);
        for (const o of el.children) add(o);
      } else add(el);
    }
    menu.addEventListener("click", (e) => {
      const b = e.target instanceof Element ? e.target.closest(".pill-opt") : null;
      if (!(b instanceof HTMLElement)) return;
      pick.value = b.dataset.value ?? "";
      pillSays(pill);
      close();
      pill.focus();
    });
    menu.addEventListener("keydown", (e) => {
      const at = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[Math.min(items.length - 1, at + 1)]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[Math.max(0, at - 1)]?.focus(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); pill.focus(); } // the menu closes, not Create
    });
    menu.style.left = `${pill.offsetLeft}px`;
    menu.style.top = `${pill.offsetTop + pill.offsetHeight + 6}px`;
    pill.parentElement?.append(menu);
    pill.setAttribute("aria-expanded", "true");
    open = { pill, menu };
    (items.find((b) => b.getAttribute("aria-selected") === "true") ?? items[0])?.focus();
  };
  for (const pill of form.querySelectorAll(".prop-pill[data-pill]")) {
    pill.tabIndex = 0;
    pill.setAttribute("role", "button");
    pill.setAttribute("aria-haspopup", "listbox");
    pill.setAttribute("aria-expanded", "false");
    pillSays(pill);
    pill.addEventListener("click", (e) => {
      e.preventDefault();
      if (open?.pill === pill) close();
      else menuFor(pill);
    });
    pill.addEventListener("keydown", (e) => {
      if (e.target !== pill || !["Enter", " ", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      menuFor(pill);
    });
  }
  document.addEventListener("click", (e) => {
    if (open && e.target instanceof Node && !open.menu.contains(e.target) && !open.pill.contains(e.target)) close();
  });
}
