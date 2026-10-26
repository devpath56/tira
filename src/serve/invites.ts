// Invites to a project (Isha, 2026-10-26): an admin invites someone by GitHub username, and they
// answer it. Accept puts the project on their list and opens its board; Decline lets it go. It comes
// as a letter: once over the page when they next arrive (Later folds it away), and in their Inbox
// until they answer. Nothing here writes: the answer posts to /invites (integrations.ts).
import { esc } from "../render/escape.ts";
import { projectMark, nameHtml } from "../render/html.ts";
import type { Invite, Note } from "../sync/credentials.ts";

const ENVELOPE = `<svg viewBox="0 0 64 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="6" width="56" height="38" rx="6"/><path d="M6 10l26 20 26-20"/><path d="M6 42l20-16M58 42 38 26"/></svg>`;
export { INBOX_ICON } from "../render/html.ts";

// one invite, as a letter: who invited you, to which project, and the answer
export function letterHtml(inv: Invite, title: string, token: string): string {
  return `<article class="letter" data-invite="${esc(inv.stream)}"><span class="letter-env">${ENVELOPE}</span><div class="letter-body">`
    + `<p class="letter-k">You have an invite</p><h3>${projectMark(inv.stream, title)}<span>${nameHtml(title)}</span></h3>`
    + `<p><b>${esc(inv.by)}</b> invited you to work on ${esc(title)} with them. Accept, and it's on your project list and its board opens.</p>`
    + `<form method="post" action="/invites" class="letter-acts"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="stream" value="${esc(inv.stream)}">`
    + `<button class="act primary" type="submit" name="do" value="accept">Accept</button><button class="act" type="submit" name="do" value="decline">Decline</button></form></div></article>`;
}

// a note to whoever invited someone (Isha, 2026-10-26): they accepted (one click to the board) or
// declined; Dismiss puts it away. `board`: the project's board, for an accepted one.
const ANSWERED = { accepted: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.6L16 9.6"/></svg>`, declined: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>` };
export function noteHtml(n: Note, title: string, token: string, board: string): string {
  const yes = n.did === "accepted";
  const go = yes ? `<a class="act primary" href="${esc(board)}">Open the board</a>` : "";
  return `<article class="letter note ${n.did}" data-note="${esc(n.stream)}" data-did="${n.did}"><span class="letter-env">${ANSWERED[n.did]}</span><div class="letter-body">`
    + `<p class="letter-k">${yes ? "Invite accepted" : "Invite declined"}</p><h3>${projectMark(n.stream, title)}<span>${nameHtml(title)}</span></h3>`
    + `<p><b>${esc(n.who)}</b> ${n.did} your invite to ${esc(title)}.${yes ? " They can see its board now." : ""}</p>`
    + `<form method="post" action="/inbox/notes" class="letter-acts"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="stream" value="${esc(n.stream)}"><input type="hidden" name="who" value="${esc(n.who)}">`
    + `${go}<button class="act" type="submit">Dismiss</button></form></div></article>`;
}

// the letter over the page, once: Later folds it away (a checkbox, so it works with no script)
export function letterPop(inv: Invite, title: string, token: string): string {
  return `<input class="view-radio" type="checkbox" id="letter-later" aria-label="Read the invite later">`
    + `<div class="letter-pop" role="dialog" aria-modal="true" aria-label="An invite" data-letter-pop><div class="letter-pop-box">${letterHtml(inv, title, token)}`
    + `<label class="how letter-later" for="letter-later">Later: it waits in your Inbox</label></div></div>`;
}
