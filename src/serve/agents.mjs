// Project settings → Connect agents, live: a Connect choice makes the agent's token from here and,
// for Cursor or VS Code, opens the app's install link straight away, while the click still counts
// as yours (an app link opened after the page reloads would need another click); the page then
// shows the new agent and its token, once. Without this script the form posts as usual and the
// section offers the app's link to click. The Connect menu closes on a click outside it.
for (const form of document.querySelectorAll("form[data-agent-connect]")) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = new URLSearchParams(new FormData(form));
    body.set("fragment", "1");
    try {
      const doc = new DOMParser().parseFromString(await (await fetch(form.getAttribute("action") ?? "", { method: "POST", body })).text(), "text/html");
      const done = doc.querySelector("[data-go]");
      if (!done) return form.submit();
      const open = done.getAttribute("data-open");
      if (open?.startsWith("https://")) window.open(open, "_blank", "noopener");
      else if (open) {
        const a = document.createElement("a");
        a.href = open;
        a.hidden = true;
        document.body.append(a);
        a.click();
        a.remove();
      }
      location.href = done.getAttribute("data-go") ?? location.href;
    } catch {
      form.submit(); // no answer: post it the plain way
    }
  });
}

const menu = document.querySelector("details.agent-menu");
document.addEventListener("click", (e) => {
  if (menu?.open && e.target instanceof Node && !menu.contains(e.target)) menu.open = false;
});
