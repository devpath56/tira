// Jira's sign-in runs in a tab of its own: Connect Jira opens one, so the page you were on stays.
// When Atlassian sends that tab back, it tells tira's other tabs, which reload to show your Jira
// projects, and closes itself if the browser lets it (else it says you can close it).
const channel = "BroadcastChannel" in window ? new BroadcastChannel("tira") : undefined;
if (document.querySelector("[data-jira-done]")) {
  channel?.postMessage({ jira: "connected" });
  setTimeout(() => window.close(), 1500);
} else {
  for (const a of document.querySelectorAll("a[data-connect-jira]")) {
    a.addEventListener("click", (e) => {
      // opened by the page, so the tab may close itself when it's done; Atlassian's pages get no
      // hold on this one (opener cut at once). Blocked: the link opens its own tab as usual.
      const tab = window.open(a.href, "_blank");
      if (tab) {
        tab.opener = null;
        e.preventDefault();
      }
    });
  }
  channel?.addEventListener("message", (e) => {
    // the New project page swaps in its Jira row itself (new-project.mjs), keeping what was typed
    if (e.data?.jira === "connected" && !document.querySelector("[data-np-jira-row]")) location.reload();
  });
}
