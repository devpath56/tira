# Invites to a project

**JTBD:** 8 — Approve, don't drive.

**What / why.** Joining a project is the person's own choice (Isha, 2026-10-26): an admin
invites someone by GitHub username in Project settings → Collaborators, and they accept or
decline. Before, being added let them straight in. The invite comes as a letter, after the
mail apps people know: once over the board when they next arrive (**Later** folds it away), on
Your projects, and in their **Inbox** (the sidebar's, with how many wait) until they answer.

**How to read it.** A letter: an envelope on a tile, an airmail edge, "You have an invite", the
project's mark and name, who invited them, and **Accept** or **Decline**. Accept puts the project
on their list and opens its board ("You joined …"); Decline lets it go. In Collaborators an
invite not answered yet is a row: Invited, by whom, not signed up yet where so, and for its
admins the bin to take it back. An empty Inbox says so, and that invites arrive there.

Invites are kept in the accounts' store (Postgres `account_invites`: project, login, who
invited, when), never in the project's log; an answer, or taking one back, removes it. The letter
over the board shows once per invite (`invite:<project>` among what the person has seen).

## Devtool hook

- `[data-letter-pop]` on the letter over the board (`#letter-later` folds it), `.letter` with `[data-invite]` (the project) on each letter; `[data-invites]` on Your projects' letters, `[data-inbox]` on the Inbox's, `[data-inbox-empty]` on an empty one.
- `[data-inbox]` on the sidebar's Inbox link, `.side-n` on its count.
- `[data-team-invited]` on an invite in Collaborators, `[data-team-uninvite]` on taking it back.

Assertion: an invited person doesn't see the project until they accept; the letter shows over the
board once; Accept lets them in and Decline doesn't (`test/sync.test.ts`); invites are shared on
Postgres from one computer to another (`test/accounts.test.ts`).

**Falsifier.** Someone sees a project they were only invited to, or answers an invite that isn't
theirs, or the letter comes back after Later.
