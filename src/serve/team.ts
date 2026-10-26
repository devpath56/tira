// Each project's own people (Isha, 2026-10-25), once tira has GitHub sign-in: anyone signs up with
// GitHub, whoever makes a project is its admin, and only a project's people see it (its board, its
// settings, its agents and Claude's connector). Its admins add people by GitHub username (in at
// once), make others admin and remove people; a project always keeps an admin. No one runs tira for
// everyone: the owner (TIRA_ADMIN, or the first person to sign in) has tira's setup and can remove
// an account, and sees no one's projects for it.
//
// A project made before then has no people saved: its admin is whoever made it (the person behind
// its first event, once they've signed in here), else the owner; and the people every project had
// then are its members. The first change to its team saves them.
import { access, knownLogin, savedProjects, same, type ProjectPeople } from "../sync/credentials.ts";

type Env = Record<string, string | undefined>;

// how many projects someone may be admin of, at a public address (the free database stays small)
export const MAX_PROJECTS = 5;

export const inProject = (p: ProjectPeople, login: string): boolean => [...p.admins, ...p.members].some((x) => same(x, login));
export const isProjectAdmin = (p: ProjectPeople, login: string): boolean => p.admins.some((x) => same(x, login));
export const everyone = (p: ProjectPeople): string[] => [...p.admins, ...p.members];

// a project's people: as saved, or else as they were before projects had their own
export function projectPeople(stream: string, maker: string | undefined, env: Env): ProjectPeople {
  const saved = savedProjects(env)[stream];
  if (saved) return saved;
  const a = access(env);
  const known = (login: string) => knownLogin(login, env) !== undefined || (a.members ?? []).some((m) => same(m, login));
  const admin = maker && known(maker) ? maker : a.admin;
  const admins = admin ? [admin] : [];
  return { admins, members: (a.members ?? []).filter((m) => !admins.some((x) => same(x, m))) };
}

// the person behind each project's first event (all: the log, in order)
export function makers(all: readonly { stream: string; metadata: { actor?: string } }[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const e of all) if (!out.has(e.stream)) out.set(e.stream, e.metadata.actor);
  return out;
}

// a change an admin makes in Project settings → Team
export type TeamMove = "add" | "remove" | "admin" | "member";
// signedUp: whether that login has signed in to tira yet (an added person sees the project once they do)
export function changeTeam(p: ProjectPeople, move: TeamMove, login: string, signedUp: boolean): { next: ProjectPeople; said: string } | { why: string } {
  const without = (list: string[]) => list.filter((x) => !same(x, login));
  const lastAdmin = isProjectAdmin(p, login) && p.admins.length === 1;
  if (move === "add") {
    if (inProject(p, login)) return { why: `${login} is already in this project.` };
    return { next: { admins: p.admins, members: [...p.members, login] }, said: signedUp ? `Added ${login}: they see this project now.` : `Added ${login}: they see this project once they sign up with GitHub.` };
  }
  if (!inProject(p, login)) return { why: `${login} isn't in this project.` };
  if (move === "remove") {
    if (lastAdmin) return { why: `${login} is this project's only admin: make someone else admin first.` };
    return { next: { admins: without(p.admins), members: without(p.members) }, said: `Removed ${login}: they no longer see this project, and their agents here stop.` };
  }
  if (move === "admin") {
    if (isProjectAdmin(p, login)) return { why: `${login} is already an admin.` };
    const who = p.members.find((x) => same(x, login)) ?? login;
    return { next: { admins: [...p.admins, who], members: without(p.members) }, said: `${who} is an admin now: they can add and remove people too.` };
  }
  if (!isProjectAdmin(p, login)) return { why: `${login} isn't an admin.` };
  if (lastAdmin) return { why: `${login} is this project's only admin: make someone else admin first.` };
  const who = p.admins.find((x) => same(x, login)) ?? login;
  return { next: { admins: without(p.admins), members: [...p.members, who] }, said: `${who} is a member now.` };
}
