// Connecting an agent to a project (Project settings → Connect agents): how each app adds tira's
// MCP server, with the agent's own token. Claude Code, Cursor and VS Code reach it at tira serve's
// address (/mcp, the token in an Authorization header): Claude Code's command, Cursor's and VS
// Code's install links (each app shows the server and asks before it adds it) and their config
// files. Claude Desktop's config can only start a program, so its entry starts tira mcp, with this
// tira's own Node and entry script (a plain `node` on the PATH may be another version), and that
// reads the database from tira's own .env, as every tira command does: whether it would reach the
// database this tira uses is checked too. Nothing here runs a command or writes a file: the page
// shows words to copy and links to open.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const APPS = ["claude-code", "cursor", "vscode", "claude-desktop"] as const;
export type App = (typeof APPS)[number];
export const APP_NAME: Record<App, string> = { "claude-code": "Claude Code", cursor: "Cursor", vscode: "VS Code", "claude-desktop": "Claude Desktop" };
// the name a new agent gets when it's connected in one click (an agent's name, never a person's)
export const APP_AGENT: Record<App, string> = { "claude-code": "claude-code", cursor: "cursor-agent", vscode: "vscode-agent", "claude-desktop": "claude-desktop" };
// what the manual steps show where the token goes, until one is made
export const TOKEN_HERE = "<your token>";

// this tira's own entry script, and the .env it reads
export const TIRA_SCRIPT = fileURLToPath(new URL("../../scripts/tira.ts", import.meta.url));
export const TIRA_ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));

// a word for a shell: bare when it can be, else in single quotes
const PLAIN = /^[\w.:/@+=,-]+$/;
const sh = (s: string) => (PLAIN.test(s) ? s : `'${s.replaceAll("'", String.raw`'\''`)}'`);

// The server's name in the app: one per project, so two projects can both be connected.
export function serverName(project: string): string {
  const slug = project.toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-").replaceAll(/(?:^-+)|(?:-+$)/g, "");
  return `tira-${slug || "project"}`;
}

export interface Launch { node: string; script: string }
// where an app reaches tira: tira serve's address for MCP, and how to start tira mcp
export interface Where { url: string; launch: Launch }
// tira serve's MCP address: at its public address when it has one (src/serve/public.ts); else from
// the Host the page was asked for (tira serve listens on 127.0.0.1 only, so that's the address,
// whichever name the page was opened with)
export function mcpUrl(host: string, publicOrigin?: string): string {
  if (publicOrigin) return `${publicOrigin}/mcp`;
  const port = /:(\d+)$/.exec(host)?.[1];
  return `http://127.0.0.1${port ? ":" + port : ""}/mcp`;
}
const json = (value: unknown) => JSON.stringify(value, null, 2);

// How one app adds tira for this project's agent: the steps, the command or config to copy, the
// app's install link where it has one, and how to remove it.
export interface AppSetup { steps: string[]; code: string; install?: string; remove: string }
export function appSetup(app: App, project: string, at: Where, token: string): AppSetup {
  const name = serverName(project);
  const bearer = `Bearer ${token}`;
  const headers = { Authorization: bearer };
  if (app === "claude-code") {
    return {
      steps: [
        "Run this in a terminal. It replaces any earlier tira entry for this project in Claude Code. Claude Code shows the token as [REDACTED]: that's it keeping the token private, as it should.",
        `Its last lines check the connection: ${name} … ✓ Connected. This page turns green at the same moment.`,
        "Open a new Claude Code session (one open before won't have tira) and ask it: what's next in tira?",
      ],
      // the remove first: the server's name is the project's, so an earlier entry would block the add;
      // then claude mcp list, which calls each server and says ✓ Connected (Isha, 2026-10-26: the add
      // alone said nothing about whether it worked), and is the agent's first call, so tira knows too
      code: `claude mcp remove ${name} -s user 2>/dev/null; claude mcp add --scope user --transport http ${name} ${sh(at.url)} --header ${sh("Authorization: " + bearer)} && claude mcp list`,
      remove: `claude mcp remove ${name} -s user`,
    };
  }
  if (app === "cursor") {
    const server = { url: at.url, headers };
    return {
      steps: ["Open ~/.cursor/mcp.json (create it if it doesn't exist).", "Paste this and save.", "Turn tira on in Cursor's settings, under MCP."],
      code: json({ mcpServers: { [name]: server } }),
      install: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(Buffer.from(JSON.stringify(server)).toString("base64"))}`,
      remove: `Delete "${name}" from ~/.cursor/mcp.json.`,
    };
  }
  if (app === "vscode") {
    const entry = { type: "http", url: at.url, headers };
    return {
      steps: ["Open .vscode/mcp.json in your workspace (create it if it doesn't exist).", "Paste this and save.", "Start tira from the MCP servers list."],
      code: json({ servers: { [name]: entry } }),
      install: `https://insiders.vscode.dev/redirect/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(JSON.stringify(entry))}`,
      remove: `Delete "${name}" from .vscode/mcp.json.`,
    };
  }
  const server = { command: at.launch.node, args: ["--disable-warning=ExperimentalWarning", at.launch.script, "mcp"], env: { TIRA_AGENT_TOKEN: token } };
  return {
    steps: ["In Claude Desktop: Settings → Developer → Edit Config.", "Add this under mcpServers and save.", "Restart Claude Desktop."],
    code: json({ mcpServers: { [name]: server } }),
    remove: `Delete "${name}" from mcpServers in Claude Desktop's config, then restart it.`,
  };
}

// Would an agent reach this tira's database? ready: tira's .env names it (and its schema);
// missing: it names none, so tira mcp couldn't open the board; different: it names another
// database or schema than this tira was started with. Values are compared, never shown.
export type DatabaseCheck = "ready" | "missing" | "different";
export function databaseCheck(envFile: string, env: Record<string, string | undefined>): DatabaseCheck {
  let file: Record<string, string | undefined>;
  try {
    file = parseEnv(readFileSync(envFile, "utf8"));
  } catch {
    return "missing";
  }
  if (!file.TIRA_DATABASE_URL) return "missing";
  if (env.TIRA_DATABASE_URL === undefined) return "ready"; // started with --db: nothing here to compare
  const same = env.TIRA_DATABASE_URL === file.TIRA_DATABASE_URL && (env.TIRA_SCHEMA ?? "") === (file.TIRA_SCHEMA ?? "");
  return same ? "ready" : "different";
}
