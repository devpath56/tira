// People's accounts in Postgres (src/sync/accounts-pg.ts, through src/sync/credentials.ts): sealed
// with $TIRA_SECRET_KEY, shared by every computer on the database, links kept until their owner
// unlinks them. The sealing and the refusals run everywhere; the database itself when TIRA_PG_URL
// names one (CI sets it).
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AccountsRefused, PostgresAccounts, sealer } from "../src/sync/accounts-pg.ts";
import {
  access, appKeys, atlassianAuth, closeAccounts, displayName, forgetGithub, githubAuth, importAccountsFile, postgresAccounts, refreshAccounts,
  saveAccess, saveAppKeys, saveAtlassianAuth, saveDisplayName, saveGithubAuth, saveSession, sessionLogin, signOutEverywhere,
} from "../src/sync/credentials.ts";
import { DatabaseRefused } from "../src/store/open.ts";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { tiraServer } from "../src/serve/server.ts";
import type { GitHubAuthApi } from "../src/auth/github.ts";

const KEY = "a long random test key, never a real one";
const home = () => mkdtempSync(join(tmpdir(), "tira-accounts-"));

test("a seal opens only with its key, on its own row, untouched; and never shows what it holds", () => {
  const k = sealer(KEY);
  const sealed = k.seal("gho-secret-token", "github:isha");
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.doesNotMatch(sealed, /gho-secret-token/);
  assert.notEqual(k.seal("gho-secret-token", "github:isha"), sealed); // a fresh nonce each time
  assert.equal(k.open(sealed, "github:isha"), "gho-secret-token");
  assert.throws(() => k.open(sealed, "github:octo"), AccountsRefused); // moved onto someone else's row
  assert.throws(() => sealer("another long random key, not the same").open(sealed, "github:isha"), AccountsRefused);
  const [v, iv, tag, body] = sealed.split(".");
  const flipped = `${v}.${iv}.${tag}.${(body ?? "").startsWith("A") ? "B" : "A"}${(body ?? "").slice(1)}`;
  assert.throws(() => k.open(flipped, "github:isha"), AccountsRefused); // changed in the database
  assert.throws(() => sealer(undefined), /set TIRA_SECRET_KEY/);
  assert.throws(() => sealer("too short"), /at least 16 characters/);
});

test("accounts go where tira's data goes: a file with no database; Postgres refused without a key or, off this machine, without TLS", () => {
  assert.equal(postgresAccounts({ TIRA_HOME: home() }), undefined);
  assert.throws(() => postgresAccounts({ TIRA_DATABASE_URL: "postgres://tira@127.0.0.1:5432/tira" }), /set TIRA_SECRET_KEY/);
  assert.throws(() => postgresAccounts({ TIRA_DATABASE_URL: "postgres://tira@db.example.com/tira", TIRA_SECRET_KEY: KEY }), DatabaseRefused);
  // tira serve won't start on Postgres without the key
  assert.throws(() => tiraServer({ store: new SqliteEventStore(), registry: defaultRegistry(), stream: "s", token: "k", links: { env: { TIRA_DATABASE_URL: "postgres://tira@127.0.0.1:5432/tira" } } }), /set TIRA_SECRET_KEY/);
});

test("a session lasts 30 days, like its cookie", async () => {
  const env = { TIRA_HOME: home() };
  await saveSession("fresh", "isha", env);
  assert.equal(sessionLogin("fresh", env), "isha");
  const file = join(env.TIRA_HOME, "credentials.json");
  const s = JSON.parse(readFileSync(file, "utf8")) as { sessions: Record<string, { login: string; at: string }> };
  for (const v of Object.values(s.sessions)) v.at = new Date(Date.now() - 31 * 86_400_000).toISOString();
  writeFileSync(file, JSON.stringify(s));
  assert.equal(sessionLogin("fresh", env), undefined);
});

const url = process.env.TIRA_PG_URL;
const fresh = () => `accounts_${randomBytes(4).toString("hex")}`;
const pgEnv = (schema: string, h = home()) => ({ TIRA_HOME: h, TIRA_DATABASE_URL: url, TIRA_SCHEMA: schema, TIRA_SECRET_KEY: KEY });

if (!url) {
  test("postgres: the accounts tests", { skip: "set TIRA_PG_URL to a Postgres database to run these (CI does)" }, () => {});
} else {
  test("postgres: every account kept in the database, sealed; nothing in this computer's file", async () => {
    const env = pgEnv(fresh());
    try {
      await saveAppKeys({ github: { clientId: "Iv1.gh", secret: "gh-secret-1" }, atlassian: { clientId: "at-id", secret: "SECRET-xyz" } }, env);
      await saveGithubAuth("isha-gh", { token: "gho-token-1", name: "Isha" }, env);
      await saveAtlassianAuth("isha-gh", { access: "at-token", refresh: "rt-token", expiresAt: 1, site: "https://acme.atlassian.net", cloudId: "c1" }, env);
      await saveAccess(() => ({ admin: "isha-gh", members: ["octo"], contact: { name: "Isha", email: "isha@example.com" } }), env);
      await saveDisplayName("isha-gh", "Isha M", env);
      await saveSession("session-1", "isha-gh", env);
      await refreshAccounts(env);
      assert.deepEqual(appKeys(env), { github: { clientId: "Iv1.gh", secret: "gh-secret-1" }, atlassian: { clientId: "at-id", secret: "SECRET-xyz" } });
      assert.deepEqual(githubAuth("isha-gh", env), { token: "gho-token-1", name: "Isha" });
      assert.equal(atlassianAuth("isha-gh", env)?.refresh, "rt-token");
      assert.deepEqual(access(env), { admin: "isha-gh", members: ["octo"], contact: { name: "Isha", email: "isha@example.com" } });
      assert.equal(displayName("isha-gh", env), "Isha M");
      assert.equal(sessionLogin("session-1", env), "isha-gh");
      // in the database, every token and secret is sealed; the session is a hash
      const pg = postgresAccounts(env) as PostgresAccounts;
      const raw = JSON.stringify([
        ...(await pg.query(`SELECT * FROM ${env.TIRA_SCHEMA}.account_apps`)).rows, ...(await pg.query(`SELECT * FROM ${env.TIRA_SCHEMA}.account_github`)).rows,
        ...(await pg.query(`SELECT * FROM ${env.TIRA_SCHEMA}.account_atlassian`)).rows, ...(await pg.query(`SELECT * FROM ${env.TIRA_SCHEMA}.account_sessions`)).rows,
      ]);
      assert.doesNotMatch(raw, /SECRET-xyz|gh-secret-1|gho-token-1|at-token|rt-token|session-1/);
      // saving the Client ID alone keeps the secret
      await saveAppKeys({ github: { clientId: "Iv1.gh2" } }, env);
      assert.deepEqual(appKeys(env).github, { clientId: "Iv1.gh2", secret: "gh-secret-1" });
      assert.match(raw, /"token":"v1\./);
      // and this computer's file holds none of it
      let file = "";
      try {
        file = readFileSync(join(env.TIRA_HOME, "credentials.json"), "utf8");
      } catch {
        // no file at all: nothing in it
      }
      assert.doesNotMatch(file, /gho-token-1|SECRET-xyz|isha-gh/);
    } finally {
      await closeAccounts();
    }
  });

  test("postgres: two computers on one database see each other's changes; a different key opens nothing; a token moved onto another row is refused", async () => {
    const schema = fresh();
    const env = pgEnv(schema);
    const other = new PostgresAccounts(url, schema, KEY); // another computer
    try {
      await saveGithubAuth("isha-gh", { token: "gho-isha" }, env);
      await saveAccess(() => ({ admin: "isha-gh" }), env);
      await other.refresh();
      assert.equal(other.snapshot().github?.["isha-gh"]?.token, "gho-isha");
      await other.saveAccess((a) => ({ ...a, members: [...(a.members ?? []), "octo"] }));
      await refreshAccounts(env);
      assert.deepEqual(access(env).members, ["octo"]);
      // two admins adding people at the same moment: both added
      await Promise.all([saveAccess((a) => ({ ...a, members: [...(a.members ?? []), "ana"] }), env), other.saveAccess((a) => ({ ...a, members: [...(a.members ?? []), "raj"] }))]);
      await refreshAccounts(env);
      assert.deepEqual([...(access(env).members ?? [])].sort(), ["ana", "octo", "raj"]);
      await assert.rejects(new PostgresAccounts(url, schema, "another long random key, not this one").refresh(), /doesn't open the accounts/);
      // someone with the database but not the key swaps two people's tokens: refused, not used
      await saveGithubAuth("octo", { token: "gho-octo" }, env);
      await other.query(`UPDATE ${schema}.account_github SET token = (SELECT token FROM ${schema}.account_github WHERE login = 'isha-gh') WHERE login = 'octo'`);
      await assert.rejects(refreshAccounts(env), /doesn't open the accounts \(github:octo\)/);
    } finally {
      await other.close();
      await closeAccounts();
    }
  });

  test("postgres: removing someone ends their sessions and keeps their links; only they unlink GitHub; a session lasts 30 days", async () => {
    const schema = fresh();
    const env = pgEnv(schema);
    try {
      await saveGithubAuth("octo", { token: "gho-octo" }, env);
      await saveAtlassianAuth("octo", { access: "a", expiresAt: 1 }, env);
      await saveSession("octo-session", "octo", env);
      await signOutEverywhere("OCTO", env); // GitHub logins, without regard to case
      assert.equal(sessionLogin("octo-session", env), undefined);
      assert.equal(githubAuth("octo", env)?.token, "gho-octo");
      assert.equal(atlassianAuth("octo", env)?.access, "a");
      await saveSession("octo-session", "octo", env);
      await forgetGithub("octo", env);
      assert.equal(githubAuth("octo", env), undefined);
      assert.equal(sessionLogin("octo-session", env), undefined);
      assert.equal(atlassianAuth("octo", env)?.access, "a"); // Jira is unlinked on its own
      await saveSession("old", "octo", env);
      await (postgresAccounts(env) as PostgresAccounts).query(`UPDATE ${schema}.account_sessions SET at = now() - interval '31 days'`);
      await refreshAccounts(env);
      assert.equal(sessionLogin("old", env), undefined);
    } finally {
      await closeAccounts();
    }
  });

  test("postgres: this computer's old file is brought over once: what the database lacks, never over what it holds", async () => {
    const schema = fresh();
    const env = pgEnv(schema);
    writeFileSync(join(env.TIRA_HOME, "credentials.json"), JSON.stringify({
      apps: { github: { clientId: "Iv1.old" } },
      access: { admin: "isha-gh", members: ["octo"] },
      github: { "isha-gh": { token: "gho-old", name: "Isha" }, octo: { token: "gho-octo-old" } },
      atlassian: { "isha-gh": { access: "at-old", expiresAt: 1 } },
      names: { "isha-gh": "Isha M" },
      sessions: { abc: { login: "isha-gh", at: new Date().toISOString() } },
      pageToken: "f".repeat(48),
    }));
    try {
      await saveGithubAuth("octo", { token: "gho-octo-new" }, env); // already in the database: kept
      assert.deepEqual(await importAccountsFile(env), { apps: true, access: true, github: 1, atlassian: 1, names: 1, sessions: 1 });
      assert.deepEqual(await importAccountsFile(env), { apps: false, access: false, github: 0, atlassian: 0, names: 0, sessions: 0 });
      assert.equal(githubAuth("isha-gh", env)?.token, "gho-old");
      assert.equal(githubAuth("octo", env)?.token, "gho-octo-new");
      assert.deepEqual(access(env), { admin: "isha-gh", members: ["octo"] });
      assert.equal(displayName("isha-gh", env), "Isha M");
    } finally {
      await closeAccounts();
    }
  });

  test("postgres: account tables made before tira's GitHub app kept a secret get its column on first use, and the secret is sealed", async () => {
    const schema = fresh();
    const before = new PostgresAccounts(url, schema, KEY);
    let after: PostgresAccounts | undefined;
    try {
      await before.saveApps({ github: { clientId: "Iv1.gh" } });
      await before.query(`ALTER TABLE ${schema}.account_apps DROP COLUMN github_secret`); // as the tables were made on 2026-10-22
      after = new PostgresAccounts(url, schema, KEY);
      await after.saveApps({ github: { clientId: "Iv1.gh", secret: "gh-secret-2" } });
      assert.deepEqual(after.snapshot().apps?.github, { clientId: "Iv1.gh", secret: "gh-secret-2" });
      const raw = JSON.stringify((await after.query(`SELECT github_secret FROM ${schema}.account_apps`)).rows);
      assert.match(raw, /v1\./);
      assert.doesNotMatch(raw, /gh-secret-2/);
    } finally {
      await after?.close();
      await before.close();
    }
  });

  test("postgres: a login that may use the account tables but create nothing works once the owner has made them (production's least-privilege tira login)", async () => {
    const schema = fresh();
    const owner = new PostgresAccounts(url, schema, KEY);
    const role = `tira_acc_${randomBytes(3).toString("hex")}`;
    let limited: PostgresAccounts | undefined;
    try {
      await owner.refresh(); // the owner's first run makes the tables
      await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'a test-only password'`);
      await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
      const u = new URL(url);
      u.username = role;
      u.password = "a test-only password";
      limited = new PostgresAccounts(u.toString(), schema, KEY);
      await limited.saveGithub("isha-gh", { token: "gho-limited" });
      assert.equal(limited.snapshot().github?.["isha-gh"]?.token, "gho-limited");
    } finally {
      await limited?.close();
      await owner.query(`DROP OWNED BY ${role}`).catch(() => {});
      await owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      await owner.close();
    }
  });

  test("postgres: two people's tira serve on one database: a sign-in on one computer, the people list from the other", async () => {
    const schema = fresh();
    class FakeGitHub implements GitHubAuthApi {
      authorizeUrl() { return "https://github.example/authorize"; }
      async exchange() { return "gho-token"; }
      async start() { return { deviceCode: "d", userCode: "ABCD-1234", verifyAt: "https://github.com/login/device", interval: 0, expiresIn: 900 }; }
      async poll() { return { token: "gho-token" }; }
      async user() { return { login: "isha-gh", name: "Isha" }; }
      async repos() { return ["acme/app"]; }
    }
    const serve = async (env: Record<string, string | undefined>) => {
      const server = tiraServer({ store: new SqliteEventStore(), registry: defaultRegistry(), stream: "s", token: "k", links: { githubAuth: new FakeGitHub(), env } });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as AddressInfo).port;
      const http = (method: string, path: string, body?: string, cookie?: string) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `localhost:${port}`, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
        });
        req.on("error", reject);
        req.end(body);
      });
      return { server, http };
    };
    const a = await serve(pgEnv(schema));
    const b = await serve(pgEnv(schema)); // another computer: its own folder, the same database
    try {
      await a.http("POST", "/integrations/setup", "token=k&github_client_id=Iv1.gh&back=%2Fwelcome");
      const id = /name="id" value="([0-9a-f]+)"/.exec((await a.http("POST", "/signin/start", "token=k")).body)?.[1] ?? "";
      const done = await a.http("POST", "/signin/poll", `token=k&id=${id}&fragment=1`);
      const cookie = String(done.headers["set-cookie"]).split(";")[0] ?? "";
      assert.match(cookie, /^tira_session=[0-9a-f]{64}$/);
      // the same session works on the other computer: the sign-in is in the database
      assert.equal((await b.http("GET", "/settings", undefined, cookie)).status, 200);
      // the admin adds someone on one computer; the other shows them
      await b.http("POST", "/integrations/people", "token=k&do=add&login=octo", cookie);
      assert.match((await a.http("GET", "/settings", undefined, cookie)).body, /<span class="grp-k">octo<\/span>/);
      // a change from a computer with its own connection shows on the next page here too
      const elsewhere = new PostgresAccounts(url, schema, KEY);
      await elsewhere.saveAccess((x) => ({ ...x, members: [...(x.members ?? []), "zed"] }));
      await elsewhere.close();
      assert.match((await a.http("GET", "/settings", undefined, cookie)).body, /<span class="grp-k">zed<\/span>/);
    } finally {
      await new Promise<void>((r) => a.server.close(() => r()));
      await new Promise<void>((r) => b.server.close(() => r()));
      await closeAccounts();
    }
  });
}
