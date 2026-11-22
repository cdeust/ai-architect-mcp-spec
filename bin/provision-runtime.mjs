// A completed runtime is immutable. npm runs in a private directory on the same
// filesystem, and a successful rename publishes the entire directory at once.
// fs.link exclusively creates the claim for an installation attempt from an
// already-written owner record. See https://nodejs.org/api/fs.html#fslinkexistingpath-newpath-callback
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MARKER_NAME = ".prd-gen-deps-installed";
export const LOCK_NAME = ".prd-gen-deps.lock"; // Lock format used by older installations.
const POLL_MS = 100; // Existing launcher polling interval; never a liveness deadline.
const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readOptional(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function lockfileDigest(serverDir) {
  try {
    return digest(readFileSync(join(serverDir, "package-lock.json")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function processExists(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function legacyReady(serverDir, lockHash) {
  return lockHash != null && readOptional(join(serverDir, LOCK_NAME)) === undefined &&
    readOptional(join(serverDir, "node_modules", MARKER_NAME)) === lockHash;
}

function snapshot(serverDir) {
  const files = ["package-lock.json", "package.json", "index.js"].map(name =>
    [name, readFileSync(join(serverDir, name))]);
  const hashes = files.map(([, bytes]) => digest(bytes));
  // A native addon belongs to the runtime ABI, OS and architecture as well as the lockfile.
  const key = digest(JSON.stringify([process.platform, process.arch, process.versions.modules, ...hashes]));
  const root = join(dirname(serverDir), ".prd-gen-runtime");
  return { files, lockHash: hashes[0], root, published: join(root, key) };
}

function ready({ published, lockHash }) {
  return readOptional(join(published, "node_modules", MARKER_NAME)) === lockHash;
}

export function needsProvisioning(serverDir) {
  const hash = lockfileDigest(serverDir);
  return !legacyReady(serverDir, hash) && (hash === null || !ready(snapshot(serverDir)));
}

// A dead owner can leave its npm child running. Its generation and private
// working directory remain its own. Contenders compete for the next slot;
// nobody unlinks a peer's claim, even on recovery after a crash.
function reserve(runtime, ownerFile) {
  let announced = false;
  for (let generation = 0; !ready(runtime);) {
    const claim = runtime.published + ".owner-" + generation;
    try {
      linkSync(ownerFile, claim);
      return claim;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const record = readOptional(claim);
    if (record === undefined) continue; // The owner released its own slot.
    const pid = Number(record);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid installation owner in " + claim);
    if (processExists(pid)) {
      if (!announced) {
        process.stderr.write(`prd-gen: another launch (pid ${pid}) is installing the runtime deps; waiting…\n`);
        announced = true;
      }
      wait();
    } else {
      generation++;
    }
  }
}

export function provisionRuntime(serverDir, install) {
  // Allow a live old-style installer to finish. An abandoned or incomplete
  // legacy lock is left in place: its npm child might still own node_modules.
  const legacyLock = join(serverDir, LOCK_NAME);
  const owner = Number(readOptional(legacyLock));
  if (processExists(owner)) {
    process.stderr.write(`prd-gen: another launch (pid ${owner}) is installing the runtime deps; waiting…\n`);
    do { wait(); } while (processExists(Number(readOptional(legacyLock))));
  }
  if (legacyReady(serverDir, lockfileDigest(serverDir))) return serverDir;
  const runtime = snapshot(serverDir);
  if (ready(runtime)) return runtime.published;
  mkdirSync(runtime.root, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(runtime.root, "install-"));
  const ownerFile = join(stage, ".owner");
  let claim;
  let published = false;
  try {
    writeFileSync(ownerFile, String(process.pid), { mode: 0o600 });
    claim = reserve(runtime, ownerFile);
    // A previous owner can publish and release between our probe and link.
    if (claim && !ready(runtime)) {
      for (const [name, bytes] of runtime.files) writeFileSync(join(stage, name), bytes);
      install(stage);
      writeFileSync(join(stage, "node_modules", MARKER_NAME), runtime.lockHash + "\n");
      unlinkSync(ownerFile);
      renameSync(stage, runtime.published);
      published = true;
    }
    return runtime.published;
  } finally {
    if (claim) unlinkSync(claim);
    if (!published) rmSync(stage, { recursive: true, force: true });
  }
}
