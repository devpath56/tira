// Sign in with GitHub, live: while the code waits on github.com, ask tira every few seconds
// whether it has been approved (the page's own form, posted in the background), and go on once
// it has. Without this script the "continue" button does the same, one press at a time.
// Also: a Copy button for the code.
const form = document.querySelector("form[data-signin-wait]");
const status = document.querySelector("[data-signin-status]");
if (form instanceof HTMLFormElement) {
  let wait = Number(form.dataset.interval || "5");
  const say = (text) => { if (status) status.textContent = text; };
  const ask = async () => {
    const body = new URLSearchParams(new FormData(form));
    body.set("fragment", "1");
    try {
      const res = await fetch("/signin/poll", { method: "POST", body });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const go = doc.querySelector("[data-go]")?.getAttribute("data-go");
      if (go) return void (location.href = go);
      const error = doc.querySelector("[data-error]")?.textContent;
      if (error) return void say(error);
      wait = Number(doc.querySelector("[data-waiting]")?.getAttribute("data-interval") || wait);
    } catch {
      // no answer: try again on the next round
    }
    setTimeout(ask, wait * 1000);
  };
  setTimeout(ask, wait * 1000);
}

const copy = document.querySelector("button[data-copy]");
if (copy instanceof HTMLButtonElement && navigator.clipboard) {
  copy.hidden = false;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy || "");
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy it by hand";
    }
  });
}
