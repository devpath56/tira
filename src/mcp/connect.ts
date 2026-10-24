// Connecting an agent to a project (Project settings → Connect agents): how each app adds tira's
// MCP server, with the agent's own token: Claude Code's command, Cursor's and VS Code's install
// links (each app shows the server and asks before it installs) and their config files, and Claude
// Desktop's entry. Each names this tira's own Node and entry script (a plain `node` on the PATH may
// be another version). Also whether an agent would reach the database this tira uses (tira mcp
// reads it from tira's own .env, as every tira command does). Nothing here runs a command or
// writes a file: the page shows words to copy and links to open.
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
const serverOf = (l: Launch, token: string) => ({ command: l.node, args: ["--disable-warning=ExperimentalWarning", l.script, "mcp"], env: { TIRA_AGENT_TOKEN: token } });
const json = (value: unknown) => JSON.stringify(value, null, 2);

// How one app adds tira for this project's agent: the steps, the command or config to copy, the
// app's install link where it has one, and how to remove it.
export interface AppSetup { steps: string[]; code: string; install?: string; remove: string }
export function appSetup(app: App, project: string, l: Launch, token: string): AppSetup {
  const name = serverName(project);
  const server = serverOf(l, token);
  if (app === "claude-code") {
    return {
      steps: ["Open a terminal.", "Run the command below (it needs Claude Code's claude command)."],
      code: `claude mcp add --scope user --env TIRA_AGENT_TOKEN=${sh(token)} --transport stdio ${name} -- ${[server.command, ...server.args].map(sh).join(" ")}`,
      remove: `claude mcp remove ${name} -s user`,
    };
  }
  if (app === "cursor") {
    return {
      steps: ["Open ~/.cursor/mcp.json (create it if it doesn't exist).", "Paste the configuration below and save.", "Restart Cursor, or reload its MCP servers."],
      code: json({ mcpServers: { [name]: server } }),
      install: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(Buffer.from(JSON.stringify(server)).toString("base64"))}`,
      remove: `Delete "${name}" from ~/.cursor/mcp.json.`,
    };
  }
  if (app === "vscode") {
    const entry = { type: "stdio", ...server };
    return {
      steps: ["Open .vscode/mcp.json in your workspace (create it if it doesn't exist).", "Paste the configuration below and save."],
      code: json({ servers: { [name]: entry } }),
      install: `https://insiders.vscode.dev/redirect/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(JSON.stringify(entry))}`,
      remove: `Delete "${name}" from .vscode/mcp.json.`,
    };
  }
  return {
    steps: ["In Claude Desktop: Settings → Developer → Edit Config.", "Add the entry below under mcpServers and save.", "Restart Claude Desktop."],
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
