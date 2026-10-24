// Connecting an agent to tira (Account settings → Agents): the command a person runs to add tira's
// MCP server to Claude Code (for all their projects, or one folder), or the entry for Claude
// Desktop's settings, pointing at this tira's own Node and entry script; and whether an agent
// would reach the database this tira uses (tira mcp reads it from tira's own .env, as every tira
// command does). Nothing here runs a command or writes a file: the page shows words to copy.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// Where the agent runs: Claude Code for all your projects, Claude Code in one folder, Claude Desktop.
export const WHERE = ["user", "local", "desktop"] as const;
export type Where = (typeof WHERE)[number];
export interface Connection { project: string; agent: string; where: Where }

// this tira's own entry script, and the .env it reads (a plain `node` on the PATH may be another
// version, so the command names this tira's Node too)
export const TIRA_SCRIPT = fileURLToPath(new URL("../../scripts/tira.ts", import.meta.url));
export const TIRA_ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));

// a word for a shell: bare when it can be, else in single quotes
const PLAIN = /^[\w.:/@+=,-]+$/;
const sh = (s: string) => (PLAIN.test(s) ? s : `'${s.replaceAll("'", String.raw`'\''`)}'`);

// The server's name in Claude: one per project, so two projects can both be connected.
export function serverName(project: string): string {
  const slug = project.toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-").replaceAll(/(?:^-+)|(?:-+$)/g, "");
  return `tira-${slug || "project"}`;
}

const argsOf = (script: string, c: Connection) => ["--disable-warning=ExperimentalWarning", script, "mcp", "--stream", c.project, "--actor", c.agent];

// What to copy to connect, and how to undo it.
export function connectWords(node: string, script: string, c: Connection): { add: string; remove: string } {
  const name = serverName(c.project);
  if (c.where === "desktop") {
    return {
      add: JSON.stringify({ mcpServers: { [name]: { command: node, args: argsOf(script, c) } } }, null, 2),
      remove: `Delete "${name}" from mcpServers in Claude Desktop's settings file, then restart Claude Desktop.`,
    };
  }
  return { add: `claude mcp add --scope ${c.where} ${name} -- ${[node, ...argsOf(script, c)].map(sh).join(" ")}`, remove: `claude mcp remove ${name} -s ${c.where}` };
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
