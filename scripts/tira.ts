#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// tira CLI entry point. Logic lives in src/cli/cli.ts (tested in test/cli.test.ts).
//   node scripts/tira.ts --help     or     npm run -s tira -- --help
import { run } from "../src/cli/cli.ts";

process.exitCode = await run(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
});
