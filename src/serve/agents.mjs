// Project settings → Connect agents, live (Isha, 2026-10-26). Picking an app, naming its agent and
// going back change the section in place, with no page load. A step that waits on an agent (Claude's
// connector, or an app's last step) asks tira every few seconds, for ten minutes and only while the
// page is in view, and turns green the moment the agent first calls. Check now asks at once. Without
// this script each step is its own page and every form posts as usual.
const SECTION = "#agents";
const EVERY_MS = 3000;
const FOR_MS = 10 * 60_000;
let timer = 0;

const parse = async (res) => new DOMParser().parseFromString(await res.text(), "text/html");
const section = () => document.querySelector(SECTION);

// the step's status, asked once: the answer in its slot; true once it's green
const ask = async (form) => {
  const body = new URLSearchParams(new FormData(form));
  body.set("fragment", "1");
  const said = (await parse(await fetch(form.getAttribute("action") ?? "", { method: "POST", body }))).querySelector("[data-flash]");
  if (!said) return false;
  form.parentElement?.querySelector("[data-agent-tested]")?.replaceChildren(said);
  if (!said.classList.contains("ok")) return false;
  const step = form.closest("[data-agent-step]");
  step?.classList.replace("now", "done");
  const n = step?.querySelector(".agent-n");
  if (n) n.textContent = "✓";
  form.closest("[data-agent-connector]")?.classList.add("ok");
  return true;
};

// the section as tira has it now, quietly (where you are on the page stays): once an agent has
// called, so its row says when it was last used
const refresh = async () => {
  const fresh = (await parse(await fetch(location.href))).querySelector(SECTION);
  if (!fresh) return;
  const green = section()?.querySelector("[data-agent-connector].ok [data-agent-tested]"); // Claude's card stays green
  section()?.replaceChildren(...fresh.childNodes);
  const card = section()?.querySelector("[data-agent-connector]");
  if (!green || !card) return;
  card.classList.add("ok");
  card.querySelector("[data-agent-tested]")?.replaceWith(green);
  dispatchEvent(new Event("tira:swapped"));
};

// waits on the agent, by itself
const watch = () => {
  clearTimeout(timer);
  const form = section()?.querySelector("form[data-agent-watch]");
  if (!form || form.closest(".done")) return;
  const until = Date.now() + FOR_MS;
  const again = async () => {
    if (!form.isConnected) return;
    if (!document.hidden) {
      try {
        if (await ask(form)) return void refresh().catch(() => {});
      } catch {
        // no answer this time: ask again
      }
    }
    if (Date.now() < until) timer = setTimeout(again, EVERY_MS);
  };
  timer = setTimeout(again, EVERY_MS);
};

// a step, in place: the section's insides from the page it leads to (the section itself stays, so
// it stays the one shown); the address follows, for Back and a reload
const go = async (url, init, push = true, form = undefined) => {
  try {
    const res = await fetch(url, init);
    const fresh = (await parse(res)).querySelector(SECTION);
    const now = section();
    if (!res.ok || !fresh || !now) throw new Error("no section");
    now.replaceChildren(...fresh.childNodes);
    dispatchEvent(new Event("tira:swapped")); // what's drawn in new (cplay.mjs) starts
    const to = res.url.split("#")[0] + "#agents";
    if (push) history.pushState({ agents: true }, "", to);
    else history.replaceState({ agents: true }, "", to);
    window.scrollTo(0, 0);
    watch();
  } catch {
    if (form) form.submit(); // no answer: the plain way
    else location.href = url;
  }
};

document.addEventListener("click", (e) => {
  const a = e.target instanceof Element ? e.target.closest(`${SECTION} a[data-agent-go]`) : null;
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  go(a.href);
});
document.addEventListener("submit", (e) => {
  const form = e.target instanceof HTMLFormElement ? e.target : null;
  if (!form?.closest(SECTION)) return;
  if (form.matches("[data-agent-test]")) {
    e.preventDefault();
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    ask(form).catch(() => form.submit()).finally(() => { if (button) button.disabled = false; });
    return;
  }
  if (!form.matches("[data-agent-go]")) return;
  e.preventDefault();
  go(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)) }, true, form);
});
window.addEventListener("popstate", () => {
  if (location.hash === "#agents") go(location.href, undefined, false);
});
watch();
