import { execFile } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { DefineHandoffV1 } from "@prd-gen/core";
import { MAX_RESPONSE_CHARS, readReviewAuthority, reviewDigest, type VerifiedPlan } from "@prd-gen/orchestration";

const execute = promisify(execFile);
// Four bytes is the maximum length of a UTF-8 code point (RFC 3629).
const MAX_REVIEW_BYTES = 4 * MAX_RESPONSE_CHARS;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type FileIdentity = Pick<BigIntStats, "dev" | "ino">;

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identity(path: string): FileIdentity {
  return statSync(path, { bigint: true });
}

/** Real paths may preserve input case on a case-insensitive filesystem. */
function pathIsWithin(boundary: FileIdentity, path: string): boolean {
  let current = path;
  for (;;) {
    if (sameFile(boundary, identity(current))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

// Git gets no inherited checkout overrides and cannot fetch missing objects or run diff helpers.
interface ReviewGit {
  readonly executable: string;
  readonly repository: string;
}

async function git({ executable, repository }: ReviewGit, ...args: string[]): Promise<string> {
  return runGit(executable, repository, args);
}

async function runGit(executable: string, repository: string, args: string[], attributes?: string): Promise<string> {
  const { stdout } = await execute(executable, [
    "--no-pager", "--no-replace-objects", "-C", repository,
    "-c", "core.fsmonitor=false", "-c", "core.quotePath=true", "-c", `core.attributesFile=${devNull}`,
    ...(attributes ? [`--attr-source=${attributes}`] : []), ...args,
  ], {
    cwd: dirname(executable),
    encoding: null,
    maxBuffer: MAX_REVIEW_BYTES,
    env: {
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_GRAFT_FILE: devNull,
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    },
  });
  return utf8.decode(stdout);
}

async function verifyRevisions(repository: ReviewGit, base: string, head: string): Promise<boolean> {
  for (const revision of [base, head]) {
    const resolved = await git(repository, "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`);
    if (resolved !== revision + "\n") return false;
  }
  await git(repository, "merge-base", "--is-ancestor", base, head);
  return true;
}

function readAuthorityFile(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_REVIEW_BYTES) return undefined;
    // A regular file may return a short read. Accumulate to EOF, with one extra
    // byte to reject growth after fstat without ever allocating additional space.
    const content = Buffer.alloc(info.size + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, content, { offset: length, length: content.length - length, position: null });
      if (read === 0) break;
      length += read;
      if (length === content.length) return undefined;
    }
    if (length !== info.size) return undefined;
    const text = utf8.decode(content.subarray(0, length));
    return text.length <= MAX_RESPONSE_CHARS ? JSON.parse(text) : undefined;
  } finally {
    closeSync(fd);
  }
}

function gitPathLine(text: string): string | undefined {
  // Git terminates its path records with line breaks. Spaces are part of the path.
  const path = text.replace(/[\r\n]+$/, "");
  return path && !/[\r\n]/.test(path) ? path : undefined;
}

function gitMetadata(repository: string): string[] | undefined {
  const dotGit = join(repository, ".git");
  const info = statSync(dotGit);
  let directory = dotGit;
  if (!info.isDirectory()) {
    if (!info.isFile()) return undefined;
    const marker = gitPathLine(utf8.decode(readFileSync(dotGit)));
    const prefix = "gitdir: ";
    if (!marker?.startsWith(prefix) || marker.length === prefix.length) return undefined;
    directory = resolve(repository, marker.slice(prefix.length));
  }
  const gitDir = realpathSync(directory);
  const commonMarker = join(gitDir, "commondir");
  if (!existsSync(commonMarker)) return [gitDir];
  const common = gitPathLine(utf8.decode(readFileSync(commonMarker)));
  return common ? [gitDir, realpathSync(resolve(gitDir, common))] : undefined;
}

async function reviewTarget(repositoryPath: string, gitPath: string, source: string) {
  const repository = realpathSync(repositoryPath);
  const executable = realpathSync(gitPath);
  const metadata = gitMetadata(repository);
  if (!metadata) return refusal("review_repository_invalid");
  const checkout = identity(repository);
  const protectedDirs = [checkout, ...metadata.map(identity)];
  if (protectedDirs.some(dir => pathIsWithin(dir, source) || pathIsWithin(dir, executable))) {
    return refusal("review_authority_invalid");
  }
  const target = { executable, repository };
  const root = await git(target, "rev-parse", "--show-toplevel");
  const observed = gitPathLine(root);
  if (!observed || !sameFile(identity(observed), checkout)) return refusal("review_repository_invalid");
  return target;
}

const refusal = (reason: string) => ({ error: { code: reason, message: "The implementation review dossier could not be prepared." } });

export async function prepareImplementationReview(
  paths: { authority?: string; repository?: string; repositoryId?: string; git?: string },
  reviewId: string | undefined, plan: VerifiedPlan, define: DefineHandoffV1,
) {
  const { authority: path, repository: repositoryPath, repositoryId, git: gitPath } = paths;
  if (!path || !repositoryPath || !repositoryId || !gitPath || !reviewId ||
      !isAbsolute(path) || !isAbsolute(repositoryPath) || !isAbsolute(gitPath)) {
    return refusal("review_authority_unavailable");
  }

  try {
    const source = realpathSync(path);
    const target = await reviewTarget(repositoryPath, gitPath, source);
    if ("error" in target) return target;
    const authority = readReviewAuthority(readAuthorityFile(source), reviewId, plan);
    if (!authority) return refusal("review_authority_invalid");
    if (authority.repository_id !== repositoryId) return refusal("review_repository_invalid");

    const { base_revision: base, reviewed_revision: head } = authority;
    if (base === head) return refusal("review_revision_invalid");
    try {
      if (!(await verifyRevisions(target, base, head))) return refusal("review_revision_invalid");
    } catch {
      return refusal("review_revision_invalid");
    }
    const diff = await runGit(target.executable, target.repository, [
      "diff", "--binary", "--full-index", "--find-renames",
      "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/",
      "--no-relative", "--ignore-submodules=none", "--submodule=short", `-O${devNull}`, base, head, "--",
    ], head);

    return { implementation_review: {
      version: 1,
      status: "ready_for_review",
      review_id: authority.review_id,
      run_id: plan.run_id,
      step: plan.proposal.step,
      repository_id: authority.repository_id,
      base_revision: base,
      reviewed_revision: head,
      plan_sha256: plan.plan_sha256,
      approval_sha256: authority.decision.approval_sha256,
      diff_sha256: reviewDigest(diff),
      diff,
      acceptance: define.acceptance.map(criterion => ({ ...criterion, status: "evidence_required" })),
    } };
  } catch (error) {
    return refusal((error as NodeJS.ErrnoException | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? "review_response_too_large"
      : "review_evidence_unavailable");
  }
}
