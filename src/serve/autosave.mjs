// Fields that save by themselves (Isha, 2026-10-26): a name or an email saves a moment after you
// stop typing, or when you leave it, and says so quietly beside it ("Saved", or why not). Enter saves
// at once. With no script, Enter submits the form and the page comes back with the result.
for (const form of document.querySelectorAll("form[data-autosave]")) {
  const input = form.querySelector('input:not([type="hidden"])');
  const state = form.querySelector("[data-save-state]");
  if (!(input instanceof HTMLInputElement) || !state) continue;
  let saved = input.value;
  let timer = 0;
  const say = (text, ok) => {
    state.textContent = text;
    state.classList.toggle("no", !ok);
  };
  const save = async () => {
    clearTimeout(timer);
    if (input.value.trim() === saved.trim()) return;
    if (!input.checkValidity()) return say(input.validationMessage, false);
    say("Saving…", true);
    const body = new URLSearchParams(new FormData(form));
    body.set("fragment", "1");
    try {
      const res = await fetch(form.action, { method: "POST", body, keepalive: true }); // finishes even if you leave the page
      const said = await res.text();
      if (!res.ok) return say(said, false);
      saved = input.value;
      say("Saved", true);
    } catch {
      say("Not saved: tira didn't answer.", false);
    }
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    say("", true);
    timer = window.setTimeout(save, 900);
  });
  input.addEventListener("blur", save);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    save();
  });
}
