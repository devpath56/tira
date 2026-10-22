// The Help centre's conversation (integrations.ts draws it): a suggestion or a typed question
// shows on the right as yours, tira types for a moment, and its answer shows on the left. What you
// type is matched to the answers on the page (answerFor) and never leaves it.

// the words worth matching: lower case, letters and digits, without the small ones every question has
const SMALL = new Set(["a", "an", "the", "i", "is", "it", "do", "does", "how", "what", "why", "who", "where", "when", "can", "to", "for", "of", "my", "me", "and", "or", "in", "on", "with", "be", "are", "this", "that", "tira", "s", "make", "get"]);
export const words = (text) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !SMALL.has(w));
// one word for another: the same, or one starts the other (token, tokens; sync, syncing)
const near = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

// The answer for what someone typed: the entry its words fit best, or -1 when none fits one. A word
// that fits fewer entries says more ("stored" more than "jira"), so each counts 1 / the entries it
// fits; a tie goes to the first.
export function answerFor(text, entries) {
  const keys = entries.map((e) => words(`${e.q} ${e.keys}`));
  const score = entries.map(() => 0);
  for (const w of new Set(words(text))) {
    const fits = keys.map((k) => k.some((x) => near(w, x)));
    const n = fits.filter(Boolean).length;
    fits.forEach((f, i) => {
      if (f) score[i] += 1 / n;
    });
  }
  let best = -1;
  let top = 0;
  score.forEach((v, i) => {
    if (v > top) {
      best = i;
      top = v;
    }
  });
  return best;
}

const panel = typeof document === "undefined" ? null : document.querySelector("[data-help]");
if (panel) {
  const log = panel.querySelector("[data-help-log]");
  const suggest = panel.querySelector("[data-help-suggest]");
  const label = panel.querySelector("[data-help-sk]");
  const bottom = panel.querySelector("[data-help-bottom]");
  const form = panel.querySelector("[data-help-ask]");
  const input = form.querySelector("input");
  const send = form.querySelector("button");
  const qas = [...panel.querySelectorAll("details.hc-qa")];
  const entries = qas.map((d) => ({ q: d.querySelector("summary").textContent, keys: d.dataset.keys ?? "" }));
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  bottom.hidden = false;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  // bring a message into view, scrolling the panel alone (only the page when the panel sits below
  // it, on a narrow screen): its foot above the box you type in, or its top under the header
  const reveal = (m, at) => {
    const behavior = calm ? "auto" : "smooth";
    if (panel.scrollHeight <= panel.clientHeight + 1) return m.scrollIntoView({ block: at === "top" ? "start" : "nearest", behavior });
    const top = m.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
    const to = at === "top" ? top - 88 : top + m.offsetHeight + 120 - panel.clientHeight;
    if (to > panel.scrollTop) panel.scrollTo({ top: to, behavior });
  };
  const show = (msg) => {
    log.append(msg);
    reveal(msg, "foot");
  };
  const yours = (text) => {
    const m = el("div", "msg from-you");
    const b = el("div", "msg-b");
    b.append(el("p", "bubble", text));
    m.append(b);
    show(m);
  };
  // tira's turn: a moment of typing, then its answer (the page's own markup, or plain words)
  const tiras = (fill) => {
    const m = el("div", "msg from-tira");
    const av = el("span", "av tira", "t");
    av.setAttribute("aria-hidden", "true");
    const b = el("div", "msg-b");
    const typing = el("p", "bubble typing");
    typing.setAttribute("aria-label", "tira is typing");
    typing.append(el("i"), el("i"), el("i"));
    b.append(typing);
    m.append(av, b);
    show(m);
    setTimeout(() => {
      typing.remove();
      fill(b);
      offer();
      reveal(m, "top"); // the answer's top under the header, the questions that follow below it
    }, calm ? 0 : 650);
  };
  const answer = (i) => tiras((b) => {
    const p = el("p", "bubble");
    p.innerHTML = qas[i].querySelector(".bubble").innerHTML; // the server's own escaped markup
    b.append(p);
  });
  // the questions not asked yet, under the last message
  const offer = () => {
    const left = qas.filter((d) => !d.hidden);
    label.textContent = left.length === qas.length ? "Suggested" : "More questions";
    suggest.hidden = left.length === 0;
  };
  const ask = (i) => {
    yours(entries[i].q);
    qas[i].hidden = true;
    suggest.hidden = true;
    answer(i);
  };

  qas.forEach((d, i) => {
    d.querySelector("summary").addEventListener("click", (e) => {
      e.preventDefault();
      ask(i);
    });
  });
  input.addEventListener("input", () => {
    send.disabled = input.value.trim() === "";
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text === "") return;
    input.value = "";
    send.disabled = true;
    yours(text);
    suggest.hidden = true;
    const i = answerFor(text, entries);
    if (i >= 0) {
      qas[i].hidden = true;
      answer(i);
      return;
    }
    // nothing on the page answers it: say so, and offer every question again
    for (const d of qas) d.hidden = false;
    tiras((b) => b.append(el("p", "bubble", "I don't have an answer for that yet. One of these might help:")));
  });
}
