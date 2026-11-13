/**
 * #243 — the server writes its files in `~/.prd-gen/`, nowhere else, and
 * PRIVACY.md names each of them.
 *
 * `conclude_verification` with `claim_types` appended its observation log
 * at a path relative to the working directory: a server a host had started
 * in the user's project created `packages/benchmark/calibration/data/`
 * there. PRIVACY.md named one file, `evidence.db`, of the three.
 *
 * The built server is started in an empty working directory with an empty
 * home, and asked for what makes it write each file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tryCreateEvidenceRepository } from "@prd-gen/core";
import { startStdioServer, type StdioServer } from "./stdio-server.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const TEST_TIMEOUT_MS = 60_000;

// Skipped when better-sqlite3 cannot be loaded here: the server then opens
// neither database and flushes no observation (same contract as
// evidence-db-path.test.ts).
const probeDir = mkdtempSync(join(tmpdir(), "stored-files-probe-"));
const probe = tryCreateEvidenceRepository(join(probeDir, "evidence.db"));
probe?.close();
rmSync(probeDir, { recursive: true, force: true });
const sqliteAvailable = probe !== null;

let scratch: string;
let project: string;
let home: string;
let server: StdioServer | undefined;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "prd-gen-stored-"));
  project = join(scratch, "project");
  home = join(scratch, "home");
  mkdirSync(project);
  mkdirSync(home);
  if (!sqliteAvailable) return;
  server = await startStdioServer(undefined, {
    cwd: project,
    // The evidence database goes to its default place, as the two others do.
    unset: ["PRD_GEN_EVIDENCE_DB"],
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
    env: { HOME: home, USERPROFILE: home },
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** The files of a directory, without the -wal and -shm companions SQLite keeps while a database is open. */
function storedFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm"))
    .sort();
}

describe.skipIf(!sqliteAvailable)("what the server writes, and where (#243)", () => {
  it(
    "writes three files in ~/.prd-gen and nothing in its working directory",
    async () => {
      const concluded = await server!.call("conclude_verification", {
        scope: "section",
        section_type: "requirements",
        run_id: "stored-files",
        claim_types: { "FR-001": "fr_traceability" },
        verdicts: [
          {
            judge: { kind: "genius", name: "feynman" },
            claim_id: "FR-001",
            verdict: "PASS",
            rationale: "stored-files test",
            caveats: [],
            confidence: 0.9,
          },
        ],
      });
      expect(concluded.isError, concluded.text).toBe(false);
      const history = await server!.call("get_quality_history", { limit: 1 });
      expect(history.isError, history.text).toBe(false);

      expect(readdirSync(project)).toEqual([]);
      expect(readdirSync(home)).toEqual([".prd-gen"]);
      const stored = storedFiles(join(home, ".prd-gen"));
      expect(stored).toEqual(["evidence.db", "judge-observation-log.jsonl", "reliability.db"]);

      const lines = readFileSync(join(home, ".prd-gen", "judge-observation-log.jsonl"), "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ claim_id: "FR-001", run_id: "stored-files" });

      // PRIVACY.md is the statement of what is stored: a file the server
      // writes and the statement does not name is a defect of one of the two.
      const privacy = readFileSync(join(REPO, "PRIVACY.md"), "utf-8");
      for (const name of stored) expect(privacy, `PRIVACY.md does not name ${name}`).toContain(`~/.prd-gen/${name}`);
    },
    TEST_TIMEOUT_MS,
  );
});
