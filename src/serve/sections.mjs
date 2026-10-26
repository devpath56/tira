// Settings, one section at a time (Isha, 2026-10-26, after Chrome's): the page shows the section the
// address names (CSS :target), else the first; this marks that one in the list on the left, and keeps
// the page at its top when another is picked. (A form coming back to its section stays at the top
// too, title and result in view: each section's scroll-margin keeps the browser from scrolling to it.)
const links = [...document.querySelectorAll(".set-nav .set-link")];
const mark = () => {
  const named = links.find((a) => a.hash !== "" && a.hash === location.hash) ?? links[0];
  for (const a of links) {
    if (a === named) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
};
const top = () => window.scrollTo(0, 0);
// a form's result belongs to the section it came from: it goes when you pick another
const result = document.querySelector(".set-main > [data-flash]");
window.addEventListener("hashchange", () => {
  mark();
  top();
  result?.remove();
});
mark();
