// A path from the command line, made canonical and refused unless it is inside the folder
// the command was run from. These scripts only read and write the fixture under the repo, and
// a CLI an agent may drive must not reach outside its working folder (SonarCloud S8707: `..`,
// an absolute path elsewhere, a symlink out, a sibling whose name starts the same). The path
// must exist.
import { realpathSync } from "node:fs";
import { sep } from "node:path";

export function safePath(filePath: string): string {
  const resolved = realpathSync(filePath);
  const baseDir = realpathSync(process.cwd());
  if (resolved !== baseDir && !resolved.startsWith(baseDir + sep)) {
    throw new Error(`path '${filePath}' is outside the allowed directory`);
  }
  return resolved;
}
