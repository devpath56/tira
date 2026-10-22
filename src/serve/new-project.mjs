// The New project page's preview: the project's mark and name as you type them (the same mark the
// sidebar will give it), and its repo. What you typed is kept for this tab, so connecting Jira (in
// a tab of its own, which reloads this page when it's done) doesn't lose it.
import { tint } from "/layout.mjs";

const name = document.querySelector("[data-np-name]");
const repo = document.querySelector("[data-np-repo]");
const mark = document.querySelector("[data-np-preview] .pav");
const shownName = document.querySelector("[data-np-show-name]");
const shownRepo = document.querySelector("[data-np-show-repo]");
const KEEP = "tira-new-project";

const show = () => {
  const n = name.value.trim() || "your-project";
  shownName.textContent = n;
  mark.textContent = ([...n][0] ?? "?").toUpperCase();
  mark.className = `pav t${tint(n)}`;
  shownRepo.textContent = repo.value.trim() || "owner/name";
};
if (name && repo && mark && shownName && shownRepo) {
  try {
    const was = JSON.parse(sessionStorage.getItem(KEEP) ?? "null");
    if (was && name.value === "" && repo.value === "") {
      name.value = was.name ?? "";
      repo.value = was.repo ?? "";
      show();
    }
  } catch {
    // storage blocked: the fields start empty
  }
  const keep = () => {
    show();
    try {
      sessionStorage.setItem(KEEP, JSON.stringify({ name: name.value, repo: repo.value }));
    } catch {
      // storage blocked: kept until the page reloads
    }
  };
  name.addEventListener("input", keep);
  repo.addEventListener("input", keep);
  name.form?.addEventListener("submit", () => {
    try {
      sessionStorage.removeItem(KEEP);
    } catch {
      // storage blocked: nothing was kept
    }
  });
}
