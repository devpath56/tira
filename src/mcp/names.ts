// What an agent may be called (Project settings → Connect agents, when its token is made): an
// agent's own name, never a person's. Its own module, so the settings pages can ask without loading
// the MCP server.
import { AGENT } from "../render/html.ts";
import { isReservedActor } from "../write/write-path.ts";

const NAME = /^[\w.:-]{1,64}$/;

// Why an agent can't have this name, or undefined: an agent's own name (claude-code,
// codex-review, factory-s3, research-agent, triage-bot), never a person's, and never the names
// tira, the dispatcher and the sync write under.
export function agentNameProblem(name: string | undefined): string | undefined {
  if (name === undefined || name.trim() === "") return "Give the agent a name of its own, e.g. claude-code.";
  if (!NAME.test(name)) return `"${name}" can't be an agent's name: letters, digits, dots, dashes, underscores or colons, up to 64`;
  if (isReservedActor(name)) return `"${name}" is reserved for tira's, the dispatcher's and the sync's own writes: give the agent a name of its own, e.g. claude-code`;
  if (!AGENT.test(name)) return `"${name}" reads as a person's name: an agent acts under an agent's name (claude-…, codex-…, …-agent, …-bot), so its history shows an agent did it`;
  return undefined;
}
