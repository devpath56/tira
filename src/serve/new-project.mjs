// The New project page's preview: the project's mark and name as you type them (the same mark the
// sidebar will give it), and its repo. Once Jira is connected (in a tab of its own), the page fetches
// itself again and swaps in its Jira row alone, so nothing you typed is touched (and nothing you
// type is kept anywhere but the form).
import { tint } from "/layout.mjs";

const name = document.querySelector("[data-np-name]");
const repo = document.querySelector("[data-np-repo]");
const mark = document.querySelector("[data-np-preview] .pav");
const shownName = document.querySelector("[data-np-show-name]");
const shownRepo = document.querySelector("[data-np-show-repo]");

const show = () => {
  const n = name.value.trim() || "your-project";
  shownName.textContent = n;
  mark.textContent = ([...n][0] ?? "?").toUpperCase();
  mark.className = `pav t${tint(n)}`;
  shownRepo.textContent = repo.value.trim() || "owner/name";
};
if (name && repo && mark && shownName && shownRepo) {
  name.addEventListener("input", show);
  repo.addEventListener("input", show);
}

// Jira said yes in the other tab: this page's Jira row, as the server now draws it
const channel = "BroadcastChannel" in window ? new BroadcastChannel("tira") : undefined;
channel?.addEventListener("message", async (e) => {
  if (e.data?.jira !== "connected") return;
  try {
    const page = await (await fetch("/projects/new", { cache: "no-store" })).text();
    const fresh = new DOMParser().parseFromString(page, "text/html").querySelector("[data-np-jira-row]");
    const now = document.querySelector("[data-np-jira-row]");
    if (fresh && now) now.replaceWith(document.importNode(fresh, true));
  } catch {
    // the server is away for a moment: a reload shows it
  }
});
