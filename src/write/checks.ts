// Emitting check events (citation-construction slice S1). No done test runs inside tira
// today: the orchestrator runs it outside and reports only `done_test_result` on the drop's
// VERIFIED. This is the seam where a done test meets the log: the gate runs the test command,
// binds the test definition it ran by { path, blob } (git's blob id of the file as run), and
// writes done-test.ran through the write path (or the dispatcher in front of it) like any
// command. Nothing calls it on the live verify path yet: S3 routes VERIFIED through it.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Command } from "./write-path.ts";
import { DONE_TEST, GATE, MACHINE_CHECK } from "../tables/checks.ts";

export interface DoneTestRun {
  stream: string;
  brief: string;
  version: number;
  testPath: string; // the test definition file the command executes, relative to cwd
  command: string; // the done test, as the brief states it
  cwd: string; // the repo the test runs in
  runId?: string; // the done-test entity id; default a fresh uuid
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// The done-test.ran command for a run whose outcome is known. Pure: tests and the gate share it.
export function doneTestCommand(r: Omit<DoneTestRun, "command" | "cwd"> & { result: "PASS" | "FAIL"; blob: string; repo?: string; commit?: string }): Command {
  return {
    stream: r.stream, kind: "create", actor: GATE,
    entity: { type: DONE_TEST, id: r.runId ?? randomUUID() },
    payload: {
      brief: r.brief, version: r.version, result: r.result, component: GATE,
      test: { path: r.testPath, blob: r.blob },
      ...(r.repo === undefined ? {} : { repo: r.repo }),
      ...(r.commit === undefined ? {} : { commit: r.commit }),
    },
  };
}

// Run the done test and record that it ran. The blob is read before the run, so the event
// names the definition that was executed, not one edited during the run.
export async function runDoneTest<R>(submit: (cmd: Command) => Promise<R>, r: DoneTestRun): Promise<{ result: "PASS" | "FAIL"; exitCode: number | null; write: R }> {
  const blob = git(r.cwd, ["hash-object", resolve(r.cwd, r.testPath)]);
  let commit: string | undefined;
  let repo: string | undefined;
  try {
    commit = git(r.cwd, ["rev-parse", "HEAD"]);
    repo = git(r.cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    // not a repository (or no commit yet): the blob still binds the file
  }
  const run = spawnSync(r.command, { cwd: r.cwd, shell: true, stdio: "ignore" });
  const result = run.status === 0 ? "PASS" : "FAIL";
  const write = await submit(doneTestCommand({ ...r, result, blob, ...(repo === undefined ? {} : { repo }), ...(commit === undefined ? {} : { commit }) }));
  return { result, exitCode: run.status, write };
}

// machine-check.reported: a named machine component reports a check result for a node (the
// fetch_metrics shape). No machine check on node work exists in tira today, so this has no
// live emitter: scenarios and tests write it through the write path as that component.
export function machineCheckCommand(r: { stream: string; node: string; check: string; result: "PASS" | "FAIL"; component: string; runId?: string }): Command {
  return {
    stream: r.stream, kind: "create", actor: r.component,
    entity: { type: MACHINE_CHECK, id: r.runId ?? randomUUID() },
    payload: { node: r.node, check: r.check, result: r.result, component: r.component },
  };
}
