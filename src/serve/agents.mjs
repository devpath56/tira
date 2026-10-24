// Project settings → Connect agents, live: Test connection asks tira from here and shows its answer
// in place, under the button. Without this script the form posts as usual and the page shows it.
for (const form of document.querySelectorAll("form[data-agent-test]")) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const slot = document.querySelector("[data-agent-tested]");
    const button = form.querySelector("button");
    const body = new URLSearchParams(new FormData(form));
    body.set("fragment", "1");
    if (button) button.disabled = true;
    try {
      const doc = new DOMParser().parseFromString(await (await fetch(form.getAttribute("action") ?? "", { method: "POST", body })).text(), "text/html");
      const said = doc.querySelector("[data-flash]");
      if (!said || !slot) return form.submit();
      slot.replaceChildren(said);
    } catch {
      form.submit(); // no answer: post it the plain way
    } finally {
      if (button) button.disabled = false;
    }
  });
}
