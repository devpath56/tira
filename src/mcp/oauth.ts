// Claude's connectors sign in to tira (claude.ai, Claude Desktop and mobile, and Claude Code), at
// tira's public address only (src/serve/public.ts), with OAuth as Anthropic asks
// (claude.com/docs/connectors/building/authentication; Isha, 2026-10-24). tira is its own
// authorization server, kept small:
// - discovery: /.well-known/oauth-protected-resource[/mcp] names /mcp as the resource and tira as
//   its authorization server, and /.well-known/oauth-authorization-server says where to register,
//   ask and exchange; a call to /mcp without a token is answered 401, pointing at the first.
// - registration (RFC 7591, open, as Claude registers itself): a client's id is its own
//   registration, signed with TIRA_SECRET_KEY, so tira keeps nothing for it. Only Claude's own way
//   back (https://claude.ai/api/mcp/auth_callback) and this computer's (Claude Code: localhost or
//   127.0.0.1, on any port) are taken.
// - asking (/oauth/authorize, the page in src/serve/server.ts): the person signs in with GitHub,
//   picks the project and the agent's name, and approves; tira sends Claude back with a one-time
//   code, bound to Claude's PKCE challenge (S256 only).
// - exchanging (/oauth/token): the code and its verifier; tira then connects the agent as Project
//   settings would (its own token, listed there, revocable there) and answers with its token: what
//   /mcp takes already, with no expiry. Revoking the agent in Project settings ends it.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
export const CONNECTOR_APP = "claude-connector"; // an agent connected this way, as its token's row says
// this computer's way back, on any port (RFC 8252): Claude Code's
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(?::\d{1,5})?(\/[^\s?#]*)?$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_MS = 5 * 60_000;
export const PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER = "/.well-known/oauth-authorization-server";

export interface Client { redirect_uris: string[]; client_name?: string }

// ---------- discovery ----------
export const resourceOf = (origin: string) => `${origin}/mcp`;
export const resourceMetadataUrl = (origin: string) => `${origin}${PROTECTED_RESOURCE}/mcp`;
export const protectedResource = (origin: string) => ({ resource: resourceOf(origin), authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "tira" });
export const authorizationServer = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
});

// ---------- registration ----------
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", secret).update(`tira oauth client ${body}`).digest("base64url");
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const redirectTaken = (uri: string) => uri === CLAUDE_CALLBACK || LOOPBACK.test(uri);

// A registration, read: why it can't be, or the client to sign.
export function registrationOf(body: unknown): { client: Client } | { error: string; why: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === "string")) return { error: "invalid_redirect_uri", why: "redirect_uris: one to five addresses" };
  const off = (uris as string[]).find((u) => !redirectTaken(u));
  if (off !== undefined) return { error: "invalid_redirect_uri", why: `tira sends people back only to Claude (${CLAUDE_CALLBACK}) or to this computer (http://localhost or 127.0.0.1), not to ${off}` };
  const name = typeof b.client_name === "string" ? b.client_name.replaceAll(/\p{Cc}/gu, "").trim().slice(0, 80) : "";
  return { client: { redirect_uris: uris as string[], ...(name ? { client_name: name } : {}) } };
}
// a client's id: its registration, signed (tira keeps nothing for it)
export function clientId(secret: string, client: Client): string {
  const body = b64(JSON.stringify(client));
  return `tc_${body}.${mac(secret, body)}`;
}
export function clientOf(secret: string, id: string): Client | undefined {
  const m = /^tc_([A-Za-z0-9_-]{1,2000})\.([A-Za-z0-9_-]{43})$/.exec(id);
  if (!m || !sameText(m[2] as string, mac(secret, m[1] as string))) return undefined;
  try {
    const c = JSON.parse(Buffer.from(m[1] as string, "base64url").toString("utf8")) as Client;
    return Array.isArray(c.redirect_uris) ? c : undefined;
  } catch {
    return undefined;
  }
}
// a way back the client registered: exactly, or this computer's on any port (Claude Code's changes)
export function registered(client: Client, uri: string): boolean {
  if (client.redirect_uris.includes(uri)) return true;
  const loose = (u: string) => (LOOPBACK.test(u) ? u.replace(/^(http:\/\/[^/:]+)(?::\d+)?/, "$1") : undefined);
  const want = loose(uri);
  return want !== undefined && client.redirect_uris.some((u) => loose(u) === want);
}

// ---------- asking ----------
// What Claude asks for at /oauth/authorize, read: why it can't be (shown on tira's page when the
// client or its way back is wrong, else sent back to Claude), or the request to show the person.
export interface Asking { client_id: string; client: Client; redirect_uri: string; state?: string; challenge: string }
export type AskingProblem = { show: string } | { back: string; error: string; why: string };
export function askingOf(secret: string, origin: string, q: URLSearchParams): { asking: Asking } | AskingProblem {
  const id = q.get("client_id") ?? "";
  const client = clientOf(secret, id);
  if (!client) return { show: "This link to connect to tira isn't one tira made: start again from Claude's Connectors." };
  const redirect = q.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
  if (redirect === undefined || !registered(client, redirect)) return { show: "This link to connect to tira doesn't say where to go back to: start again from Claude's Connectors." };
  const state = q.get("state") ?? undefined;
  const sendBack = (error: string, why: string): AskingProblem => ({ back: withQuery(redirect, { error, error_description: why, ...(state ? { state } : {}) }), error, why });
  if (q.get("response_type") !== "code") return sendBack("unsupported_response_type", "tira answers response_type=code only");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return sendBack("invalid_request", "tira needs a PKCE code_challenge, with S256");
  const resource = q.get("resource");
  if (resource !== null && resource !== resourceOf(origin)) return sendBack("invalid_target", `tira's resource is ${resourceOf(origin)}`);
  return { asking: { client_id: id, client, redirect_uri: redirect, ...(state ? { state } : {}), challenge } };
}
export function withQuery(uri: string, params: Record<string, string>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// ---------- codes, and exchanging one ----------
// what the person approved: the agent to connect, in which project, by whom
export interface Grant { project: string; agent: string; login: string }
interface Granted { client_id: string; redirect_uri: string; challenge: string; grant: Grant; until: number }
export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

// One-time codes, in memory (a code lives five minutes, and tira serve runs as one process). A code
// that's used, wrongly or rightly, is gone.
export class Codes {
  private readonly codes = new Map<string, Granted>();
  issue(asking: Asking, grant: Grant): string {
    const now = Date.now();
    for (const [k, g] of this.codes) if (g.until < now) this.codes.delete(k);
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { client_id: asking.client_id, redirect_uri: asking.redirect_uri, challenge: asking.challenge, grant, until: now + CODE_MS });
    return code;
  }
  // what a code was granted for, when everything about the exchange matches; else why not
  exchange(form: URLSearchParams): { grant: Grant } | { error: string; why: string } {
    if (form.get("grant_type") !== "authorization_code") return { error: "unsupported_grant_type", why: "tira exchanges authorization codes only" };
    const code = form.get("code") ?? "";
    const g = this.codes.get(code);
    this.codes.delete(code);
    const verifier = form.get("code_verifier") ?? "";
    if (!g || g.until < Date.now()) return { error: "invalid_grant", why: "that code was used, or is too old: connect again" };
    if (form.get("client_id") !== g.client_id) return { error: "invalid_grant", why: "that code was made for another client" };
    if ((form.get("redirect_uri") ?? g.redirect_uri) !== g.redirect_uri) return { error: "invalid_grant", why: "redirect_uri isn't the one the code was asked with" };
    if (!VERIFIER.test(verifier) || !sameText(s256(verifier), g.challenge)) return { error: "invalid_grant", why: "code_verifier doesn't match the code's challenge" };
    return { grant: g.grant };
  }
}
