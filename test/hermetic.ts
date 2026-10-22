// Tests never read or write this machine's private store (~/.config/tira): each test process gets
// an empty one of its own, so app keys or a sign-in saved for real use can't change what a test sees.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "tira-test-home-"));
process.env.TIRA_HOME = home;
// and their accounts stay in that file: a database set for real use isn't where a test keeps them
delete process.env.TIRA_DATABASE_URL;
delete process.env.TIRA_DB;
// a throwaway key for the accounts a test keeps in Postgres (tira serve won't start there without one)
process.env.TIRA_SECRET_KEY = "a throwaway key for tira's tests, never a real one";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
