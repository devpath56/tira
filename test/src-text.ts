// The code under src/ as text, for the class-level tests' structure checks (the five
// representation classes: each is defined in one place, and the tests prove no second
// definition exists). Whole-line and block comments are dropped, so a rule stated in a
// comment ("deliberately NOT localeCompare") never reads as code.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCodeUnits } from "../src/fold/view.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => (/^\s*\/\//.test(l) ? "" : l))
    .join("\n");

// path relative to the repo (src/fold/fold.ts) -> its code, every .ts and .mjs file under src
export function srcCode(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs)$/.test(e.name) && !e.name.endsWith(".d.mts")) out.set(relative(ROOT, p), code(readFileSync(p, "utf8")));
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

// The files whose code matches `re`, in path order.
export const filesMatching = (src: Map<string, string>, re: RegExp): string[] => [...src].filter(([, t]) => re.test(t)).map(([f]) => f);

// Every argument passed to .sort( or .toSorted( in the code, with the file it is in.
export function sortArguments(src: Map<string, string>): { file: string; arg: string }[] {
  const out: { file: string; arg: string }[] = [];
  for (const [file, text] of src) {
    for (const m of text.matchAll(/\.(?:sort|toSorted)\(/g)) {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      const start = i;
      for (; i < text.length && depth > 0; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
      }
      out.push({ file, arg: text.slice(start, i - 1).trim() });
    }
  }
  return out;
}
