// A ticket edited where it shows (Isha, 2026-10-26: "not neat", "not modern"; src/render/html.ts):
// - its description reads as it's meant until you click it (or press Enter on it); then it's an
//   editor, with buttons that put in a mark (bold, italic, code, a list, a link) and its own Save and
//   Cancel. Esc cancels, Cmd/Ctrl+Enter saves (app.mjs).
// - its title saves when you leave it, changed (Enter saves it too: app.mjs), unless you go on to
//   another of its fields: the description's Save takes both.
// - a field beside it (work type, review, assignee, effort) saves as soon as it's picked.
// - every save stays on the page: no reload (below).
// - files: a comment takes pictures, PDFs and documents (Attach, a drop, or a pasted picture), each
//   sent to tira as it's added (POST /files) and named in the comment when it's sent; a Complete's
//   proof, for work that isn't code, can be a file the same way. A comment, sent, slides into the
//   thread in place (no reload), the box empties, and the Comments count goes up.
// With no script the page still works: the description is a plain field and the form's Save saves.

const changed = (f) => f.value !== f.defaultValue;

// ---------- the description ----------
const editDesc = (box) => {
  box.classList.add("editing");
  const area = box.querySelector("textarea");
  area?.focus();
  area?.setSelectionRange(area.value.length, area.value.length);
};
const cancelDesc = (box) => {
  const area = box.querySelector("textarea");
  if (area) area.value = area.defaultValue;
  box.classList.remove("editing");
  box.querySelector("[data-desc-view]")?.focus();
};
document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  const view = t?.closest("[data-desc-view]");
  if (view && !t.closest("a")) return editDesc(view.closest("[data-desc]"));
  const cancel = t?.closest("[data-desc-cancel]");
  if (cancel) return cancelDesc(cancel.closest("[data-desc]"));
  const tool = t?.closest("[data-desc-tool]");
  if (tool) mark(tool.closest("[data-desc]")?.querySelector("textarea"), tool.dataset.descTool);
});
document.addEventListener("keydown", (e) => {
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (t?.matches("[data-desc-view]") && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    editDesc(t.closest("[data-desc]"));
  } else if (e.key === "Escape" && t?.matches("[data-desc] textarea")) {
    e.preventDefault(); // the dialog stays open (app.mjs closes it on an Escape nothing took)
    cancelDesc(t.closest("[data-desc]"));
  }
}, true);

// A mark around what's chosen (bold, italic, code), at the start of each line chosen (a list), or a
// link; what was chosen stays chosen.
const WRAP = { bold: "**", italic: "*", code: "`" };
function mark(area, kind) {
  if (!(area instanceof HTMLTextAreaElement)) return;
  const { selectionStart: a, selectionEnd: b, value } = area;
  const chosen = value.slice(a, b);
  let put;
  if (WRAP[kind]) put = `${WRAP[kind]}${chosen || "text"}${WRAP[kind]}`;
  else if (kind === "link") put = /^https?:\/\//.test(chosen) ? chosen : `${chosen || "link"} https://`;
  else put = (chosen || "").split("\n").map((line, i) => `${kind === "ol" ? `${i + 1}.` : "-"} ${line}`).join("\n");
  const lineStart = kind === "ul" || kind === "ol" ? a === 0 || value[a - 1] === "\n" : true;
  if (!lineStart) put = `\n${put}`;
  area.focus();
  area.setRangeText(put, a, b, chosen ? "select" : "end");
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------- saving in place ----------
// A ticket's form saves without leaving the page (Isha, 2026-10-26: "review toggle is refreshing the
// screen"): sent to tira as it is (fragment=1, one save at a time), then what it says now is what it
// starts from, the description reads as saved, and a quiet note says "Saved" (or why not, until the
// next save). The board behind the dialog catches up when it closes (app.mjs, told by tira:saved).
const keep = (form) => {
  for (const f of [...form.elements]) {
    if (f instanceof HTMLTextAreaElement || (f instanceof HTMLInputElement && f.type !== "checkbox" && f.type !== "radio")) f.defaultValue = f.value;
    else if (f instanceof HTMLInputElement) f.defaultChecked = f.checked;
    else if (f instanceof HTMLSelectElement) for (const o of f.options) o.defaultSelected = o.selected;
  }
};
const readAs = (box, html) => {
  const view = box?.querySelector("[data-desc-view]");
  if (!view) return;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (doc.body.childNodes.length === 0) view.replaceChildren("Add a description…");
  else view.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
  view.classList.toggle("empty", doc.body.childNodes.length === 0);
  box.classList.remove("editing");
};
let sayTimer = 0;
const say = (form, text, ok) => {
  const note = form.closest(".modal-box")?.querySelector("[data-ticket-said]");
  if (!note) return;
  clearTimeout(sayTimer);
  note.textContent = text;
  note.classList.toggle("no", !ok);
  note.classList.add("on");
  if (ok) sayTimer = setTimeout(() => note.classList.remove("on"), 1800);
};
const saving = new WeakMap();
async function saveInPlace(form) {
  const body = new URLSearchParams(new FormData(form));
  body.set("fragment", "1");
  try {
    const res = await fetch(form.action, { method: "POST", body });
    const got = await res.json();
    if (!got.ok) return say(form, got.text, false);
    keep(form);
    readAs(form.querySelector("[data-desc]"), got.desc ?? "");
    form.querySelector("[data-desc-view]")?.classList.add("fresh");
    say(form, got.text === "Nothing changed." ? "Nothing changed" : got.text.replace(/\.$/, ""), true);
    if (Number.isSafeInteger(got.seq)) dispatchEvent(new CustomEvent("tira:saved", { detail: { seq: got.seq } }));
  } catch {
    say(form, "Not saved: tira didn't answer. Try again.", false);
  }
}
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.matches("[data-ticket-form]")) return;
  e.preventDefault();
  const next = (saving.get(form) ?? Promise.resolve()).then(() => saveInPlace(form));
  saving.set(form, next);
});

// ---------- comments in place ----------
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const countUp = (form) => {
  const tab = form.closest(".activity")?.querySelector('.act-tabs label[for$="-c"]');
  if (!tab) return;
  let k = tab.querySelector(".k");
  if (!k) {
    k = Object.assign(document.createElement("span"), { className: "k", textContent: "0" });
    tab.append(" ", k);
  }
  k.textContent = String(Number(k.textContent || 0) + 1);
};
async function commentInPlace(form) {
  const button = form.querySelector('button[type="submit"]');
  const text = form.querySelector("textarea");
  const body = new URLSearchParams(new FormData(form));
  body.set("fragment", "1");
  form.classList.add("sending");
  button?.setAttribute("disabled", "");
  try {
    const res = await fetch(form.action, { method: "POST", body });
    const got = await res.json();
    if (!got.ok) return say(form, got.text, false);
    const item = got.item ? new DOMParser().parseFromString(got.item, "text/html").body.firstElementChild : null;
    if (item) {
      let list = form.closest("[data-comments]")?.querySelector(".cm-list");
      if (!list) {
        list = Object.assign(document.createElement("ol"), { className: "cm-list" });
        form.before(list);
      }
      const li = document.importNode(item, true);
      li.classList.add("cm-new");
      list.append(li);
      li.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
    }
    if (text) Object.assign(text, { value: "", placeholder: "Reply…", required: true });
    form.querySelector("[data-comment-adds]")?.replaceChildren();
    countUp(form);
    say(form, got.text.replace(/\.$/, ""), true);
    if (Number.isSafeInteger(got.seq)) dispatchEvent(new CustomEvent("tira:saved", { detail: { seq: got.seq } }));
  } catch {
    say(form, "Not sent: tira didn't answer. Try again.", false);
  } finally {
    form.classList.remove("sending");
    button?.removeAttribute("disabled");
  }
}
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !form.matches("[data-comment-form]")) return;
  e.preventDefault();
  if (!form.classList.contains("sending")) commentInPlace(form);
});
// what came in fresh plays once (a new comment glows a moment longer), then is ordinary again
document.addEventListener("animationend", (e) => {
  if (!(e.target instanceof Element)) return;
  if (e.animationName === "cm-glow") e.target.closest(".cm")?.classList.remove("cm-new");
  else if (e.target.classList.contains("fresh")) e.target.classList.remove("fresh");
});

// ---------- fields that save themselves ----------
document.addEventListener("change", (e) => {
  const f = e.target;
  if (!(f instanceof HTMLInputElement || f instanceof HTMLSelectElement) || !f.matches("[data-save-on-change]")) return;
  if (f.type === "number" && !f.checkValidity()) return;
  f.form?.requestSubmit();
});
document.addEventListener("focusout", (e) => {
  const f = e.target;
  if (!(f instanceof HTMLTextAreaElement) || !f.matches("[data-save-on-leave]") || !changed(f)) return;
  const next = e.relatedTarget;
  if (next instanceof HTMLElement && f.form && (f.form.contains(next) || next.getAttribute("form") === f.form.id)) return; // on to another of its fields
  f.form?.requestSubmit();
});

// ---------- files ----------
const tokenOf = (form) => form?.querySelector('input[name="token"]')?.value ?? "";
// one file to tira: what it is (JSON), or why not (thrown, in words)
async function upload(url, file, token) {
  const res = await fetch(url, { method: "POST", body: file, headers: { "x-tira-token": token, "x-file-name": encodeURIComponent(file.name) } });
  if (!res.ok) throw new Error((await res.text()).trim() || `not kept (HTTP ${res.status})`);
  return res.json();
}
const chipOf = (file) => {
  const chip = document.createElement("span");
  chip.className = "cm-add loading";
  if (file.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = URL.createObjectURL(file);
    img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
    chip.append(img);
  }
  const name = document.createElement("span");
  name.textContent = file.name;
  const drop = document.createElement("button");
  drop.type = "button";
  drop.textContent = "×";
  drop.setAttribute("aria-label", `Remove ${file.name}`);
  chip.append(name, drop);
  return { chip, name, drop };
};
// files into a comment: each a chip while it goes up, then a hidden field the comment sends
function addFiles(form, files) {
  const picker = form.querySelector("[data-comment-file]");
  const adds = form.querySelector("[data-comment-adds]");
  const text = form.querySelector("textarea");
  if (!picker || !adds) return;
  for (const file of files) {
    const { chip, name, drop } = chipOf(file);
    adds.append(chip);
    let field;
    const sync = () => text?.toggleAttribute("required", adds.querySelector("input[name=file]") === null);
    drop.addEventListener("click", () => {
      chip.remove();
      field?.remove();
      sync();
    });
    upload(picker.dataset.upload, file, tokenOf(form)).then((meta) => {
      chip.classList.remove("loading");
      field = Object.assign(document.createElement("input"), { type: "hidden", name: "file", value: meta.id });
      chip.append(field);
      sync();
    }, (err) => {
      chip.classList.replace("loading", "bad");
      name.textContent = `${file.name}: ${err.message}`;
    });
  }
}
document.addEventListener("change", (e) => {
  const picker = e.target;
  if (!(picker instanceof HTMLInputElement) || !picker.matches("[data-comment-file]") || !picker.form) return;
  addFiles(picker.form, [...(picker.files ?? [])]);
  picker.value = ""; // the same file again is a new pick
});
// a drop on the comment box, or a picture pasted into it
const boxOf = (e) => (e.target instanceof Element ? e.target.closest("[data-comment-form] .cm-box") : null);
document.addEventListener("dragover", (e) => {
  const box = boxOf(e);
  if (!box || !e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  box.classList.add("drop");
});
document.addEventListener("dragleave", (e) => boxOf(e)?.classList.remove("drop"));
document.addEventListener("drop", (e) => {
  const box = boxOf(e);
  if (!box || !e.dataTransfer?.files.length) return;
  e.preventDefault();
  box.classList.remove("drop");
  addFiles(box.closest("form"), [...e.dataTransfer.files]);
});
document.addEventListener("paste", (e) => {
  const box = boxOf(e);
  const files = [...(e.clipboardData?.files ?? [])];
  if (!box || files.length === 0) return;
  e.preventDefault();
  addFiles(box.closest("form"), files);
});

// a Complete's proof, a file: it goes up, and the proof field names it
document.addEventListener("change", (e) => {
  const picker = e.target;
  if (!(picker instanceof HTMLInputElement) || !picker.matches("[data-proof-file]")) return;
  const file = picker.files?.[0];
  const form = picker.form ?? picker.closest("form");
  const holder = picker.closest("[data-proof-attach]");
  const said = holder?.querySelector("[data-proof-file-said]");
  const field = form?.querySelector('input[name="proofRef"]');
  if (!file || !holder || !said || !field) return;
  said.classList.remove("bad");
  said.textContent = `Adding ${file.name}…`;
  upload(holder.dataset.proofAttach, file, tokenOf(form)).then((meta) => {
    field.value = `file:${meta.id}`;
    said.textContent = `${file.name} is the proof.`;
  }, (err) => {
    said.classList.add("bad");
    said.textContent = err.message;
  });
});
