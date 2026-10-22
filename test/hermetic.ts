// Tests never read or write this machine's private store (~/.config/tira): each test process gets
// an empty one of its own, so app keys or a sign-in saved for real use can't change what a test sees.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "tira-test-home-"));
process.env.TIRA_HOME = home;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
