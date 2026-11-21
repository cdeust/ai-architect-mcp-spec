import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { MAX_RESPONSE_CHARS, readReviewAuthority, reviewDigest } from "@prd-gen/orchestration";
const execute = promisify(execFile);
// Git for Windows translates this literal, and Git uses it to reset diff.orderFile.
const GIT_NULL_PATH = "/dev/null";
// Four bytes is the maximum length of a UTF-8 code point (RFC 3629).
const MAX_REVIEW_BYTES = 4 * MAX_RESPONSE_CHARS;
// Source: Git v2.56.1, setup.c, read_gitfile_raw caps the metadata pointer at 1 MiB.
const MAX_GIT_MARKER_BYTES = 1 << 20;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function identity(path) {
    return statSync(path, { bigint: true });
}
/** Real paths may preserve input case on a case-insensitive filesystem. */
function pathIsWithin(boundary, path) {
    let current = path;
    for (;;) {
        if (sameFile(boundary, identity(current)))
            return true;
        const parent = dirname(current);
        if (parent === current)
            return false;
        current = parent;
    }
}
async function git({ executable, repository }, ...args) {
    return runGit(executable, repository, args);
}
async function runGit(executable, repository, args, attributes) {
    const { stdout } = await execute(executable, [
        "--no-pager", "--no-replace-objects", "-C", repository,
        "-c", "core.fsmonitor=false", "-c", "core.quotePath=true", "-c", `core.attributesFile=${GIT_NULL_PATH}`,
        ...(attributes ? [`--attr-source=${attributes}`] : []), ...args,
    ], {
        cwd: dirname(executable),
        encoding: null,
        maxBuffer: MAX_REVIEW_BYTES,
        env: {
            SystemRoot: process.env.SystemRoot,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_ATTR_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: GIT_NULL_PATH,
            GIT_NO_LAZY_FETCH: "1",
            GIT_ALLOW_PROTOCOL: "",
            GIT_GRAFT_FILE: GIT_NULL_PATH,
            GIT_OPTIONAL_LOCKS: "0",
            LC_ALL: "C",
        },
    });
    return utf8.decode(stdout);
}
async function verifyRevisions(repository, base, head) {
    for (const revision of [base, head]) {
        const resolved = await git(repository, "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`);
        if (resolved !== revision + "\n")
            return false;
    }
    await git(repository, "merge-base", "--is-ancestor", base, head);
    return true;
}
function openReadOnly(path) {
    return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
}
/** Takes ownership of the descriptor. Undefined denotes a failed validation. */
function readRegularFile(fd, maxBytes, singleLink) {
    try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > maxBytes || (singleLink && info.nlink !== 1))
            return undefined;
        // A regular file may return a short read. Accumulate to EOF, with one extra
        // byte to reject growth after fstat without ever allocating additional space.
        const content = Buffer.alloc(info.size + 1);
        let length = 0;
        for (;;) {
            const read = readSync(fd, content, { offset: length, length: content.length - length, position: null });
            if (read === 0)
                break;
            length += read;
            if (length === content.length)
                return undefined;
        }
        if (length !== info.size)
            return undefined;
        return utf8.decode(content.subarray(0, length));
    }
    finally {
        closeSync(fd);
    }
}
/** Null denotes an absent marker. Other open failures abort the review. */
function readGitMarker(path) {
    let fd;
    try {
        fd = openReadOnly(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    return readRegularFile(fd, MAX_GIT_MARKER_BYTES, false);
}
function gitPathLine(text) {
    // Git terminates its path records with line breaks. Spaces are part of the path.
    return /^([^\r\n]+)[\r\n]*$/.exec(text)?.[1];
}
function gitMetadata(repository) {
    const dotGit = join(repository, ".git");
    const info = statSync(dotGit);
    let directory = dotGit;
    if (!info.isDirectory()) {
        if (!info.isFile())
            return undefined;
        const marker = readGitMarker(dotGit);
        const prefix = "gitdir: ";
        if (!marker?.startsWith(prefix))
            return undefined;
        const path = gitPathLine(marker.slice(prefix.length));
        if (!path)
            return undefined;
        directory = resolve(repository, path);
    }
    const gitDir = realpathSync(directory);
    const data = readGitMarker(join(gitDir, "commondir"));
    if (data === null)
        return [gitDir];
    const common = data === undefined ? undefined : gitPathLine(data);
    return common ? [gitDir, realpathSync(resolve(gitDir, common))] : undefined;
}
async function reviewTarget(repositoryPath, gitPath, source) {
    const repository = realpathSync(repositoryPath);
    const executable = realpathSync(gitPath);
    const metadata = gitMetadata(repository);
    if (!metadata)
        return refusal("review_repository_invalid");
    const checkout = identity(repository);
    const protectedDirs = [checkout, ...metadata.map(identity)];
    if (protectedDirs.some(dir => pathIsWithin(dir, source) || pathIsWithin(dir, executable))) {
        return refusal("review_authority_invalid");
    }
    const target = { executable, repository };
    const root = await git(target, "rev-parse", "--show-toplevel");
    const observed = gitPathLine(root);
    if (!observed || !sameFile(identity(observed), checkout))
        return refusal("review_repository_invalid");
    return target;
}
const refusal = (reason) => ({ error: { code: reason, message: "The implementation review dossier could not be prepared." } });
function loadReviewAuthority(source, reviewId, plan) {
    const text = readRegularFile(openReadOnly(source), MAX_REVIEW_BYTES, true);
    if (text === undefined || text.length > MAX_RESPONSE_CHARS)
        return refusal("review_authority_invalid");
    const authority = readReviewAuthority(JSON.parse(text), reviewId, plan);
    return authority ?? refusal("review_authority_invalid");
}
export async function prepareImplementationReview(paths, reviewId, plan, define) {
    const { authority: path, repository: repositoryPath, repositoryId, git: gitPath } = paths;
    if (!path || !repositoryPath || !repositoryId || !gitPath || !reviewId ||
        !isAbsolute(path) || !isAbsolute(repositoryPath) || !isAbsolute(gitPath)) {
        return refusal("review_authority_unavailable");
    }
    try {
        const source = realpathSync(path);
        const target = await reviewTarget(repositoryPath, gitPath, source);
        if ("error" in target)
            return target;
        const authority = loadReviewAuthority(source, reviewId, plan);
        if ("error" in authority)
            return authority;
        if (authority.repository_id !== repositoryId)
            return refusal("review_repository_invalid");
        const { base_revision: base, reviewed_revision: head } = authority;
        if (base === head)
            return refusal("review_revision_invalid");
        try {
            if (!(await verifyRevisions(target, base, head)))
                return refusal("review_revision_invalid");
        }
        catch {
            return refusal("review_revision_invalid");
        }
        const diff = await runGit(target.executable, target.repository, [
            "diff", "--binary", "--full-index", "--find-renames",
            "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/",
            "--no-relative", "--ignore-submodules=none", "--submodule=short", `-O${GIT_NULL_PATH}`, base, head, "--",
        ], base);
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
    }
    catch (error) {
        return refusal(error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "review_response_too_large"
            : "review_evidence_unavailable");
    }
}
//# sourceMappingURL=implementation-review.js.map