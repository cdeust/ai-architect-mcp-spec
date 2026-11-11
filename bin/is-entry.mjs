/**
 * is-entry.mjs — "was this module started as the program?", for every script
 * that is both imported by tests and run as a command.
 *
 * One definition, because the comparison went wrong twice in three copies
 * (#126): `import.meta.url === \`file://${argv[1]}\`` never holds on Windows
 * (`file:///C:/…`) or for a path with a space (`%20`), and Node resolves
 * symlinks in `import.meta.url` but leaves `argv[1]` as typed, so a URL
 * comparison also fails under a linked directory (macOS `tmpdir()` is under
 * /var -> /private/var). In each case the script exited 0 without running.
 *
 * It lives in bin/ so that the plugin launcher depends on nothing outside
 * its own directory.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * precondition:  `moduleUrl` is the caller's `import.meta.url`; `argv1` is
 *                the program path Node was started with (`process.argv[1]`),
 *                or undefined (`node -e`, REPL).
 * postcondition: true iff both name the same file once symlinks are resolved
 *                on both sides. False, never a throw, when `argv1` is
 *                missing or either path does not exist.
 */
export function isEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
