import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHILD_TIMEOUT_MS } from "../../../../../vitest.shared.mts";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function reviewGitPath(): string {
  const windows = process.platform === "win32";
  const command = windows ? "where.exe" : "/bin/sh";
  const args = windows ? ["git.exe"] : ["-c", "command -v git"];
  return execFileSync(command, args, { encoding: "utf8", timeout: CHILD_TIMEOUT_MS }).trim().split(/\r?\n/)[0]!;
}

export function makeReviewRepo(root: string) {
  const repo = join(root, "candidate");
  const gitExecutable = reviewGitPath();
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync(gitExecutable, ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CHILD_TIMEOUT_MS,
    env: { SystemRoot: process.env.SystemRoot, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  const revision = (message: string) => {
    git("add", "--all");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  writeFileSync(join(repo, "old.txt"), "Retain receipts.\n");
  writeFileSync(join(repo, "obsolete.txt"), "Remove duplicate receipt.\n");
  const base = revision("before");
  git("mv", "old.txt", "receipt.txt");
  git("rm", "-q", "obsolete.txt");
  const head = revision("candidate");
  writeFileSync(join(repo, "moderate.txt"), "record line\n".repeat(3_000));
  const moderate = revision("with additional records");
  writeFileSync(join(repo, "large.txt"), "large line\n".repeat(50_000));
  const large = revision("later");
  writeFileSync(join(repo, "receipt.txt"), "uncommitted change\n");
  return { repo, base, head, moderate, large, git, gitExecutable };
}

export function makeReviewAuthority(
  plan: { run_id: string; define_sha256: string; proposal_sha256: string },
  candidate: { base: string; head: string },
) {
  const policy = '{"step":{},"scout_questions":{}}\n';
  const files = { "brief.md": "approved brief\n", "step.json": "{}\n" };
  const manifest = {
    version: 1, run_id: plan.run_id, step: "delivery",
    source_sha256: { define: plan.define_sha256, proposal: plan.proposal_sha256, policy: digest(policy) },
    files_sha256: { "brief.md": digest(files["brief.md"]), "step.json": digest(files["step.json"]) },
  };
  return {
    version: 1,
    review_id: "delivery-review",
    repository_id: "fixture/review",
    base_revision: candidate.base,
    reviewed_revision: candidate.head,
    manifest,
    decision: { version: 1, decision: "approve", approval_sha256: digest(JSON.stringify(manifest)) },
    policy,
    files,
  };
}
