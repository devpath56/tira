#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// tira CLI entry point. Logic lives in src/cli/cli.ts (tested in test/cli.test.ts).
//   node scripts/tira.ts --help     or     npm run -s tira -- --help

// node:sqlite prints an ExperimentalWarning when first loaded. The shebang flag only
// applies when run as ./scripts/tira.ts, so also drop that one warning here, before
// the CLI (and with it node:sqlite) is imported. Every other warning still prints.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const opt = rest[0];
  const type = typeof opt === "string" ? opt : (opt as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// The database's connection string may sit in this repo's own .env (gitignored): read it if it's
// there. A setting already in the environment wins. Never printed.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // no .env: the environment alone
}

const { run } = await import("../src/cli/cli.ts");
const { closeAccounts } = await import("../src/sync/credentials.ts");
const { closeAgentTokens } = await import("../src/mcp/tokens.ts");
// A secret typed at the terminal (tira connect-jira's API token): nothing echoes. Piped in, the
// first line is read.
const secret = (prompt: string) =>
  new Promise<string>((resolve) => {
    const { stdin, stderr } = process;
    stderr.write(prompt);
    stdin.setEncoding("utf8");
    if (!stdin.isTTY) {
      let all = "";
      stdin.on("data", (c: string) => (all += c));
      stdin.on("end", () => resolve(all.split(/\r?\n/)[0] ?? ""));
      return;
    }
    let typed = "";
    stdin.setRawMode(true);
    stdin.resume();
    const done = (value: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") return done(typed);
        if (c === "\u0003") return done(""); // Ctrl-C: nothing given
        if (c === "\u007f") typed = typed.slice(0, -1);
        else typed += c;
      }
    };
    stdin.on("data", onData);
  });

process.exitCode = await run(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
  secret,
});
// People's accounts keep a Postgres pool of their own (credentials.ts): close it on the way out,
// or the process waits out the pool's idle timeout, 10 seconds, before it exits (tira serve after
// Ctrl-C, or any command that read an account).
await closeAccounts();
await closeAgentTokens(); // agents' tokens keep a pool of their own (src/mcp/tokens.ts): the same goes for it
