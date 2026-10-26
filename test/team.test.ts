// Each project's own people (src/serve/team.ts, Isha, 2026-10-25): the rules an admin's change to
// a team follows, and who a project made before then belongs to.
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAccess, saveGithubAuth, saveProject, savedProjects } from "../src/sync/credentials.ts";
import { changeTeam, inProject, isProjectAdmin, makers, projectPeople } from "../src/serve/team.ts";

test("a team changes by its admins' moves: add (in at once), make admin, make member, remove; a project always keeps an admin; any case is the same person", () => {
  const p = { admins: ["isha"], members: ["octo"] };
  assert.deepEqual(changeTeam(p, "add", "raj", true), { next: { admins: ["isha"], members: ["octo", "raj"] }, said: "Added raj: they see this project now." });
  assert.deepEqual(changeTeam(p, "add", "raj", false), { next: { admins: ["isha"], members: ["octo", "raj"] }, said: "Added raj: they see this project once they sign up with GitHub." });
  assert.deepEqual(changeTeam(p, "add", "OCTO", true), { why: "OCTO is already in this project." });
  assert.deepEqual(changeTeam(p, "admin", "Octo", true), { next: { admins: ["isha", "octo"], members: [] }, said: "octo is an admin now: they can add and remove people too." });
  assert.deepEqual(changeTeam(p, "admin", "isha", true), { why: "isha is already an admin." });
  assert.deepEqual(changeTeam(p, "member", "isha", true), { why: "isha is this project's only admin: make someone else admin first." });
  assert.deepEqual(changeTeam(p, "remove", "isha", true), { why: "isha is this project's only admin: make someone else admin first." });
  assert.deepEqual(changeTeam(p, "member", "octo", true), { why: "octo isn't an admin." });
  assert.deepEqual(changeTeam(p, "remove", "nobody", true), { why: "nobody isn't in this project." });
  assert.deepEqual(changeTeam(p, "remove", "OCTO", true), { next: { admins: ["isha"], members: [] }, said: "Removed OCTO: they no longer see this project, and their agents here stop." });
  const two = { admins: ["isha", "octo"], members: [] };
  assert.deepEqual(changeTeam(two, "member", "isha", true), { next: { admins: ["octo"], members: ["isha"] }, said: "isha is a member now." });
  assert.deepEqual(changeTeam(two, "remove", "isha", true), { next: { admins: ["octo"], members: [] }, said: "Removed isha: they no longer see this project, and their agents here stop." });
  assert.equal(inProject(p, "ISHA"), true);
  assert.equal(inProject(p, "raj"), false);
  assert.equal(isProjectAdmin(p, "octo"), false);
});

test("a project made before each had its own people: whoever made it is its admin once they've signed in here, else the owner; the people everyone had then are its members; once saved, its saved team is the one", async () => {
  const home = mkdtempSync(join(tmpdir(), "tira-team-"));
  const env = { TIRA_HOME: home };
  try {
    // no owner and no one known: no one yet
    assert.deepEqual(projectPeople("app", "someone", env), { admins: [], members: [] });
    await saveAccess(() => ({ admin: "isha", members: ["devansh", "octo"] }), env);
    // made by someone who never signed in here (a name tira serve was given): the owner's
    assert.deepEqual(projectPeople("app", "builder", env), { admins: ["isha"], members: ["devansh", "octo"] });
    // made by someone who has: theirs, and the others are members
    await saveGithubAuth("Octo", { token: "gho-x" }, env);
    assert.deepEqual(projectPeople("app", "octo", env), { admins: ["octo"], members: ["devansh"] });
    // the first change saves the team, from then on the only one
    assert.equal(await saveProject("app", (now) => (now ? undefined : { admins: ["raj"], members: [] }), env), true);
    assert.deepEqual(projectPeople("app", "octo", env), { admins: ["raj"], members: [] });
    assert.equal(await saveProject("app", (now) => (now ? undefined : { admins: ["mallory"], members: [] }), env), false); // taken
    assert.deepEqual(savedProjects(env), { app: { admins: ["raj"], members: [] } });
    // no one at all: nothing saved, and it's worked out again
    assert.equal(await saveProject("app", () => ({ admins: [], members: [] }), env), true);
    assert.deepEqual(savedProjects(env), {});
    // who made each project: the person behind its first event
    assert.deepEqual([...makers([{ stream: "a", metadata: { actor: "isha" } }, { stream: "b", metadata: {} }, { stream: "a", metadata: { actor: "octo" } }])], [["a", "isha"], ["b", undefined]]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
