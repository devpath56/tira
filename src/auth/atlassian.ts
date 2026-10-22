// Sign in with Atlassian (OAuth 2.0 three-legged, "3LO"), so tira can list a person's Jira sites
// and projects and act in Jira as them. The person approves tira's app on Atlassian; Atlassian
// sends them back with a code, which tira trades (with its app's secret, kept in the private
// store) for an access token and a refresh token. Refresh tokens rotate: each use returns a new
// one, which is saved at once. https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
import { JiraRest, type JiraClient } from "../sync/jira.ts";
import type { AtlassianAuth } from "../sync/credentials.ts";
import type { Fetch } from "./github.ts";

const realFetch = fetch as unknown as Fetch;

// read and write issues and projects, know who signed in, and stay signed in (a refresh token)
export const ATLASSIAN_SCOPES = "read:jira-work write:jira-work read:jira-user offline_access";

export interface AtlassianKeys { clientId: string; secret: string }
export interface JiraSite { id: string; url: string; name: string }

export interface AtlassianAuthApi {
  authorizeUrl(clientId: string, redirectUri: string, state: string): string;
  exchange(keys: AtlassianKeys, code: string, redirectUri: string): Promise<AtlassianAuth>;
  sites(access: string): Promise<JiraSite[]>;
  // Jira as the person, on the site their sign-in picked; `save` keeps each rotated token
  jira(keys: AtlassianKeys, auth: AtlassianAuth, save: (next: AtlassianAuth) => void | Promise<void>): JiraClient;
}

export class AtlassianOAuth implements AtlassianAuthApi {
  private readonly fetchFn: Fetch;
  private readonly authBase: string;
  private readonly apiBase: string;

  constructor(fetchFn: Fetch = realFetch, authBase = "https://auth.atlassian.com", apiBase = "https://api.atlassian.com") {
    this.fetchFn = fetchFn;
    this.authBase = authBase;
    this.apiBase = apiBase;
  }

  authorizeUrl(clientId: string, redirectUri: string, state: string): string {
    const q = new URLSearchParams({ audience: "api.atlassian.com", client_id: clientId, scope: ATLASSIAN_SCOPES, redirect_uri: redirectUri, state, response_type: "code", prompt: "consent" });
    return `${this.authBase}/authorize?${q.toString()}`;
  }

  private async token(body: Record<string, string>): Promise<AtlassianAuth> {
    const res = await this.fetchFn(`${this.authBase}/oauth/token`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Atlassian sign-in: ${res.status}${(await res.text().catch(() => "")).includes("invalid_grant") ? " (the sign-in expired: connect again)" : ""}`);
    const t = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (typeof t.access_token !== "string") throw new Error("Atlassian sent no access token");
    return { access: t.access_token, ...(t.refresh_token ? { refresh: t.refresh_token } : {}), expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
  }

  exchange(keys: AtlassianKeys, code: string, redirectUri: string): Promise<AtlassianAuth> {
    return this.token({ grant_type: "authorization_code", client_id: keys.clientId, client_secret: keys.secret, code, redirect_uri: redirectUri });
  }

  async sites(access: string): Promise<JiraSite[]> {
    const res = await this.fetchFn(`${this.apiBase}/oauth/token/accessible-resources`, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${access}` } });
    if (!res.ok) throw new Error(`Atlassian sites: ${res.status}`);
    const all = (await res.json()) as { id?: string; url?: string; name?: string; scopes?: string[] }[];
    // Jira sites only (the same id can name other products)
    return all.filter((r) => (r.scopes ?? []).some((s) => s.includes("jira"))).flatMap((r) => (r.id && r.url ? [{ id: r.id, url: r.url, name: r.name ?? r.url }] : []));
  }

  jira(keys: AtlassianKeys, auth: AtlassianAuth, save: (next: AtlassianAuth) => void | Promise<void>): JiraClient {
    let now = auth;
    const bearer = async () => {
      if (now.expiresAt - 60_000 < Date.now() && now.refresh) {
        const fresh = await this.token({ grant_type: "refresh_token", client_id: keys.clientId, client_secret: keys.secret, refresh_token: now.refresh });
        now = { ...now, ...fresh };
        await save(now); // kept before it's used: the old refresh token stops working
      }
      return `Bearer ${now.access}`;
    };
    if (!auth.cloudId) throw new Error("no Jira site picked yet");
    return new JiraRest(`${this.apiBase}/ex/jira/${auth.cloudId}`, bearer, this.fetchFn);
  }
}
