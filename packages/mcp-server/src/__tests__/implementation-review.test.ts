import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DefineHandoffV1Schema } from "@prd-gen/core";
import { buildVerifiedPlan, MAX_RESPONSE_CHARS } from "@prd-gen/orchestration";
import { prepareImplementationReview } from "../implementation-review.js";
import { digest, makeReviewAuthority, makeReviewRepo } from "./fixtures/review-dossier.js";

// source: TEST_TIMEOUT_MS - 5 s of vitest.shared.mts, which this package's tsc cannot import; the guard in scripts/release/test-timeouts.test.mjs checks the two are equal.
const CHILD_TIMEOUT_MS = 25_000;

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fstatSync: vi.fn(fs.fstatSync), openSync: vi.fn(fs.openSync), readSync: vi.fn(fs.readSync), statSync: vi.fn(fs.statSync) };
});

const define = DefineHandoffV1Schema.parse({
  version: 1, run_id: "run_review_fixture",
  requirements: [{ id: "FR-001", text: "Keep a receipt." }],
  acceptance: [{ id: "AC-001", text: "Find the receipt.", requirement_ids: ["FR-001"] }],
});
const result = buildVerifiedPlan(define, "Keep receipts", "delivery");
if (!result.verified_plan) throw new Error("A verified fixture plan is required.");
const plan = result.verified_plan;
let root: string;
let candidate: ReturnType<typeof makeReviewRepo>;
let authority: ReturnType<typeof makeReviewAuthority>;
let paths: Parameters<typeof prepareImplementationReview>[0];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "prd-review-source-"));
  candidate = makeReviewRepo(root);
  authority = makeReviewAuthority(plan, candidate);
  paths = {
    authority: join(root, "approval.json"),
    repository: candidate.repo,
    repositoryId: authority.repository_id,
    git: candidate.gitExecutable,
  };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function save(value: unknown = authority) {
  writeFileSync(paths.authority!, JSON.stringify(value) + "\n");
}

function rewriteGitPointer(path: string, value: string) {
  // Git for Windows hides its existing .git files. Node's default "w" fails on them.
  const bytes = Buffer.from(value);
  const fd = openSync(path, "r+");
  try {
    writeFileSync(fd, bytes);
    ftruncateSync(fd, bytes.length);
  } finally {
    closeSync(fd);
  }
}

function review(overrides: typeof paths = paths, id: string | undefined = authority.review_id) {
  return prepareImplementationReview(overrides, id, plan, define);
}

it("reports pinned changes in a read-only dossier, with evidence still required", async () => {
  save();
  const reply = await review();
  expect(reply).toEqual({
    implementation_review: {
      version: 1, status: "ready_for_review", review_id: authority.review_id,
      run_id: define.run_id, step: "delivery", repository_id: authority.repository_id,
      base_revision: candidate.base, reviewed_revision: candidate.head,
      plan_sha256: plan.plan_sha256, approval_sha256: authority.decision.approval_sha256,
      diff_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), diff: expect.any(String),
      acceptance: [{ ...define.acceptance[0], status: "evidence_required" }],
    },
  });
  if (!("implementation_review" in reply)) throw new Error("Dossier expected");
  const dossier = reply.implementation_review;
  expect(dossier.diff_sha256).toBe(digest(dossier.diff));
  expect(dossier.diff).toContain("rename from old.txt");
  expect(dossier.diff).toContain("rename to receipt.txt");
  expect(dossier.diff).toContain("deleted file mode");
  expect(dossier.diff).not.toMatch(/large\.txt|uncommitted change/);
  writeFileSync(join(candidate.repo, ".gitattributes"), "*.txt -diff\n");
  expect(await review()).toEqual(reply);
});

it("resets the repository's diff ordering file for the pinned comparison", async () => {
  save();
  const baseline = await review();
  expect(baseline).toHaveProperty("implementation_review.diff");
  candidate.git("config", "diff.orderFile", "missing-review-order");
  try {
    expect(() => candidate.git("diff", candidate.base, candidate.head, "--")).toThrow(/missing-review-order/);
    expect(await review()).toEqual(baseline);
  } finally {
    candidate.git("config", "--unset", "diff.orderFile");
  }
});

it("uses the approved baseline rules when the revision updates tracked Git attributes", async () => {
  const policyRepo = join(root, "attribute-policy");
  candidate.git("worktree", "add", "--quiet", "--detach", policyRepo, candidate.head);
  const inPolicyRepo = (...args: string[]) => candidate.git("-C", policyRepo, ...args);

  const policy = join(policyRepo, ".gitattributes");
  const record = join(policyRepo, "record.dat");
  writeFileSync(policy, "record.dat binary\n");
  writeFileSync(record, "Archived receipt\n");
  inPolicyRepo("add", ".gitattributes", "record.dat");
  inPolicyRepo("commit", "-qm", "track archived receipt with binary attributes");
  const base = inPolicyRepo("rev-parse", "HEAD");

  inPolicyRepo("rm", "-q", ".gitattributes");
  writeFileSync(record, "Revised receipt\n");
  inPolicyRepo("add", "record.dat");
  inPolicyRepo("commit", "-qm", "migrate receipt to the new format");
  save({ ...authority, base_revision: base, reviewed_revision: inPolicyRepo("rev-parse", "HEAD") });

  const reply = await review({ ...paths, repository: policyRepo });
  if (!("implementation_review" in reply)) throw new Error("Dossier expected");
  expect(reply.implementation_review.diff).toContain("GIT binary patch");
  expect(reply.implementation_review.diff).toContain("-record.dat binary");
});

it.each([
  { authority: undefined }, { repository: undefined }, { repositoryId: undefined }, { git: undefined },
  { authority: "relative.json" }, { repository: "relative-repo" }, { git: "git" },
])("refuses unavailable host configuration %j", async patch => {
  expect(await review({ ...paths, ...patch })).toMatchObject({ error: { code: "review_authority_unavailable" } });
});

it("refuses an absent review identifier and missing approval bytes", async () => {
  expect(await prepareImplementationReview(paths, undefined, plan, define)).toMatchObject({
    error: { code: "review_authority_unavailable", message: "The implementation review dossier could not be prepared." },
  });
  expect(await review({ ...paths, authority: join(root, "missing") })).toMatchObject({
    error: { code: "review_evidence_unavailable" },
  });

  save();
  const source = realpathSync(paths.authority!);
  const open = vi.mocked(openSync);
  const original = open.getMockImplementation()!;
  open.mockImplementation((path, flags, mode) => {
    if (path === source) throw Object.assign(new Error("Approval was removed"), { code: "ENOENT" });
    return original(path, flags, mode);
  });
  try {
    expect(await review()).toMatchObject({ error: { code: "review_evidence_unavailable" } });
  } finally {
    open.mockImplementation(original);
  }
});

it("distinguishes repository identity, dossier identity and revision refusals", async () => {
  save();
  expect(await review({ ...paths, repositoryId: "other" })).toMatchObject({ error: { code: "review_repository_invalid" } });
  expect(await review(paths, "wrong-review")).toMatchObject({ error: { code: "review_authority_invalid" } });
  save({ ...authority, base_revision: candidate.large });
  expect(await review()).toMatchObject({ error: { code: "review_revision_invalid" } });
  save({ ...authority, base_revision: candidate.head });
  expect(await review()).toMatchObject({ error: { code: "review_revision_invalid" } });
  save({ ...authority, reviewed_revision: "0".repeat(40) });
  expect(await review()).toMatchObject({ error: { code: "review_revision_invalid" } });
});

it("refuses repository-controlled authority and an oversized diff", async () => {
  const substituted = join(candidate.repo, "authority.json");
  writeFileSync(substituted, JSON.stringify(authority));
  expect(await review({ ...paths, authority: substituted })).toMatchObject({ error: { code: "review_authority_invalid" } });
  save({ ...authority, reviewed_revision: candidate.large });
  expect(await review()).toMatchObject({ error: { code: "review_response_too_large" } });
  writeFileSync(paths.authority!, " ".repeat(MAX_RESPONSE_CHARS + 1) + JSON.stringify(authority));
  expect(await review()).toMatchObject({ error: { code: "review_authority_invalid" } });
});

it("returns a sizable complete diff within the process and response budgets", async () => {
  save({ ...authority, reviewed_revision: candidate.moderate });
  const dossier = await review();
  if (!("implementation_review" in dossier)) throw new Error("Dossier expected");
  expect(dossier.implementation_review.diff).toContain("+++ b/moderate.txt");
  expect(dossier.implementation_review.diff.length).toBeGreaterThan(MAX_RESPONSE_CHARS / 4);
});

it("refuses a path that Git resolves to a different checkout root", async () => {
  save();
  const nested = join(candidate.repo, "nested");
  mkdirSync(join(nested, ".git"), { recursive: true });
  expect(await review({ ...paths, repository: nested })).toMatchObject({ error: { code: "review_repository_invalid" } });
});

it("uses the linked checkout while excluding its shared metadata from authority", async () => {
  save();
  const linked = join(root, "linked-source");
  candidate.git("worktree", "add", "--quiet", "--detach", linked, candidate.head);
  const normal = await review();
  expect(await review({ ...paths, repository: linked })).toEqual(normal);

  const substituted = join(candidate.repo, ".git", "other-authority.json");
  writeFileSync(substituted, JSON.stringify(authority));
  expect(await review({ ...paths, repository: linked, authority: substituted })).toMatchObject({
    error: { code: "review_authority_invalid" },
  });
  if (process.platform === "win32") return;

  const program = join(candidate.repo, ".git", "do-not-start");
  writeFileSync(program, '#!/bin/sh\n: > "$0.started"\n', { mode: 0o700 });
  expect(await review({ ...paths, git: program, repository: linked })).toMatchObject({ error: { code: "review_authority_invalid" } });
  expect(existsSync(program + ".started")).toBe(false);
});

it("runs only the pinned host Git commands with the isolated comparison environment", async () => {
  if (process.platform === "win32") return;
  save();
  const git = join(root, "witness-git");
  const executable = paths.git!.replaceAll("'", "'\"'\"'");
  writeFileSync(git, [
    "#!/bin/sh",
    'printf "%s\n" "$GIT_CONFIG_NOSYSTEM|$GIT_ATTR_NOSYSTEM|$GIT_CONFIG_GLOBAL|$GIT_NO_LAZY_FETCH|$GIT_ALLOW_PROTOCOL|$GIT_GRAFT_FILE|$GIT_OPTIONAL_LOCKS|$LC_ALL" > "$0.env"',
    'printf "%s\n" "$@" > "$0.args"',
    'pwd -P > "$0.cwd"',
    `exec '${executable}' "$@"`,
  ].join("\n") + "\n", { mode: 0o700 });
  const response = await review({ ...paths, git });
  if (!("implementation_review" in response)) throw new Error("Dossier expected");
  expect(response.implementation_review.status).toBe("ready_for_review");
  expect(readFileSync(git + ".env", "utf8")).toBe("1|1|/dev/null|1||/dev/null|0|C\n");
  expect(readFileSync(git + ".cwd", "utf8")).toBe(realpathSync(root) + "\n");
  const args = readFileSync(git + ".args", "utf8").split("\n");
  expect(args).toEqual(expect.arrayContaining([
    "--no-pager", "--no-replace-objects", "core.fsmonitor=false", "core.quotePath=true", "core.attributesFile=/dev/null",
    `--attr-source=${candidate.base}`, "--no-ext-diff", "--no-textconv", "--binary", "--full-index",
    "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--no-relative", "--ignore-submodules=none", "--submodule=short", "-O/dev/null",
  ]));
});

it("accepts an authority at the exact character limit and refuses one character more", async () => {
  const json = JSON.stringify(authority);
  const atLimit = " ".repeat(MAX_RESPONSE_CHARS - json.length) + json;
  writeFileSync(paths.authority!, atLimit);
  expect(await review()).toMatchObject({ implementation_review: { status: "ready_for_review" } });
  writeFileSync(paths.authority!, atLimit + " ");
  expect(await review()).toMatchObject({ error: { code: "review_authority_invalid" } });
});

it("refuses directories, BOMs and malformed UTF-8 authority", async () => {
  expect(await review({ ...paths, authority: root })).toMatchObject({
    error: { code: "review_authority_invalid" },
  });
  const json = JSON.stringify(authority);
  writeFileSync(paths.authority!, "\uFEFF" + json);
  expect(await review()).toMatchObject({ error: { code: "review_evidence_unavailable" } });

  const marker = json.indexOf(authority.repository_id);
  const invalid = Buffer.concat([
    Buffer.from(json.slice(0, marker)), Buffer.from([0xff]), Buffer.from(json.slice(marker + 1)),
  ]);
  writeFileSync(paths.authority!, invalid);
  expect(await review()).toMatchObject({ error: { code: "review_evidence_unavailable" } });

  const byteBoundary = Buffer.alloc(MAX_RESPONSE_CHARS * 4, 0xff);
  writeFileSync(paths.authority!, byteBoundary);
  expect(await review()).toMatchObject({ error: { code: "review_evidence_unavailable" } });
  writeFileSync(paths.authority!, Buffer.concat([byteBoundary, Buffer.from([0xff])]));
  expect(await review()).toMatchObject({ error: { code: "review_authority_invalid" } });
});

it("checks the commit object type even when its annotated tag resolves to the approved revision", async () => {
  candidate.git("tag", "-a", "head-tag", "-m", "fixture only", candidate.head);
  save({ ...authority, reviewed_revision: candidate.git("rev-parse", "head-tag") });
  expect(await review()).toMatchObject({ error: { code: "review_revision_invalid" } });
});

it("accepts a sibling with a similar path prefix and refuses separate Git metadata", async () => {
  const outside = candidate.repo + "-outside";
  mkdirSync(outside);
  const file = join(outside, "approval.json");
  writeFileSync(file, JSON.stringify(authority));
  expect(await review({ ...paths, authority: file })).toMatchObject({ implementation_review: { status: "ready_for_review" } });

  const separate = join(root, "separate");
  const gitDir = join(root, "separate-metadata");
  candidate.git("init", "-q", "--separate-git-dir", gitDir, separate);
  const git = join(gitDir, "untrusted-tool");
  mkdirSync(git);
  save();
  expect(await review({ ...paths, git, repository: separate })).toMatchObject({ error: { code: "review_authority_invalid" } });
});

it("refuses malformed and non-regular Git markers", async () => {
  save();
  const broken = join(root, "broken");
  mkdirSync(broken);
  const marker = join(broken, ".git");
  writeFileSync(marker, "../candidate/.git\n");
  expect(await review({ ...paths, repository: broken })).toMatchObject({ error: { code: "review_repository_invalid" } });

  const regular = statSync(marker);
  const open = vi.mocked(openSync);
  open.mockClear();
  vi.mocked(statSync).mockReturnValueOnce({
    ...regular, isDirectory: () => false, isFile: () => false,
  } as ReturnType<typeof statSync>);
  expect(await review({ ...paths, repository: broken })).toMatchObject({ error: { code: "review_repository_invalid" } });
  expect(open).not.toHaveBeenCalled();

  const read = vi.mocked(readSync);
  read.mockClear();
  vi.mocked(fstatSync).mockReturnValueOnce({
    ...regular, isFile: () => false,
  } as ReturnType<typeof fstatSync>);
  expect(await review({ ...paths, repository: broken })).toMatchObject({ error: { code: "review_repository_invalid" } });
  expect(open).toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("refuses an incomplete authority read and closes the opened descriptor", async () => {
  save();
  const open = vi.mocked(openSync);
  open.mockClear();
  vi.mocked(readSync).mockReturnValueOnce(1).mockReturnValueOnce(0);
  expect(await review()).toMatchObject({ error: { code: "review_authority_invalid" } });
  const opened = open.mock.results.at(-1);
  expect(opened?.type).toBe("return");
  expect(() => fstatSync(opened?.value as number)).toThrow(/EBADF/);
});

it("does not block on a non-regular authority", async () => {
  if (process.platform === "win32") return;
  const fifo = join(root, "authority.pipe");
  execFileSync("/usr/bin/mkfifo", [fifo], { timeout: CHILD_TIMEOUT_MS });
  expect(await review({ ...paths, authority: fifo })).toMatchObject({ error: { code: "review_authority_invalid" } });
});

it("accumulates bounded short reads instead of rejecting a valid authority file", async () => {
  save();
  const data = Buffer.from(JSON.stringify(authority) + "\n");
  const read = vi.mocked(readSync);
  read.mockImplementationOnce((_fd, buffer, options) => data.copy(buffer as Buffer, options?.offset, 0, 5));
  read.mockImplementationOnce((_fd, buffer, options) => data.copy(buffer as Buffer, options?.offset, 5));
  read.mockReturnValueOnce(0);
  expect(await review()).toMatchObject({ implementation_review: { status: "ready_for_review" } });
});

it("refuses authority bytes appended after opening the file", async () => {
  save();
  const read = vi.mocked(readSync);
  read.mockClear();
  read.mockImplementationOnce((_fd, _buffer, options) => options!.length!);
  expect(await review()).toMatchObject({ error: { code: "review_authority_invalid" } });
  // The extra byte is the growth sentinel. Do not make another read with no buffer space.
  expect(read).toHaveBeenCalledTimes(1);
});

it("preserves the refusal envelope when a host read throws without an error object", async () => {
  save();
  vi.mocked(readSync).mockImplementationOnce(() => { throw null; });
  expect(await review()).toMatchObject({ error: { code: "review_evidence_unavailable" } });
});

it("uses physical directory identity even when a checkout path has alternate casing", async () => {
  const alias = join(dirname(candidate.repo), "Candidate");
  const needsSimulation = !existsSync(alias);
  if (needsSimulation) mkdirSync(alias);
  const source = join(alias, "case-authority.json");
  writeFileSync(source, JSON.stringify(authority));
  const stat = vi.mocked(statSync);
  const original = stat.getMockImplementation()!;
  const identity = statSync(candidate.repo, { bigint: true });
  if (needsSimulation) {
    stat.mockImplementation((path, opts) => path === alias && opts?.bigint ? identity : original(path, opts));
  }
  try {
    expect(await review({ ...paths, authority: source })).toMatchObject({ error: { code: "review_authority_invalid" } });
  } finally {
    stat.mockImplementation(original);
  }
});

it("rejects an operator authority whose inode is also linked in the candidate checkout", async () => {
  save();
  const alias = join(candidate.repo, "authority-hard-link");
  linkSync(paths.authority!, alias);
  try {
    expect(await review()).toMatchObject({ error: { code: "review_authority_invalid" } });
  } finally {
    rmSync(alias);
  }
});

it("protects a separate Git directory whose name ends with a space", async () => {
  if (process.platform === "win32") return;
  const separate = join(root, "space-marker-checkout");
  const metadata = join(root, "outside Git metadata ");
  candidate.git("init", "-q", "--separate-git-dir", metadata, separate);
  const executable = join(metadata, "untrusted-git");
  mkdirSync(executable);
  save();
  expect(await review({ ...paths, git: executable, repository: separate })).toMatchObject({
    error: { code: "review_authority_invalid" },
  });
});

it("does not confuse equal inode numbers on different devices", async () => {
  save();
  const output = join(root, "other-device");
  mkdirSync(output);
  const outside = join(output, "approval.json");
  writeFileSync(outside, JSON.stringify(authority));
  const stat = vi.mocked(statSync);
  const original = stat.getMockImplementation()!;
  const checkout = statSync(candidate.repo, { bigint: true });
  stat.mockImplementation((path, opts) => {
    if (path !== output) return original(path, opts);
    expect(opts?.bigint).toBe(true);
    return { ...checkout, dev: checkout.dev + 1n };
  });
  try {
    expect(await review({ ...paths, authority: outside })).toMatchObject({
      implementation_review: { status: "ready_for_review" },
    });
  } finally {
    stat.mockImplementation(original);
  }
});

it("refuses empty and multiline metadata pointers before starting Git", async () => {
  save();
  const invalid = join(root, "invalid-marker");
  mkdirSync(invalid);
  const marker = join(invalid, ".git");
  for (const value of ["gitdir: \n", `gitdir: ${candidate.repo}/.git\nextra\n`]) {
    writeFileSync(marker, value);
    expect(await review({ ...paths, repository: invalid })).toMatchObject({
      error: { code: "review_repository_invalid" },
    });
  }

  const linked = join(root, "invalid-common-linked");
  candidate.git("worktree", "add", "--quiet", "--detach", linked, candidate.head);
  const commonMarker = join(candidate.repo, ".git", "worktrees", "invalid-common-linked", "commondir");
  const previous = readFileSync(commonMarker);
  try {
    writeFileSync(commonMarker, "\r\n");
    expect(await review({ ...paths, repository: linked })).toMatchObject({
      error: { code: "review_repository_invalid" },
    });
  } finally {
    writeFileSync(commonMarker, previous);
  }
});

it("does not join an embedded newline into a valid metadata path", async () => {
  save();
  const checkout = join(root, "embedded-line-checkout");
  const metadata = join(root, "embedded-line-metadata");
  candidate.git("init", "-q", "--separate-git-dir", metadata, checkout);
  const executable = join(metadata, "untrusted-git");
  mkdirSync(executable);
  const splitAt = metadata.lastIndexOf("-");
  const malformed = [
    `gitdir: ${metadata.slice(0, splitAt)}\n${metadata.slice(splitAt)}`,
    `\ngitdir: ${metadata}\n`,
  ];
  for (const pointer of malformed) {
    rewriteGitPointer(join(checkout, ".git"), pointer);
    expect(await review({ ...paths, git: executable, repository: checkout })).toMatchObject({
      error: { code: "review_repository_invalid" },
    });
  }
});

it("accepts a linked checkout whose Git pointer ends in CRLF", async () => {
  save();
  const linked = join(root, "crlf-linked");
  candidate.git("worktree", "add", "--quiet", "--detach", linked, candidate.head);
  const marker = join(linked, ".git");
  const pointer = readFileSync(marker, "utf8").replace(/[\r\n]+$/, "");
  rewriteGitPointer(marker, pointer + "\r\n");
  expect(await review({ ...paths, repository: linked })).toMatchObject({
    implementation_review: { status: "ready_for_review", reviewed_revision: candidate.head },
  });
});

it("applies Git's gitfile size limit without rejecting valid linked markers", async () => {
  save();
  const linked = join(root, "bounded-marker-linked");
  candidate.git("worktree", "add", "--quiet", "--detach", linked, candidate.head);
  const marker = join(linked, ".git");
  linkSync(marker, join(root, "linked-marker-copy"));
  const pointer = readFileSync(marker, "utf8").replace(/[\r\n]+$/, "");
  // Git v2.56.1 read_gitfile_raw trims trailing line endings within its 1 MiB limit.
  const atLimit = pointer + "\n".repeat((1 << 20) - Buffer.byteLength(pointer));
  rewriteGitPointer(marker, atLimit);
  expect(await review({ ...paths, repository: linked })).toMatchObject({
    implementation_review: { status: "ready_for_review", reviewed_revision: candidate.head },
  });
  rewriteGitPointer(marker, atLimit + "\n");
  expect(await review({ ...paths, repository: linked })).toMatchObject({
    error: { code: "review_repository_invalid" },
  });
});

it("refuses a non-regular common directory marker", async () => {
  save();
  const linked = join(root, "directory-common-linked");
  candidate.git("worktree", "add", "--quiet", "--detach", linked, candidate.head);
  const common = join(candidate.repo, ".git", "worktrees", "directory-common-linked", "commondir");
  const previous = readFileSync(common);
  rmSync(common);
  mkdirSync(common);
  try {
    expect(await review({ ...paths, repository: linked })).toMatchObject({
      error: { code: "review_repository_invalid" },
    });
  } finally {
    rmSync(common, { recursive: true });
    writeFileSync(common, previous);
  }
});

it("distinguishes an unreadable common directory marker from an absent one", async () => {
  save();
  const common = join(realpathSync(join(candidate.repo, ".git")), "commondir");
  const open = vi.mocked(openSync);
  const original = open.getMockImplementation()!;
  open.mockImplementation((path, flags, mode) => {
    if (path === common) throw Object.assign(new Error("Access denied"), { code: "EACCES" });
    return original(path, flags, mode);
  });
  try {
    expect(await review()).toMatchObject({ error: { code: "review_evidence_unavailable" } });
  } finally {
    open.mockImplementation(original);
  }
});
