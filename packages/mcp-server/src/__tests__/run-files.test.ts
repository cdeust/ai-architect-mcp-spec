/**
 * #121 — the file of a run: what is written is what is read back, an id that
 * is not a run id never becomes a path, a file that is not a run is said to
 * be unreadable, and the sweep applies the run store's two bounds.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunFiles } from "../run-files.js";
import { cannedRun } from "./canned-run.js";

const RUN = "run_mwemwsre_a3bsp0";
const STEPS = cannedRun(RUN);
const FIRST = STEPS[0]!;
const LAST = STEPS[STEPS.length - 1]!;
const MINUTE = 60_000;
const NOW = Date.parse("2026-11-13T12:00:00Z");

let scratch: string;
let dir: string;
let files: RunFiles;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "prd-gen-run-files-"));
  dir = join(scratch, "runs");
  files = new RunFiles(dir);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Writes the file of a run and gives it an age, in minutes before NOW. */
function aged(runId: string, minutes: number, source = FIRST): string {
  files.write({ ...source.state, run_id: runId }, source.action);
  const path = files.pathOf(runId)!;
  const at = new Date(NOW - minutes * MINUTE);
  utimesSync(path, at, at);
  return `${runId}.json`;
}

describe("the file of a run (#121)", () => {
  it("reads back, for every step of a run, the state and the action that were written", () => {
    expect(LAST.state.current_step).toBe("complete");
    expect(STEPS.length).toBeGreaterThan(10);
    for (const { state, action } of STEPS) {
      files.write(state, action);
      expect(files.read(RUN), `${state.current_step}/${action.kind}`).toEqual({ kind: "found", run: { state, action } });
    }
    // One file per run, and nothing left of the writes.
    expect(readdirSync(dir)).toEqual([`${RUN}.json`]);
  });

  it("reads back a run that was kept without an action", () => {
    files.write(FIRST.state, null);
    expect(files.read(RUN)).toEqual({ kind: "found", run: { state: FIRST.state, action: null } });
  });

  it.skipIf(process.platform === "win32")("keeps the directory and the file to their owner", () => {
    files.write(FIRST.state, FIRST.action);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(files.pathOf(RUN)!).mode & 0o777).toBe(0o600);
  });

  it("turns into a path only an id of the form the server generates", () => {
    expect(files.pathOf(RUN)).toBe(join(dir, `${RUN}.json`));
    // Math.random() can give 0, whose base-36 form has no digit after the point.
    expect(files.pathOf("run_mwemwsre_")).toBe(join(dir, "run_mwemwsre_.json"));
    for (const id of ["", "run", "run__a", "../outside", "run_a/../../outside", "run_a_b/c", "run_A_b", "run_a_b.json", "x_run_a_b"]) {
      expect(files.pathOf(id), id).toBeNull();
      expect(files.read(id), id).toEqual({ kind: "absent" });
    }
    expect(() => files.write({ ...FIRST.state, run_id: "../outside" }, FIRST.action)).toThrow(/not a run id/);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("answers absent for a run that has no file", () => {
    expect(files.read(RUN)).toEqual({ kind: "absent" });
  });

  it("says a file is unreadable, and why, when it is not a run of this id", () => {
    mkdirSync(dir);
    const path = files.pathOf(RUN)!;
    const kept = { version: 1, state: FIRST.state, action: FIRST.action };
    const cases: Array<[string, string, RegExp]> = [
      ["cut short", JSON.stringify(kept).slice(0, 200), /not JSON/],
      ["null", "null", /not a run file of version 1/],
      ["another version", JSON.stringify({ ...kept, version: 2 }), /not a run file of version 1/],
      ["a state that is not one", JSON.stringify({ ...kept, state: { run_id: RUN } }), /its state is not valid/],
      ["the state of another run", JSON.stringify({ ...kept, state: { ...FIRST.state, run_id: "run_other_000000" } }), /it holds run run_other_000000/],
      ["an action that is not one", JSON.stringify({ ...kept, action: { kind: "no_such_action" } }), /its action is not valid/],
    ];
    for (const [label, text, reason] of cases) {
      writeFileSync(path, text);
      const read = files.read(RUN);
      expect(read.kind, label).toBe("unreadable");
      expect(read.kind === "unreadable" ? read.reason : "", label).toMatch(reason);
      // Reading changes nothing: the file is left for whoever looks into it.
      expect(readFileSync(path, "utf8"), label).toBe(text);
    }
  });

  it("removes the file of a run, and does not mind one that is not there", () => {
    files.write(FIRST.state, FIRST.action);
    files.remove(RUN);
    files.remove(RUN);
    files.remove("../outside");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the sweep of the run files (#121)", () => {
  const BOUNDS = { ttlMs: 30 * MINUTE, maxRuns: 64, now: NOW };

  it("removes the finished runs older than the delay, and leaves the others", () => {
    aged("run_a_finishedold", 31, LAST);
    // At the delay exactly a run is dropped, as the run store drops it.
    aged("run_d_finishedatthedelay", 30, LAST);
    const youngFinished = aged("run_b_finishedyoung", 29, LAST);
    const oldInFlight = aged("run_c_inflightold", 600);
    expect(files.sweep(BOUNDS)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([youngFinished, oldInFlight].sort());
  });

  it("removes a partial file older than the delay, and leaves one that may be being written", () => {
    aged("run_a_kept", 1);
    const stale = join(dir, "run_b_dead.json.4242.tmp");
    const fresh = join(dir, "run_c_live.json.4243.tmp");
    writeFileSync(stale, "{");
    writeFileSync(fresh, "{");
    utimesSync(stale, new Date(NOW - 31 * MINUTE), new Date(NOW - 31 * MINUTE));
    utimesSync(fresh, new Date(NOW - MINUTE), new Date(NOW - MINUTE));
    expect(files.sweep(BOUNDS)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["run_a_kept.json", "run_c_live.json.4243.tmp"]);
  });

  it("leaves at most the cap of run files, the most recently written", () => {
    const names = [5, 4, 3, 2, 1].map((minutes) => aged(`run_${minutes}_inflight`, minutes));
    expect(files.sweep({ ...BOUNDS, maxRuns: 3 })).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(names.slice(2).sort());
  });

  it("does not take an old file it cannot read for a finished run", () => {
    mkdirSync(dir);
    const path = join(dir, "run_a_broken.json");
    writeFileSync(path, "{");
    utimesSync(path, new Date(NOW - 600 * MINUTE), new Date(NOW - 600 * MINUTE));
    expect(files.sweep(BOUNDS)).toBe(0);
    expect(readdirSync(dir)).toEqual(["run_a_broken.json"]);
  });

  it("leaves what it cannot remove and goes on with the rest", () => {
    // A directory under the name of a run file: removing it as a file fails.
    mkdirSync(join(dir, "run_0_notafile.json"), { recursive: true });
    const old = new Date(NOW - 600 * MINUTE);
    utimesSync(join(dir, "run_0_notafile.json"), old, old);
    const names = [3, 2, 1].map((minutes) => aged(`run_${minutes}_inflight`, minutes));
    expect(files.sweep({ ...BOUNDS, maxRuns: 1 })).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["run_0_notafile.json", names[2]].sort());
  });

  it("finds nothing to do where there is no directory yet", () => {
    expect(files.sweep(BOUNDS)).toBe(0);
    expect(readdirSync(scratch)).toEqual([]);
  });
});
