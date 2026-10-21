// The match check for the mutation harness (scripts/mutants.ts): every planted bug must
// still land exactly where it was written, before any test runs. A find-and-replace bug
// whose text no longer appears exactly once, or a rules-table edit that no longer applies
// (or changes nothing), would plant nothing, and its "catch" would be a lie. Refactors move
// these anchors all the time; this finds every one in seconds instead of at the end of a
// full run. Pure: it reads files only through `read`, so tests can hand it any tree.

export type Anchored =
  | { name: string; file: string; find: string }
  | { name: string; json: string; edit: (t: never) => void };

// read(path) gives the file's text, or undefined when there is no such file.
export function anchorProblems(mutants: readonly Anchored[], read: (path: string) => string | undefined): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of mutants) {
    if (seen.has(m.name)) problems.push(`${m.name}: the name is used twice (each planted bug needs its own)`);
    seen.add(m.name);
    const problem = "json" in m ? tableProblem(m, read) : textProblem(m, read);
    if (problem !== undefined) problems.push(`${m.name}: ${problem}`);
  }
  return problems;
}

function textProblem(m: { file: string; find: string }, read: (path: string) => string | undefined): string | undefined {
  const text = read(m.file);
  if (text === undefined) return `${m.file} does not exist`;
  const hits = text.split(m.find).length - 1;
  return hits === 1 ? undefined : `pattern matched ${hits} times in ${m.file} (must be exactly 1)`;
}

function tableProblem(m: { json: string; edit: (t: never) => void }, read: (path: string) => string | undefined): string | undefined {
  const text = read(m.json);
  if (text === undefined) return `${m.json} does not exist`;
  let table: unknown;
  try {
    table = JSON.parse(text);
  } catch {
    return `${m.json} is not JSON`;
  }
  const edited = structuredClone(table);
  try {
    m.edit(edited as never);
  } catch (err) {
    return `the edit no longer applies to ${m.json} (${(err as Error).message})`;
  }
  return JSON.stringify(edited) === JSON.stringify(table) ? `the edit changes nothing in ${m.json}` : undefined;
}
