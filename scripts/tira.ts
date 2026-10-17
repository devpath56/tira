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

const { run } = await import("../src/cli/cli.ts");
process.exitCode = await run(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
});
