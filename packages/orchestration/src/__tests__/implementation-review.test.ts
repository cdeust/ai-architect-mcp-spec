import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readReviewAuthority, ReviewIdSchema, type VerifiedPlan } from "../implementation-review.js";

const hash = (input: string) => createHash("sha256").update(input).digest("hex");
const plan: VerifiedPlan = {
  version: 1, run_id: "run_review_fixture", define_sha256: hash("define"), proposal_sha256: hash("proposal"),
  plan_sha256: hash("plan"),
  proposal: { step: "delivery", objective: "Retain receipts.", verification: "Compare bytes.", acceptance_ids: ["AC-001"] },
};

function authority() {
  const files = { "brief.md": "Retain receipts.\n", "step.json": "{}\n", "scout.receipts.md": "Compare bytes.\n" };
  const policy = "owner policy\n";
  const manifest = {
    version: 1,
    run_id: plan.run_id,
    step: plan.proposal.step,
    source_sha256: { define: plan.define_sha256, proposal: plan.proposal_sha256, policy: hash(policy) },
    files_sha256: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)])),
  };
  return {
    version: 1, review_id: "candidate", repository_id: "project",
    base_revision: "1".repeat(40), reviewed_revision: "2".repeat(40), manifest, policy, files,
    decision: { version: 1, decision: "approve", approval_sha256: hash(JSON.stringify(manifest)) },
  };
}

it("binds an independent approval to the authoritative plan and all bytes", () => {
  const value = authority();
  expect(readReviewAuthority(value, value.review_id, plan)).toEqual(value);
});

type Authority = ReturnType<typeof authority>;
const tampering: Record<string, (value: Authority) => void> = {
  "wrong authority version": value => { value.version = 2; },
  "wrong manifest version": value => { value.manifest.version = 2; },
  "wrong decision version": value => { value.decision.version = 2; },
  "refused decision": value => { value.decision.decision = "refuse"; },
  "empty repository identity": value => { value.repository_id = ""; },
  "wrong run": value => { value.manifest.run_id = "run_wrong_fixture"; },
  "wrong step": value => { value.manifest.step = "release"; },
  "wrong Define": value => { value.manifest.source_sha256.define = hash("other Define"); },
  "wrong proposal": value => { value.manifest.source_sha256.proposal = hash("other proposal"); },
  "rewritten policy": value => { value.policy += "other policy"; },
  "different input bytes": value => { value.files["brief.md"] += "extra prose"; },
  "missing approved input": value => { Reflect.deleteProperty(value.files, "scout.receipts.md"); },
  "unlisted input": value => { Object.assign(value.files, { "scout.extra.md": "extra" }); },
  "substituted input with the same count": value => {
    Reflect.deleteProperty(value.files, "scout.receipts.md");
    Object.assign(value.files, { "scout.extra.md": "extra" });
  },
  "missing brief digest": value => {
    delete value.manifest.files_sha256["brief.md"];
    Reflect.deleteProperty(value.files, "brief.md");
  },
  "missing Step digest and input": value => {
    delete value.manifest.files_sha256["step.json"];
    Reflect.deleteProperty(value.files, "step.json");
  },
  "unsafe input name": value => {
    Object.assign(value.files, { "../brief.md": "extra" });
    value.manifest.files_sha256["../brief.md"] = hash("extra");
  },
  "decorated input name": value => {
    Object.assign(value.files, { "brief.md.bak": "extra" });
    value.manifest.files_sha256["brief.md.bak"] = hash("extra");
  },
  "missing mandatory digest": value => { delete value.manifest.files_sha256["step.json"]; },
  "path-like revision": value => { value.reviewed_revision = "refs/heads/main"; },
  "discarded reserved key": value => {
    value.files = { ...value.files, ...JSON.parse('{"__proto__":"hidden"}') };
    expect(Object.hasOwn(value.files, "__proto__")).toBe(true);
  },
};

it.each(Object.entries(tampering))("refuses %s even with a refreshed manifest approval", (_case, alter) => {
  const value = authority();
  alter(value);
  value.decision.approval_sha256 = hash(JSON.stringify(value.manifest));
  expect(readReviewAuthority(value, value.review_id, plan)).toBeUndefined();
});

it("requires the approval of the architect-os manifest JSON without a trailing newline", () => {
  const value = authority();
  value.decision.approval_sha256 = hash(JSON.stringify(value.manifest) + "\n");
  expect(readReviewAuthority(value, value.review_id, plan)).toBeUndefined();
});

it("accepts full SHA-256 Git revisions and refuses digest decorations", () => {
  const value = { ...authority(), base_revision: "a".repeat(64), reviewed_revision: "b".repeat(64) };
  expect(readReviewAuthority(value, value.review_id, plan)).toEqual(value);
  for (const revision of ["0".repeat(39), "0".repeat(41), "0".repeat(63), "0".repeat(65), "A".repeat(40)]) {
    expect(readReviewAuthority({ ...value, reviewed_revision: revision }, value.review_id, plan)).toBeUndefined();
  }
});

it("validates the opaque review selector at its full allowed length", () => {
  for (const usable of ["a", "9", "receipt-2", "0" + "a".repeat(62)]) {
    expect(ReviewIdSchema.parse(usable)).toBe(usable);
  }
  for (const refused of ["", "-a", "Upper", "a/b", "a\n", "a".repeat(64)]) {
    expect(ReviewIdSchema.safeParse(refused).success).toBe(false);
  }
});

it("refuses a request that names a different authority record", () => {
  const value = authority();
  expect(readReviewAuthority(value, "other", plan)).toBeUndefined();
});

it.each(["prefix" + plan.define_sha256, plan.define_sha256 + "suffix"])(
  "refuses decorated source fingerprints even when the caller supplies the same value",
  define_sha256 => {
    const value = authority();
    value.manifest.source_sha256.define = define_sha256;
    value.decision.approval_sha256 = hash(JSON.stringify(value.manifest));
    expect(readReviewAuthority(value, value.review_id, { ...plan, define_sha256 })).toBeUndefined();
  },
);
