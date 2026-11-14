/**
 * The runs the server keeps on disk (#121): one file per run,
 * `~/.prd-gen/runs/<run_id>.json`, holding the state of the run and the
 * action its host has to execute next.
 *
 * Until #121 both lived only in the memory of the server process, so a
 * restart of the server, or a reload of the plugin, lost every run: its id
 * then named nothing.
 *
 * A file and not a table: a run is one document, read and written whole
 * (run-store.ts: the contract of a persistent store "is just get / set /
 * delete"), and the store has to exist where `better-sqlite3` does not. The
 * `.mcpb` leaves that addon out (#124), and a packaged host is where a
 * plugin reload happens.
 *
 * This module only reads and writes files. When a run is kept, found or
 * dropped is decided by kept-runs.ts.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  NextActionSchema,
  PipelineStateSchema,
  isTerminalRun,
  type NextAction,
  type PipelineState,
} from "@prd-gen/orchestration";

/** Where the server keeps its runs: beside its databases. */
export const RUNS_DIR = join(homedir(), ".prd-gen", "runs");

/**
 * The form of the ids `start_pipeline` generates: `run_`, the time in base
 * 36, `_`, up to six random characters in base 36. A run id comes from the
 * host and becomes a file name, so only an id of this form is ever turned
 * into a path.
 */
const RUN_ID = /^run_[0-9a-z]+_[0-9a-z]*$/;

/** The layout of a run file. A file of another version is not read. */
const FILE_VERSION = 1;

const RUN_FILE = ".json";
/** A file being written; it takes its final name by a rename. */
const PARTIAL_FILE = ".tmp";

export interface KeptRun {
  readonly state: PipelineState;
  /** The action the host has to execute next; null when none was kept. */
  readonly action: NextAction | null;
}

export type RunFileRead =
  | { readonly kind: "found"; readonly run: KeptRun }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string };

export interface SweepBounds {
  /** A finished run is dropped once its file is older than this. */
  readonly ttlMs: number;
  /** At most this many run files are left. */
  readonly maxRuns: number;
  readonly now: number;
}

interface RunFileEntry {
  readonly path: string;
  readonly mtimeMs: number;
}

export class RunFiles {
  constructor(private readonly dir: string) {}

  /**
   * postcondition: the path of the file of run `runId`, or null when `runId`
   *                is not of the form the server generates.
   */
  pathOf(runId: string): string | null {
    return RUN_ID.test(runId) ? join(this.dir, runId + RUN_FILE) : null;
  }

  /**
   * precondition:  `state.run_id` is an id the server generated.
   * postcondition: the file of the run holds `state` and `action`, whole: it
   *                is written under another name and renamed, so a reader
   *                sees the previous content or this one. The directory and
   *                the file are readable by their owner only.
   * throws:        when the id is not a run id, or the file system refuses.
   */
  write(state: PipelineState, action: NextAction | null): void {
    const path = this.pathOf(state.run_id);
    if (path === null) throw new Error(`"${state.run_id}" is not a run id`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const partial = `${path}.${process.pid}${PARTIAL_FILE}`;
    writeFileSync(partial, JSON.stringify({ version: FILE_VERSION, state, action }), { mode: 0o600 });
    renameSync(partial, path);
  }

  /**
   * postcondition: `found` with the state and the action of the file, both
   *                checked against their schemas; `absent` when `runId` is
   *                not a run id or has no file; `unreadable`, with the
   *                reason, when the file is there and is not a run of this
   *                version under this id. Nothing is written or removed.
   */
  read(runId: string): RunFileRead {
    const path = this.pathOf(runId);
    if (path === null) return { kind: "absent" };
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      // ENOTDIR: the directory of the runs is not one, so it holds no run.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
      return { kind: "unreadable", reason: String(error) };
    }
    return parseRunFile(runId, text);
  }

  /**
   * postcondition: run `runId` has no file, unless the file system refuses;
   *                a file left that way is removed by a later sweep. Never
   *                throws: this runs while a run is dropped from memory.
   */
  remove(runId: string): void {
    const path = this.pathOf(runId);
    if (path === null) return;
    try {
      rmSync(path, { force: true });
    } catch {
      // Left for the sweep.
    }
  }

  /**
   * Applies to the files the two bounds of the run store, with one
   * difference. The store never drops a run in progress: its memory ends
   * with the process. The directory does not, and a run nobody comes back to
   * would stay in it for ever, so beyond the cap a run in progress goes too,
   * after every finished one (review of #249).
   *
   * postcondition: no file of a finished run, and no partial file, is older
   *                than `ttlMs`; at most `maxRuns` run files are left: the
   *                runs in progress before the finished ones, and among
   *                each the most recently written. Returns the number of
   *                files removed. A file that cannot be read as JSON is not
   *                a finished run: it is kept until the cap removes it. A
   *                file the file system refuses to remove is left, and the
   *                sweep goes on: this never throws, so that the first tool
   *                call of a server does not fail on a leftover.
   */
  sweep(bounds: SweepBounds): number {
    let removed = 0;
    const drop = (entry: RunFileEntry) => {
      try {
        rmSync(entry.path, { force: true });
        removed += 1;
      } catch {
        // Left where it is.
      }
    };
    const old = (entry: RunFileEntry) => bounds.now - entry.mtimeMs >= bounds.ttlMs;
    this.list(PARTIAL_FILE).filter(old).forEach(drop);
    const kept: RunFileEntry[] = [];
    for (const entry of this.list(RUN_FILE)) {
      if (old(entry) && isFinishedRunFile(entry.path)) drop(entry);
      else kept.push(entry);
    }
    if (kept.length <= bounds.maxRuns) return removed;
    const ranked = kept
      .map((entry) => ({ entry, finished: isFinishedRunFile(entry.path) }))
      .sort((a, b) => Number(a.finished) - Number(b.finished) || b.entry.mtimeMs - a.entry.mtimeMs);
    ranked.slice(bounds.maxRuns).forEach(({ entry }) => drop(entry));
    return removed;
  }

  private list(suffix: string): RunFileEntry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const entries: RunFileEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(suffix)) continue;
      const path = join(this.dir, name);
      try {
        entries.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // Removed since it was listed.
      }
    }
    return entries;
  }
}

function parseRunFile(runId: string, text: string): RunFileRead {
  let doc: { version?: unknown; state?: unknown; action?: unknown };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch (error) {
    return { kind: "unreadable", reason: `not JSON (${String(error)})` };
  }
  if (doc === null || typeof doc !== "object" || doc.version !== FILE_VERSION) {
    return { kind: "unreadable", reason: `not a run file of version ${FILE_VERSION}` };
  }
  const state = PipelineStateSchema.safeParse(doc.state);
  if (!state.success) return { kind: "unreadable", reason: `its state is not valid (${state.error.message})` };
  if (state.data.run_id !== runId) {
    return { kind: "unreadable", reason: `it holds run ${state.data.run_id}` };
  }
  if (doc.action === null) return { kind: "found", run: { state: state.data, action: null } };
  const action = NextActionSchema.safeParse(doc.action);
  if (!action.success) return { kind: "unreadable", reason: `its action is not valid (${action.error.message})` };
  return { kind: "found", run: { state: state.data, action: action.data } };
}

/** Whether the file at `path` holds a run that reached its last step. */
function isFinishedRunFile(path: string): boolean {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { state?: { current_step?: unknown } };
    const step = doc?.state?.current_step;
    return typeof step === "string" && isTerminalRun({ current_step: step as PipelineState["current_step"] });
  } catch {
    return false;
  }
}
