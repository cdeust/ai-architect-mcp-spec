/**
 * #121 — the runs of the server: found in memory, found again from their
 * file by a server that starts, dropped from both together.
 *
 * A second `KeptRuns` on the same directory stands for the server after a
 * restart: it shares nothing with the first but the files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeptRuns } from "../kept-runs.js";
import { RunFiles } from "../run-files.js";
import { cannedRun } from "./canned-run.js";

const RUN = "run_mwemwsre_a3bsp0";
const STEPS = cannedRun(RUN);
const FIRST = STEPS[0]!;
const SECOND = STEPS[1]!;
const LAST = STEPS[STEPS.length - 1]!;
const MINUTE = 60_000;

let scratch: string;
let dir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "prd-gen-kept-runs-"));
  dir = join(scratch, "runs");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const server = (options: ConstructorParameters<typeof KeptRuns>[1] = {}) => new KeptRuns(new RunFiles(dir), options);

describe("the runs a server keeps (#121)", () => {
  it("finds a run it keeps, with the action kept last", () => {
    const runs = server();
    runs.keep(FIRST.state, FIRST.action);
    runs.keep(SECOND.state, SECOND.action);
    expect(runs.find(RUN)).toEqual({ kind: "found", run: SECOND });
    expect(runs.inFlightCount()).toBe(1);
  });

  it("finds, after a restart, the run and the action the server before it kept last", () => {
    const before = server();
    before.keep(FIRST.state, FIRST.action);
    before.keep(SECOND.state, SECOND.action);

    const after = server();
    // Nothing is loaded until a tool names the run.
    expect(after.inFlightCount()).toBe(0);
    expect(after.find(RUN)).toEqual({ kind: "found", run: SECOND });
    // The run is in memory again: it counts, and it is found without its file.
    expect(after.inFlightCount()).toBe(1);
    rmSync(join(dir, `${RUN}.json`));
    expect(after.find(RUN)).toEqual({ kind: "found", run: SECOND });
  });

  it("answers unknown for a run neither the memory nor a file holds", () => {
    expect(server().find(RUN)).toEqual({ kind: "unknown" });
    expect(server().find("../outside")).toEqual({ kind: "unknown" });
  });

  it("says so when the file of a run cannot be read as that run, and leaves the file", () => {
    server().keep(FIRST.state, FIRST.action);
    writeFileSync(join(dir, `${RUN}.json`), "{");
    const found = server().find(RUN);
    expect(found.kind).toBe("unreadable");
    expect(readdirSync(dir)).toEqual([`${RUN}.json`]);
  });

  it("drops a finished run from memory and from disk once the delay has passed, and says which", () => {
    let now = 0;
    const dropped: string[] = [];
    const runs = server({ clock: () => now, ttlMs: 30 * MINUTE, onDrop: (runId) => dropped.push(runId) });
    runs.keep(LAST.state, LAST.action);
    // A finished run is not in flight.
    expect(runs.inFlightCount()).toBe(0);
    now = 29 * MINUTE;
    expect(runs.find(RUN).kind).toBe("found");
    // The delay runs from the last access.
    now = 29 * MINUTE + 30 * MINUTE;
    expect(runs.find(RUN)).toEqual({ kind: "unknown" });
    expect(dropped).toEqual([RUN]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps a run that is not finished, in memory and on disk, whatever its age", () => {
    let now = 0;
    const runs = server({ clock: () => now, ttlMs: 30 * MINUTE });
    runs.keep(FIRST.state, FIRST.action);
    now = 600 * MINUTE;
    expect(runs.find(RUN).kind).toBe("found");
    expect(readdirSync(dir)).toEqual([`${RUN}.json`]);
  });

  it("applies the bounds to the files of earlier servers at its first use, and only then", () => {
    const earlier = server();
    earlier.keep({ ...LAST.state, run_id: "run_a_finishedold" }, LAST.action);
    earlier.keep({ ...FIRST.state, run_id: "run_b_inflightold" }, FIRST.action);
    const old = new Date(Date.now() - 31 * MINUTE);
    for (const name of readdirSync(dir)) utimesSync(join(dir, name), old, old);

    const runs = server();
    expect(readdirSync(dir).sort()).toEqual(["run_a_finishedold.json", "run_b_inflightold.json"]);
    expect(runs.find("run_a_finishedold")).toEqual({ kind: "unknown" });
    expect(readdirSync(dir)).toEqual(["run_b_inflightold.json"]);
    expect(runs.find("run_b_inflightold").kind).toBe("found");
  });

  it("goes on in memory when the file cannot be written, and says it once", () => {
    // The directory of the runs is a file: nothing can be written under it.
    writeFileSync(dir, "");
    const warn = vi.fn();
    const runs = server({ warn });
    runs.keep(FIRST.state, FIRST.action);
    runs.keep(SECOND.state, SECOND.action);
    expect(runs.find(RUN)).toEqual({ kind: "found", run: SECOND });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(RUN);
    expect(warn.mock.calls[0]![0]).toContain("do not survive a restart");
    // A server that starts then knows nothing of the run.
    expect(server().find(RUN)).toEqual({ kind: "unknown" });
  });
});
