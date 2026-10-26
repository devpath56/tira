// tira at a public https address (one shared server, on Render or the like; Isha, 2026-10-24):
// TIRA_PUBLIC_URL names it (https://tira.example.com), and then tira serve listens on every
// address at $PORT, answers only that address (and this computer's), builds every sign-in's way
// back from it, marks its cookies Secure and asks browsers to keep to https. Nothing there can be
// set up by whoever arrives first: tira's GitHub app comes from the server's settings
// (TIRA_GITHUB_CLIENT_ID and TIRA_GITHUB_CLIENT_SECRET), and so does its owner (TIRA_ADMIN); no one
// acts without signing in; and the page token comes from TIRA_SECRET_KEY, so a deploy doesn't turn
// pages left open stale.
import { createHmac } from "node:crypto";
import { isPostgresUrl } from "../store/open.ts";

type Env = Record<string, string | undefined>;
// the address as people reach it: its origin (scheme, host, port) and its host
export interface PublicSite { origin: string; host: string }

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const THIS_COMPUTER = /^(localhost|127\.0\.0\.1|\[::1\])$/;
export const PUBLIC_URL_PROBLEM = "TIRA_PUBLIC_URL must be the https address people reach tira at, with no path: https://tira.example.com";

// The public address, read; undefined when none is set. http only for a name on this computer
// (a try before deploying), never for one people reach over the internet.
export function publicSite(env: Env): PublicSite | undefined {
  const said = env.TIRA_PUBLIC_URL?.trim();
  if (!said) return undefined;
  let u: URL;
  try {
    u = new URL(said);
  } catch {
    throw new TypeError(PUBLIC_URL_PROBLEM);
  }
  const plain = u.protocol === "http:" && THIS_COMPUTER.test(u.hostname);
  if ((u.protocol !== "https:" && !plain) || u.pathname !== "/" || u.search || u.hash || u.username || u.password) throw new TypeError(PUBLIC_URL_PROBLEM);
  return { origin: u.origin, host: u.host };
}

// Why tira can't serve a public address as it stands, if it can't: the first problem, in words.
export function publicProblem(env: Env, actor: string | undefined): string | undefined {
  try {
    if (!publicSite(env)) return undefined;
  } catch (err) {
    return (err as Error).message;
  }
  const db = env.TIRA_DATABASE_URL ?? env.TIRA_DB;
  const admin = env.TIRA_ADMIN?.trim() ?? "";
  return [
    actor === undefined ? "" : "at a public address everyone signs in with GitHub: don't set --actor or TIRA_ACTOR",
    db !== undefined && isPostgresUrl(db) ? "" : "set TIRA_DATABASE_URL: at a public address tira keeps everything in Postgres",
    (env.TIRA_SECRET_KEY ?? "").length >= 16 ? "" : "set TIRA_SECRET_KEY to a long random string (at least 16 characters): tira seals everyone's GitHub and Jira tokens with it",
    GITHUB_LOGIN.test(admin) ? "" : "set TIRA_ADMIN to the GitHub login of this tira's owner (the one who can remove an account)",
    env.TIRA_GITHUB_CLIENT_ID?.trim() && env.TIRA_GITHUB_CLIENT_SECRET?.trim() ? "" : "set TIRA_GITHUB_CLIENT_ID and TIRA_GITHUB_CLIENT_SECRET to tira's GitHub app (its callback URL: <your address>/signin/github/callback)",
  ].find((x) => x !== "");
}

// Where tira serve listens: at a public address, on every address at $PORT (the host's) unless
// --port says otherwise; else on this computer only, at --port or 4747. `asked`: the port as given.
export function listenAt(port: string | undefined, env: Env, site: PublicSite | undefined): { host: string; port: number; asked: string | undefined } {
  const asked = port ?? (site ? env.PORT : undefined);
  return { host: site ? "0.0.0.0" : "127.0.0.1", port: asked === undefined ? 4747 : Number(asked), asked };
}

// The page token at a public address: the same on every start and every instance (forms on pages
// left open across a deploy still work), and no one can work it out without TIRA_SECRET_KEY.
export const publicPageToken = (secret: string): string => createHmac("sha256", secret).update("tira page token").digest("hex").slice(0, 48);
