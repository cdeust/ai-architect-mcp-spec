/**
 * Verify that server.json's recorded .mcpb checksum matches the actual bundle.
 *
 * Issue #29, criterion 4 — the proper close of #23. #23 was a *published
 * integrity value that did not match the artifact*: release.yml recorded a
 * placeholder `fileSha256` in server.json and, for a while, nothing wrote the
 * real one back. The instance was fixed (the release job now patches it); this
 * module closes the CLASS by making the match CHECKABLE — in the release
 * pipeline (a step runs this and fails the release on mismatch) and in tests
 * (a mismatched hash must be rejected, §13 A3 / G4).
 *
 * Pure Node standard library (node:crypto, node:fs) so it runs in the release
 * job with no dependency install and is trivially unit-testable.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Thrown when the artifact's digest does not equal server.json's record. */
export class ChecksumMismatchError extends Error {
  /**
   * @param {string} expected server.json packages[0].fileSha256 (what a
   *   consumer trusts and downloads against)
   * @param {string} actual digest computed from the built .mcpb bytes
   */
  constructor(expected, actual) {
    super(
      `server.json .mcpb checksum mismatch: server.json records ` +
        `${expected}, built artifact is ${actual}. This is the #23 defect ` +
        `class — a published integrity value that does not match the artifact.`,
    );
    this.name = "ChecksumMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** SHA-256 hex of a Buffer/Uint8Array. */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read the recorded checksum out of a parsed server.json.
 *
 * Precondition: `serverJson` is the parsed object; its `packages[0]` describes
 * the .mcpb (`registryType: "mcpb"`).
 * Postcondition: returns the lowercase 64-char hex digest.
 * Throws Error if the field is missing, not a string, or still a placeholder
 * (a non-64-hex value) — a placeholder must fail loudly, which is exactly the
 * state #23 shipped silently.
 */
export function extractRecordedChecksum(serverJson) {
  const pkg = serverJson?.packages?.[0];
  const sha = pkg?.fileSha256;
  if (typeof sha !== "string") {
    throw new Error("server.json packages[0].fileSha256 is missing or not a string");
  }
  const normalized = sha.trim().toLowerCase();
  if (normalized === "0".repeat(64)) {
    throw new Error(
      "server.json packages[0].fileSha256 is the all-zero pre-release placeholder; " +
        "a placeholder must never be published",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(
      `server.json packages[0].fileSha256 is not a SHA-256 digest ` +
        `(got ${JSON.stringify(sha)}); a placeholder must never be published`,
    );
  }
  return normalized;
}

/**
 * Assert the recorded checksum equals the artifact digest.
 *
 * Precondition: `serverJson` parsed; `actualSha256` is the digest of the built
 * .mcpb (from {@link sha256Hex}).
 * Postcondition: returns undefined iff they match; otherwise throws
 * ChecksumMismatchError. No return value means "probably fine".
 */
export function assertChecksumMatches(serverJson, actualSha256) {
  const expected = extractRecordedChecksum(serverJson);
  const actual = String(actualSha256).trim().toLowerCase();
  if (expected !== actual) {
    throw new ChecksumMismatchError(expected, actual);
  }
}

/**
 * CLI: `verify-mcpb-checksum.mjs <mcpb-path> <server.json-path>`.
 * Exit 0 on match, 1 on mismatch, 2 on IO/format error.
 */
export async function main(argv) {
  const [mcpbPath, serverJsonPath] = argv;
  if (!mcpbPath || !serverJsonPath) {
    process.stderr.write(
      "usage: verify-mcpb-checksum.mjs <mcpb-path> <server.json-path>\n",
    );
    return 2;
  }
  let serverJson;
  let actual;
  try {
    serverJson = JSON.parse(await readFile(serverJsonPath, "utf8"));
    actual = sha256Hex(await readFile(mcpbPath));
  } catch (err) {
    process.stderr.write(`verification could not run: ${err.message}\n`);
    return 2;
  }
  try {
    assertChecksumMatches(serverJson, actual);
  } catch (err) {
    if (err instanceof ChecksumMismatchError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    process.stderr.write(`verification could not run: ${err.message}\n`);
    return 2;
  }
  process.stdout.write(`OK: server.json checksum matches ${mcpbPath} (${actual})\n`);
  return 0;
}

// Run as a CLI when invoked directly (not when imported by tests).
// Compare real paths, not URLs: `file://${argv[1]}` never equals the module
// URL on Windows (`file:///C:/…`) or for a path with a space (`%20`), and
// Node resolves symlinks in import.meta.url but not in argv[1] (macOS tmpdir
// is under /var -> /private/var). Either way the script exited 0 without
// doing anything (#126). Same check as isEntry() in bin/ensure-deps.mjs.
function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
