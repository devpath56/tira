// tira's MCP server at a web address: tira serve answers it at /mcp, on this computer only (the
// same 127.0.0.1 rule as its pages), for an agent that brings its own token (Authorization: Bearer
// tira_…, made in Project settings → Connect agents). Every request is checked on its own: the
// token names the project and the agent, and a revoked one is refused at once. The same tools as
// tira mcp, for the 2026-07-28 spec and 2025-era clients too (createMcpHandler: stateless, one
// server per request). It works while tira serve runs; apps that can only start a program
// (Claude Desktop) use tira mcp instead.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { EventStore } from "../store/types.ts";
import type { Registry } from "../tables/registry.ts";
import { tiraMcpServer } from "./server.ts";
import type { AgentToken, AgentTokens } from "./tokens.ts";

export const MCP_PATH = "/mcp";
// a web page's origin on this computer; a page anywhere else is refused (its fetch could carry no
// token of ours anyway, but it gets no further than this)
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const BEARER = /^Bearer\s+(\S+)$/i;
const MAX_BODY = 1024 * 1024; // a tool call is a few hundred bytes

export const NO_TOKEN = "tira needs this agent's token: send Authorization: Bearer <token>, made in Project settings → Connect agents.";
export const NOT_CONNECTED = "This token isn't connected: it was revoked, or wasn't made by this tira. Connect the agent again in Project settings → Connect agents.";

// A refusal an MCP client can show: a JSON-RPC error that answers no request in particular.
function refuse(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
}

// node:http's request as the web Request the SDK's handler takes (its body streamed, not read here)
function webRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) for (const x of [v ?? []].flat()) headers.append(k, x);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>);
  return new Request(url, { method: req.method ?? "POST", headers, ...(body ? { body, duplex: "half" } : {}) } as RequestInit);
}

export interface McpHttp { store: EventStore; registry: Registry; tokens: () => AgentTokens | undefined }
export type McpRoute = ((req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>) & { close: () => Promise<void> };

export function mcpRoute(o: McpHttp): McpRoute {
  const handler = createMcpHandler((ctx) => {
    const agent = ctx.authInfo?.extra?.agent as AgentToken | undefined;
    if (!agent) throw new Error("tira: an MCP request reached the server without its agent");
    return tiraMcpServer({ store: o.store, registry: o.registry, stream: agent.project, actor: agent.agent });
  }, { maxRequestBodySize: MAX_BODY });
  const route = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) return refuse(res, 403, "tira answers MCP only to apps on this computer, not to a web page.");
    const tokens = o.tokens();
    if (!tokens) return refuse(res, 503, "Connecting agents needs tira's Postgres database.");
    const token = BEARER.exec(req.headers.authorization ?? "")?.[1];
    const agent = token === undefined ? undefined : await tokens.find(token);
    if (token === undefined || !agent) return refuse(res, 401, token === undefined ? NO_TOKEN : NOT_CONNECTED, { "WWW-Authenticate": 'Bearer realm="tira"' });
    await tokens.used(agent.id);
    const answer = await handler.fetch(webRequest(req, url), { authInfo: { token, clientId: agent.agent, scopes: [], extra: { agent } } });
    res.writeHead(answer.status, { ...Object.fromEntries(answer.headers), "X-Content-Type-Options": "nosniff" });
    if (!answer.body) return void res.end();
    // a stream the client leaves ends here, quietly
    await pipeline(Readable.fromWeb(answer.body as unknown as WebStream<Uint8Array>), res).catch(() => {});
  };
  return Object.assign(route, { close: () => handler.close() });
}
