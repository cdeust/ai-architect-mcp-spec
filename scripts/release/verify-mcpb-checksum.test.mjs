/**
 * Regression tests for the #23 defect class (issue #29 criterion 4).
 *
 * #23 shipped a server.json whose fileSha256 did not match the released
 * .mcpb, and nothing checked. The load-bearing cases here are therefore the
 * REJECTIONS: a mismatched hash, and a placeholder that was never patched,
 * must both fail (§13 A3, G4). Asserting only that a correct hash passes would
 * reproduce exactly the blind spot #23 was.
 */

import { cpSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ChecksumMismatchError,
  assertChecksumMatches,
  extractRecordedChecksum,
  sha256Hex,
} from "./verify-mcpb-checksum.mjs";

const REAL = "d6f0ce83456f65ffd7663966362612fa2224c7670dbc419d72db7cfccfc10815";
const serverJson = (sha) => ({
  packages: [{ registryType: "mcpb", identifier: "…/x.mcpb", fileSha256: sha }],
});

describe("mcpb checksum verification (#23 class)", () => {
  it("sha256Hex matches Node's own digest", () => {
    const bytes = Buffer.from("mcpb bundle bytes");
    expect(sha256Hex(bytes)).toHaveLength(64);
    // Deterministic: same bytes → same digest.
    expect(sha256Hex(bytes)).toBe(sha256Hex(Buffer.from("mcpb bundle bytes")));
  });

  it("passes when server.json records the artifact's real digest", () => {
    const actual = sha256Hex(Buffer.from("authentic bundle"));
    expect(() => assertChecksumMatches(serverJson(actual), actual)).not.toThrow();
  });

  it("REJECTS a mismatch — the #23 defect (recorded != artifact)", () => {
    const actual = sha256Hex(Buffer.from("the bundle that shipped"));
    // server.json still records a different (stale) hash.
    expect(() => assertChecksumMatches(serverJson(REAL), actual)).toThrow(
      ChecksumMismatchError,
    );
  });

  it("carries both digests so the failure is actionable", () => {
    const actual = sha256Hex(Buffer.from("tampered"));
    try {
      assertChecksumMatches(serverJson(REAL), actual);
      throw new Error("expected ChecksumMismatchError");
    } catch (err) {
      expect(err).toBeInstanceOf(ChecksumMismatchError);
      expect(err.expected).toBe(REAL);
      expect(err.actual).toBe(actual);
    }
  });

  it("REJECTS an unpatched placeholder (never a published placeholder)", () => {
    expect(() => extractRecordedChecksum(serverJson("PLACEHOLDER"))).toThrow();
    expect(() => extractRecordedChecksum(serverJson(""))).toThrow();
    expect(() => extractRecordedChecksum(serverJson("0".repeat(64)))).toThrow(
      /all-zero pre-release placeholder/,
    );
  });

  it("REJECTS a missing fileSha256 field", () => {
    expect(() => extractRecordedChecksum({ packages: [{}] })).toThrow();
    expect(() => extractRecordedChecksum({})).toThrow();
  });

  it("is case-insensitive on the recorded digest", () => {
    const actual = sha256Hex(Buffer.from("payload"));
    expect(() =>
      assertChecksumMatches(serverJson(actual.toUpperCase()), actual),
    ).not.toThrow();
  });
});

/**
 * Copies the script under `base` with the one module it imports, in the
 * repository's layout: scripts/release/verify-mcpb-checksum.mjs and
 * bin/is-entry.mjs. Returns the path of the copied script.
 */
function copyWithEntryHelper(base) {
  const script = join(base, "scripts", "release", "verify-mcpb-checksum.mjs");
  mkdirSync(join(base, "scripts", "release"), { recursive: true });
  mkdirSync(join(base, "bin"));
  cpSync(fileURLToPath(new URL("./verify-mcpb-checksum.mjs", import.meta.url)), script);
  cpSync(
    fileURLToPath(new URL("../../bin/is-entry.mjs", import.meta.url)),
    join(base, "bin", "is-entry.mjs"),
  );
  return script;
}

// #126: the CLI guard compared the module URL with `file://${argv[1]}`. On
// Windows, and for any path with a space, the two never match, so the release
// step exited 0 having verified nothing.
describe("run as a command", () => {
  it("runs from a directory whose name holds a space", async () => {
    const { spawnSync } = await import("node:child_process");
    const { cpSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = mkdtempSync(join(tmpdir(), "verify mcpb "));
    try {
      const script = copyWithEntryHelper(dir);
      const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("usage: verify-mcpb-checksum.mjs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Node resolves symlinks in import.meta.url but leaves argv[1] as typed. On
  // macOS tmpdir() sits under /var, a symlink to /private/var, so a URL guard
  // never matched there and the script exited 0. A linked directory gives the
  // same shape on every OS (a junction on Windows needs no privilege).
  it("runs through a symlinked directory", async () => {
    const { spawnSync } = await import("node:child_process");
    const { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = mkdtempSync(join(tmpdir(), "verify-mcpb-link-"));
    try {
      const real = join(dir, "real");
      const link = join(dir, "link");
      mkdirSync(real);
      symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
      const script = copyWithEntryHelper(real);
      const run = spawnSync(process.execPath, [join(link, relative(real, script))], {
        encoding: "utf8",
      });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("usage: verify-mcpb-checksum.mjs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
