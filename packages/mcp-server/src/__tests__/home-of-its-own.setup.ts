/**
 * Every test file of this package runs with a home directory of its own.
 *
 * The server keeps files under the home directory (`~/.prd-gen/`: its
 * databases, its observation log and, since #121, one file per pipeline
 * run). A test that starts a run, in process or through the built server,
 * wrote them in the home of whoever ran the suite: measured before this
 * file, a run of the suite left `reliability.db` and the observation log
 * there, and would have left run files.
 *
 * Runs before the test file's imports, so the modules that compute a path
 * from `homedir()` when they load see this home. A server a test starts
 * inherits it, unless the test gives it another one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const home = mkdtempSync(join(tmpdir(), "prd-gen-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

afterAll(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows refuses while a database opened in this process is still
    // open; the directory is under the system's temporary directory.
  }
});
