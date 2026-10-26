// Sign in with GitHub, two ways to the same token. Directly (OAuth's web flow), once tira's app has
// its secret: GitHub's own page asks the person to approve tira and sends them back with a one-time
// code, which tira trades, with the secret, for a token. Or, with no secret, by GitHub's device
// flow: tira asks GitHub for a short code, the person approves it at github.com/login/device, and
// tira polls until GitHub hands over a token. The token then lists the person's repos (to link one)
// and reads pull requests (to sync), as them. https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
import { repoVia, taskCommitsVia, type GitHubClient, type Pull } from "../sync/github.ts";

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
const realFetch = fetch as unknown as Fetch;

// read:user to know who signed in; repo to read pull requests in private repos too
export const GITHUB_SCOPES = "read:user repo";

export interface DeviceStart { deviceCode: string; userCode: string; verifyAt: string; interval: number; expiresIn: number }
export type DevicePoll = { token: string } | { wait: number } | { failed: string };

export interface GitHubAuthApi {
  // the direct way: GitHub's page. pickAccount: GitHub shows its account picker, so someone already
  // signed in there (who approved tira before) can pick another account, as signing up needs
  authorizeUrl(clientId: string, redirectUri: string, state: string, pickAccount?: boolean): string;
  exchange(clientId: string, secret: string, code: string, redirectUri: string): Promise<string>; // its code, for a token
  start(clientId: string): Promise<DeviceStart>;
  poll(clientId: string, deviceCode: string): Promise<DevicePoll>;
  user(token: string): Promise<{ login: string; name?: string; email?: string }>; // email: the one their profile shows, if any
  repos(token: string): Promise<string[]>; // owner/name, most recently updated first
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FAILED: Record<string, string> = {
  expired_token: "the code expired: start again",
  access_denied: "you turned it down on GitHub",
  device_flow_disabled: "device sign-in is off for tira's GitHub app: tick Enable Device Flow in its settings",
  incorrect_client_credentials: "GitHub doesn't know tira's app: check its Client ID and secret",
  bad_verification_code: "GitHub's code was used or too old: sign in again",
  redirect_uri_mismatch: "tira's GitHub app doesn't send people back here: set its callback URL to this address",
  incorrect_device_code: "GitHub didn't know that code: start again",
};

export class GitHubDevice implements GitHubAuthApi {
  private readonly fetchFn: Fetch;
  private readonly web: string;
  private readonly api: string;

  constructor(fetchFn: Fetch = realFetch, web = "https://github.com", api = "https://api.github.com") {
    this.fetchFn = fetchFn;
    this.web = web;
    this.api = api;
  }

  private async post(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`${this.web}${path}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form(body) });
    if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  authorizeUrl(clientId: string, redirectUri: string, state: string, pickAccount = false): string {
    return `${this.web}/login/oauth/authorize?${form({ client_id: clientId, redirect_uri: redirectUri, scope: GITHUB_SCOPES, state, ...(pickAccount ? { prompt: "select_account" } : {}) })}`;
  }

  async exchange(clientId: string, secret: string, code: string, redirectUri: string): Promise<string> {
    const r = await this.post("/login/oauth/access_token", { client_id: clientId, client_secret: secret, code, redirect_uri: redirectUri });
    if (typeof r.access_token === "string") return r.access_token;
    const error = typeof r.error === "string" ? r.error : "no";
    throw new Error(FAILED[error] ?? `GitHub said ${error}`);
  }

  async start(clientId: string): Promise<DeviceStart> {
    const r = await this.post("/login/device/code", { client_id: clientId, scope: GITHUB_SCOPES });
    if (typeof r.error === "string") throw new Error(FAILED[r.error] ?? `GitHub said ${r.error}`);
    return {
      deviceCode: String(r.device_code), userCode: String(r.user_code), verifyAt: String(r.verification_uri ?? `${this.web}/login/device`),
      interval: Number(r.interval ?? 5), expiresIn: Number(r.expires_in ?? 900),
    };
  }

  async poll(clientId: string, deviceCode: string): Promise<DevicePoll> {
    const r = await this.post("/login/oauth/access_token", { client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    if (typeof r.access_token === "string") return { token: r.access_token };
    if (r.error === "authorization_pending") return { wait: 0 };
    if (r.error === "slow_down") return { wait: Number(r.interval ?? 10) };
    return { failed: FAILED[String(r.error)] ?? `GitHub said ${String(r.error ?? "no")}` };
  }

  private async get(token: string, path: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.api}${path}`, { method: "GET", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } });
    if (!res.ok) throw new Error(`GitHub ${path.split("?")[0]}: ${res.status}`);
    return res.json();
  }

  async user(token: string): Promise<{ login: string; name?: string; email?: string }> {
    const u = (await this.get(token, "/user")) as { login?: string; name?: string | null; email?: string | null };
    if (typeof u.login !== "string") throw new Error("GitHub didn't say who signed in");
    return { login: u.login, ...(u.name ? { name: u.name } : {}), ...(typeof u.email === "string" && u.email ? { email: u.email } : {}) };
  }

  async repos(token: string): Promise<string[]> {
    const list = (await this.get(token, "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member")) as { full_name?: string }[];
    return list.flatMap((r) => (typeof r.full_name === "string" ? [r.full_name] : []));
  }

  // Pull requests read with the person's own token (the sync's GitHub side once they've signed in).
  pullsAs(token: string, limit = 50): GitHubClient {
    const get = (path: string) => this.get(token, `/${path}`);
    return {
      taskCommits: (repo, task, linked) => taskCommitsVia(get, repo, task, linked),
      ...repoVia(get),
      pulls: async (repo: string): Promise<Pull[]> => {
        const raw = (await this.get(token, `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${limit}`)) as { number: number; title?: string; body?: string | null; html_url: string; state: string; merged_at?: string | null; head?: { ref?: string } }[];
        return Promise.all(raw.map(async (p) => {
          const commits = (await this.get(token, `/repos/${repo}/pulls/${p.number}/commits?per_page=100`)) as { sha?: string; commit?: { message?: string } }[];
          return {
            number: p.number, title: p.title ?? "", body: p.body ?? "", branch: p.head?.ref ?? "", url: p.html_url,
            state: p.state === "open" ? "open" as const : "closed" as const,
            ...(p.merged_at ? { mergedAt: p.merged_at } : {}),
            commits: commits.map((c) => c.commit?.message ?? ""),
            shas: commits.map((c) => c.sha ?? ""),
          };
        }));
      },
    };
  }
}
