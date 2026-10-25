// tira at a public https address (src/serve/public.ts), and Claude's connectors signing in to it
// with OAuth (src/mcp/oauth.ts).
import "./hermetic.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SqliteEventStore } from "../src/store/sqlite-store.ts";
import { defaultRegistry } from "../src/tables/registry.ts";
import { WritePath } from "../src/write/write-path.ts";
import { tiraServer } from "../src/serve/server.ts";
import { listenAt, publicPageToken, publicProblem, publicSite } from "../src/serve/public.ts";
import { access, appKeys } from "../src/sync/credentials.ts";
import { MemoryAgentTokens } from "../src/mcp/tokens.ts";
import { clientId, clientOf, CLAUDE_CALLBACK, Codes, registered, registrationOf, s256 } from "../src/mcp/oauth.ts";
import { run } from "../src/cli/cli.ts";
import type { GitHubAuthApi } from "../src/auth/github.ts";

const S = "site";
const ORIGIN = "https://tira.example.com";
const HOST = "tira.example.com";
const SECRET = "a-long-random-secret-for-tests";

test("a public address, read: https with no path (http only on this computer); tira refuses to serve it until it's safe, and its page token stays put", () => {
  assert.equal(publicSite({}), undefined);
  assert.deepEqual(publicSite({ TIRA_PUBLIC_URL: "https://tira.example.com/" }), { origin: ORIGIN, host: HOST });
  assert.deepEqual(publicSite({ TIRA_PUBLIC_URL: "http://localhost:4747" }), { origin: "http://localhost:4747", host: "localhost:4747" });
  for (const bad of ["http://tira.example.com", "https://tira.example.com/board", "https://tira.example.com/?x=1", "not a url"]) assert.throws(() => publicSite({ TIRA_PUBLIC_URL: bad }), /TIRA_PUBLIC_URL must be the https address/, bad);
  const ready = { TIRA_PUBLIC_URL: ORIGIN, TIRA_DATABASE_URL: "postgres://db.example/tira?sslmode=require", TIRA_SECRET_KEY: SECRET, TIRA_ADMIN: "isha-gh", TIRA_GITHUB_CLIENT_ID: "gh-id", TIRA_GITHUB_CLIENT_SECRET: "gh-secret" };
  assert.equal(publicProblem(ready, undefined), undefined);
  assert.equal(publicProblem({}, "isha"), undefined); // on this computer: nothing to check
  assert.match(publicProblem(ready, "isha") ?? "", /^at a public address everyone signs in with GitHub: don't set --actor or TIRA_ACTOR$/);
  assert.match(publicProblem({ ...ready, TIRA_DATABASE_URL: undefined }, undefined) ?? "", /^set TIRA_DATABASE_URL/);
  assert.match(publicProblem({ ...ready, TIRA_SECRET_KEY: "short" }, undefined) ?? "", /^set TIRA_SECRET_KEY/);
  assert.match(publicProblem({ ...ready, TIRA_ADMIN: "not a login" }, undefined) ?? "", /^set TIRA_ADMIN/);
  assert.match(publicProblem({ ...ready, TIRA_GITHUB_CLIENT_SECRET: "" }, undefined) ?? "", /^set TIRA_GITHUB_CLIENT_ID and TIRA_GITHUB_CLIENT_SECRET/);
  assert.match(publicProblem({ ...ready, TIRA_PUBLIC_URL: "http://tira.example.com" }, undefined) ?? "", /^TIRA_PUBLIC_URL must be/);
  // where it listens: at a public address on every address, at the host's $PORT unless --port says otherwise
  const site = { origin: ORIGIN, host: HOST };
  assert.deepEqual(listenAt(undefined, { PORT: "10000" }, site), { host: "0.0.0.0", port: 10000, asked: "10000" });
  assert.deepEqual(listenAt("5000", { PORT: "10000" }, site), { host: "0.0.0.0", port: 5000, asked: "5000" });
  assert.deepEqual(listenAt(undefined, { PORT: "10000" }, undefined), { host: "127.0.0.1", port: 4747, asked: undefined }); // this computer: $PORT isn't tira's
  assert.equal(publicPageToken(SECRET), publicPageToken(SECRET));
  assert.match(publicPageToken(SECRET), /^[0-9a-f]{48}$/);
  assert.notEqual(publicPageToken(SECRET), publicPageToken(`${SECRET}-other`));
});

test("tira serve won't start at a public address that isn't safe yet, and says what's missing", async () => {
  const err: string[] = [];
  const code = await run(["--stream", S, "serve"], { out: () => {}, err: (l) => err.push(l), env: { TIRA_PUBLIC_URL: ORIGIN, TIRA_DATABASE_URL: "postgres://db.example/tira?sslmode=require", TIRA_SECRET_KEY: SECRET }, openStore: () => { throw new Error("no store should open"); } });
  assert.equal(code, 1);
  assert.deepEqual(err, ["tira: set TIRA_ADMIN to the GitHub login of this tira's admin (the one who adds people)"]);
});

test("the server's settings name tira's apps and its admin: over what Account settings hold, and only until someone is admin", () => {
  const home = mkdtempSync(join(tmpdir(), "tira-home-"));
  try {
    const env = { TIRA_HOME: home, TIRA_GITHUB_CLIENT_ID: "gh-id", TIRA_GITHUB_CLIENT_SECRET: "gh-secret", TIRA_ATLASSIAN_CLIENT_ID: "at-id", TIRA_ATLASSIAN_CLIENT_SECRET: "at-secret", TIRA_ADMIN: "isha-gh" };
    assert.deepEqual(appKeys(env), { github: { clientId: "gh-id", secret: "gh-secret" }, atlassian: { clientId: "at-id", secret: "at-secret" } });
    assert.deepEqual(appKeys({ TIRA_HOME: home, TIRA_ATLASSIAN_CLIENT_ID: "at-id" }), {}); // an Atlassian app needs its secret too
    assert.deepEqual(access(env), { admin: "isha-gh" });
    assert.deepEqual(access({ TIRA_HOME: home }), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a connector's registration: only Claude's way back or this computer's; its id is the registration, signed; a code works once, for its client, with its verifier", () => {
  assert.deepEqual(registrationOf({ redirect_uris: [CLAUDE_CALLBACK], client_name: "Claude\u0007" }), { client: { redirect_uris: [CLAUDE_CALLBACK], client_name: "Claude" } });
  assert.deepEqual(registrationOf({ redirect_uris: ["http://localhost:3118/callback"] }), { client: { redirect_uris: ["http://localhost:3118/callback"] } });
  const evil = registrationOf({ redirect_uris: ["https://evil.example/cb"] });
  assert.equal("error" in evil ? evil.error : "", "invalid_redirect_uri");
  assert.equal("error" in registrationOf({}), true);
  const client = { redirect_uris: [CLAUDE_CALLBACK, "http://127.0.0.1:5000/callback"] };
  const id = clientId(SECRET, client);
  assert.deepEqual(clientOf(SECRET, id), client);
  assert.equal(clientOf("another-secret-entirely", id), undefined); // made by another tira
  assert.equal(clientOf(SECRET, id.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")), undefined); // signature changed
  assert.ok(registered(client, "http://127.0.0.1:61234/callback")); // this computer's, on any port
  assert.ok(!registered(client, "http://127.0.0.1:61234/other"));
  assert.ok(!registered(client, "https://claude.ai/api/mcp/other"));
  const codes = new Codes();
  const verifier = "v".repeat(43);
  const asking = { client_id: id, client, redirect_uri: CLAUDE_CALLBACK, challenge: s256(verifier) };
  const exchange = (code: string, extra: Record<string, string> = {}) => codes.exchange(new URLSearchParams({ grant_type: "authorization_code", code, client_id: id, redirect_uri: CLAUDE_CALLBACK, code_verifier: verifier, ...extra }));
  const grant = { project: S, agent: "claude", login: "isha-gh" };
  assert.deepEqual(exchange(codes.issue(asking, grant)), { grant });
  const once = codes.issue(asking, grant);
  assert.equal((exchange(once, { code_verifier: "w".repeat(43) }) as { error: string }).error, "invalid_grant");
  assert.equal((exchange(once) as { error: string }).error, "invalid_grant"); // gone after a wrong try
  assert.equal((exchange(codes.issue(asking, grant), { client_id: "tc_other.x" }) as { error: string }).error, "invalid_grant");
  assert.equal((exchange(codes.issue(asking, grant), { redirect_uri: "http://localhost/callback" }) as { error: string }).error, "invalid_grant");
  assert.equal((codes.exchange(new URLSearchParams({ grant_type: "refresh_token" })) as { error: string }).error, "unsupported_grant_type");
});

// GitHub's one-click sign-in, as a stand-in: GitHub says whoever `login` is signed in
class FakeGitHub implements GitHubAuthApi {
  login = "isha-gh";
  authorizeUrl(clientId: string, redirectUri: string, state: string) {
    return `https://github.example/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  }
  async exchange(_clientId: string, secret: string, code: string) {
    if (secret !== "gh-secret" || code !== "gh-code") throw new Error("GitHub said no");
    return `gho-${this.login}`;
  }
  async start(): Promise<never> {
    throw new Error("a public tira signs in the one-click way");
  }
  async poll(): Promise<never> {
    throw new Error("a public tira signs in the one-click way");
  }
  async user(token: string) {
    return { login: token.replace(/^gho-/, "") };
  }
  async repos() {
    return [];
  }
}

// tira serve at https://tira.example.com (behind its host's TLS: tests reach it over plain http,
// with that Host and that Origin, as the host's proxy passes them on)
async function hosted() {
  const store = new SqliteEventStore();
  const registry = defaultRegistry();
  const wp = new WritePath(store, registry);
  await wp.submit({ stream: S, kind: "create", entity: { type: "node", id: "header" }, actor: "isha-gh", payload: {} });
  const home = mkdtempSync(join(tmpdir(), "tira-home-"));
  const env = { TIRA_HOME: home, TIRA_ADMIN: "isha-gh", TIRA_GITHUB_CLIENT_ID: "gh-id", TIRA_GITHUB_CLIENT_SECRET: "gh-secret", TIRA_SECRET_KEY: SECRET };
  const github = new FakeGitHub();
  const tokens = new MemoryAgentTokens();
  const server = tiraServer({ store, registry, stream: S, token: publicPageToken(SECRET), site: { origin: ORIGIN, host: HOST }, links: { githubAuth: github, env, agentTokens: tokens } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const jar = new Map<string, string>();
  type Answer = { status: number; body: string; headers: Record<string, string | string[] | undefined> };
  const http = (method: string, path: string, o: { body?: string; type?: string; host?: string; origin?: string } = {}) => new Promise<Answer>((resolve, reject) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { host: o.host ?? HOST, ...(cookie ? { cookie } : {}), ...(o.body !== undefined ? { "content-type": o.type ?? "application/x-www-form-urlencoded" } : {}), ...(o.origin ? { origin: o.origin } : {}) };
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        for (const c of [res.headers["set-cookie"] ?? []].flat()) {
          const [kv = ""] = c.split(";");
          const [k = "", v = ""] = kv.split("=");
          if (/Max-Age=0/.test(c)) jar.delete(k);
          else jar.set(k, v);
        }
        resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(o.body);
  });
  const form = (path: string, fields: Record<string, string>) => http("POST", path, { body: new URLSearchParams({ token: publicPageToken(SECRET), ...fields }).toString(), origin: ORIGIN });
  // sign in the one-click way, as GitHub's `login`
  const signIn = async (login = "isha-gh") => {
    github.login = login;
    const started = await form("/signin/start", {});
    const state = /[?&]state=([0-9a-f]+)/.exec(String(started.headers.location))?.[1] ?? "";
    return { started, done: await http("GET", `/signin/github/callback?code=gh-code&state=${state}`) };
  };
  return { store, tokens, port, http, form, signIn, jar, done: async () => { await new Promise<void>((r) => server.close(() => r())); rmSync(home, { recursive: true, force: true }); } };
}

test("at its public address: tira answers only that address (its host's check too), keeps browsers to https, sends GitHub sign-in back there, marks cookies Secure, and reads nothing out to someone signed out", async () => {
  const t = await hosted();
  try {
    const front = await t.http("GET", "/");
    assert.deepEqual([front.status, front.headers.location], [303, "/welcome"]);
    assert.equal(front.headers["strict-transport-security"], "max-age=31536000");
    const elsewhere = await t.http("GET", "/", { host: "evil.example" });
    assert.deepEqual([elsewhere.status, elsewhere.body], [403, "tira answers at https://tira.example.com only\n"]);
    assert.deepEqual([(await t.http("GET", "/healthz", { host: "10.0.0.5:10000" })).status, (await t.http("GET", "/healthz")).body], [200, "ok\n"]);
    // nothing to set up for whoever arrives first: GitHub sign-in is the server's
    const landing = (await t.http("GET", "/welcome")).body;
    assert.match(landing, /data-signin-start/);
    assert.doesNotMatch(landing, /data-setup-github/);
    for (const path of ["/api/tasks", "/api/workspaces", "/api/live"]) assert.equal((await t.http("GET", path)).status, 401, path);
    // a write from the http address isn't this page's
    assert.equal((await t.http("POST", "/signin/start", { body: `token=${publicPageToken(SECRET)}`, origin: `http://${HOST}` })).status, 403);
    const { started, done } = await t.signIn();
    assert.match(String(started.headers.location), /redirect_uri=https%3A%2F%2Ftira\.example\.com%2Fsignin%2Fgithub%2Fcallback/);
    assert.match(String(started.headers["set-cookie"]), /^tira_signin=[0-9a-f]+; HttpOnly; SameSite=Lax; Path=\/signin; Max-Age=600; Secure$/);
    assert.match(String(done.headers["set-cookie"]), /^tira_session=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000; Secure$/);
    assert.equal((await t.http("GET", "/api/tasks")).status, 200);
    // a way on after sign-in is only ever Claude's approval page
    t.jar.clear();
    t.jar.set("tira_next", encodeURIComponent("https://evil.example/"));
    assert.equal((await t.signIn()).done.headers.location?.toString().startsWith("/connect?r="), true);
    // the admin is the one the server names: someone else signing in first doesn't become it
    t.jar.clear();
    const stranger = (await t.signIn("mallory")).done;
    assert.match(String(stranger.headers.location), /^\/welcome\?r=\d+$/);
    assert.equal(stranger.headers["set-cookie"], undefined);
  } finally {
    await t.done();
  }
});

test("Claude's connector signs in: discovery, registration, the person's approval (after signing in), and the code's exchange for the agent's own token, which /mcp takes until the agent is revoked", async () => {
  const t = await hosted();
  try {
    // discovery, and the 401 that points at it
    assert.deepEqual(JSON.parse((await t.http("GET", "/.well-known/oauth-protected-resource/mcp")).body), { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], bearer_methods_supported: ["header"], resource_name: "tira" });
    const as = JSON.parse((await t.http("GET", "/.well-known/oauth-authorization-server")).body) as Record<string, unknown>;
    assert.deepEqual([as.issuer, as.authorization_endpoint, as.token_endpoint, as.registration_endpoint, as.code_challenge_methods_supported, as.token_endpoint_auth_methods_supported], [ORIGIN, `${ORIGIN}/oauth/authorize`, `${ORIGIN}/oauth/token`, `${ORIGIN}/oauth/register`, ["S256"], ["none"]]);
    const anonymous = await t.http("POST", "/mcp", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), type: "application/json" });
    assert.deepEqual([anonymous.status, anonymous.headers["www-authenticate"]], [401, `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`]);
    // registration
    assert.equal((await t.http("POST", "/oauth/register", { body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }), type: "application/json" })).status, 400);
    const reg = await t.http("POST", "/oauth/register", { body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name: "Claude" }), type: "application/json" });
    assert.equal(reg.status, 201);
    const { client_id: id } = JSON.parse(reg.body) as { client_id: string };
    // asking: signed out, sign in first and come back here
    const verifier = "x".repeat(50);
    const ask = new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: CLAUDE_CALLBACK, code_challenge: s256(verifier), code_challenge_method: "S256", state: "st-1", resource: `${ORIGIN}/mcp` });
    const out = await t.http("GET", `/oauth/authorize?${ask}`);
    assert.equal(out.status, 303);
    assert.match(String(out.headers.location), /^\/welcome\?r=\d+$/);
    assert.match(String(out.headers["set-cookie"]), /^tira_next=%2Foauth%2Fauthorize%3F[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600; Secure$/);
    const { done } = await t.signIn();
    assert.equal(done.headers.location, `/oauth/authorize?${ask}`);
    // the approval: who asked, the project, the agent's name; a form that may go back to Claude
    const page = await t.http("GET", `/oauth/authorize?${ask}`);
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /form-action 'self' https:\/\/claude\.ai;/);
    assert.match(page.body, /<p class="land-foot" data-consent-who><b>Claude<\/b> wants to work in tira as an agent\.<\/p>/);
    assert.match(page.body, /<select name="project" required><option value="site" selected>site<\/option><\/select>/);
    assert.match(page.body, /<input type="text" name="agent" value="claude"/);
    // what Claude asked for wrongly: shown here, or sent back to Claude
    assert.equal((await t.http("GET", `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(ask), client_id: "tc_x.y" })}`)).status, 400);
    const noPkce = await t.http("GET", `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(ask), code_challenge_method: "plain" })}`);
    assert.match(String(noPkce.headers.location), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=invalid_request&error_description=[^&]+&state=st-1$/);
    const elsewhere = await t.http("GET", `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(ask), resource: "https://other.example/mcp" })}`);
    assert.match(String(elsewhere.headers.location), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=invalid_target&/);
    const fields = Object.fromEntries(ask);
    const no = await t.form("/oauth/authorize", { ...fields, decision: "cancel" });
    assert.match(String(no.headers.location), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=access_denied&error_description=[^&]+&state=st-1$/);
    const person = await t.form("/oauth/authorize", { ...fields, decision: "allow", project: S, agent: "isha" });
    assert.equal(person.status, 422);
    assert.match(person.body, /reads as a person(?:'|&#39;)s name/);
    // allowed: a one-time code, back to Claude
    const approve = async () => {
      const yes = await t.form("/oauth/authorize", { ...fields, decision: "allow", project: S, agent: "claude" });
      const back = new URL(String(yes.headers.location));
      assert.deepEqual([yes.status, back.origin + back.pathname, back.searchParams.get("state"), back.searchParams.get("iss")], [303, CLAUDE_CALLBACK, "st-1", ORIGIN]);
      return back.searchParams.get("code") ?? "";
    };
    const swap = (code: string, v = verifier) => t.http("POST", "/oauth/token", { body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: id, redirect_uri: CLAUDE_CALLBACK, code_verifier: v }).toString() });
    const wrong = await swap(await approve(), "y".repeat(50));
    assert.deepEqual([wrong.status, (JSON.parse(wrong.body) as { error: string }).error], [400, "invalid_grant"]);
    assert.deepEqual(await t.tokens.list(S), []); // nothing connected until a code is exchanged
    const swapped = await swap(await approve());
    assert.equal(swapped.status, 200);
    const { access_token: token, token_type } = JSON.parse(swapped.body) as { access_token: string; token_type: string };
    assert.equal(token_type, "Bearer");
    const [agent] = await t.tokens.list(S);
    assert.deepEqual([agent?.agent, agent?.app, agent?.createdBy], ["claude", "claude-connector", "isha-gh"]);
    // the token is the agent's: /mcp takes it, as that agent, in that project
    const client = new Client({ name: "claude-connector-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${t.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const next = ((await client.callTool({ name: "next_task", arguments: {} })).content as { text?: string }[])[0]?.text ?? "";
    assert.match(next, /Next: header/);
    await client.close();
    // a second connection gets a name of its own; revoking one ends its token
    await swap(await approve());
    assert.deepEqual((await t.tokens.list(S)).map((x) => x.agent), ["claude", "claude-2"]);
    await t.tokens.revoke(agent?.id ?? "");
    assert.equal((await t.http("POST", "/mcp", { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), type: "application/json" })).status, 401);
    // Project settings: Claude by its Connectors, with tira's address; no local Claude Desktop entry here
    const settings = (await t.http("GET", "/integrations")).body;
    assert.match(settings, /<div class="agent-connector" data-agent-connector>[^]*?<pre class="agent-code" id="agent-connector-url">https:\/\/tira\.example\.com\/mcp<\/pre>/);
    assert.doesNotMatch(settings, /data-agent-tile="claude-desktop"|data-agent-database/);
    assert.match(settings, /<b>claude-2<\/b><small>Claude(?:'|&#39;)s Connectors · tira_/);
  } finally {
    await t.done();
  }
});

test("on this computer there's no OAuth: the discovery and approval addresses aren't tira's", async () => {
  const store = new SqliteEventStore();
  const server = tiraServer({ store, registry: defaultRegistry(), stream: S, actor: "isha", token: "k", links: { env: {} } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/oauth/authorize?client_id=x"]) {
      assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 404, path);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
