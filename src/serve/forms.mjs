// Small helpers for settings forms (Isha, 2026-10-26). A form marked data-confirm asks first (taking
// someone off a project); one marked data-autosubmit sends itself when its picker changes (a
// collaborator's role). With no script, each is a plain form with its own button.
for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (e) => {
    if (!window.confirm(form.dataset.confirm ?? "Are you sure?")) e.preventDefault();
  });
}
for (const form of document.querySelectorAll("form[data-autosubmit]")) {
  form.querySelector("select")?.addEventListener("change", () => form.requestSubmit());
}
