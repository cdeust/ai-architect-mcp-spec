import { createHash } from "node:crypto";
import { z } from "zod";
import type { buildVerifiedPlan } from "./verified-plan.js";

export type VerifiedPlan = Extract<ReturnType<typeof buildVerifiedPlan>, { verified_plan: unknown }>["verified_plan"];

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const ReviewIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

// Source: architect-os fcf9d2c6, tools/plan/src/infrastructure/step-inputs.ts.
const inputName = z.string().regex(/^(?:brief\.md|step\.json|scout\.[a-z][a-z0-9-]*\.md)$/);
// Zod drops an own __proto__ record key, so check it before parsing.
const inputMap = <T extends z.ZodType>(value: T) =>
  z.unknown().refine(input => !Object.hasOwn(Object(input), "__proto__")).pipe(z.record(inputName, value));
const ManifestSchema = z.strictObject({
  version: z.literal(1),
  run_id: z.string(),
  step: z.string(),
  source_sha256: z.strictObject({ define: sha256, proposal: sha256, policy: sha256 }),
  files_sha256: inputMap(sha256),
});
const AuthoritySchema = z.strictObject({
  version: z.literal(1),
  review_id: ReviewIdSchema,
  repository_id: z.string().min(1),
  base_revision: commit,
  reviewed_revision: commit,
  manifest: z.unknown(),
  decision: z.strictObject({
    version: z.literal(1),
    decision: z.literal("approve"),
    approval_sha256: sha256,
  }),
  policy: z.string(),
  files: inputMap(z.string()),
});

export function reviewDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The caller must obtain value from the operator's out-of-checkout authority. */
export function readReviewAuthority(value: unknown, reviewId: string, plan: VerifiedPlan) {
  const record = AuthoritySchema.safeParse(value);
  if (!record.success || record.data.review_id !== reviewId) return undefined;
  const authority = record.data;
  const result = ManifestSchema.safeParse(authority.manifest);
  if (!result.success) return undefined;
  const manifest = result.data;
  const { source_sha256: sources, files_sha256: expected } = manifest;
  const names = Object.keys(expected);

  if (manifest.run_id !== plan.run_id || manifest.step !== plan.proposal.step ||
      sources.define !== plan.define_sha256 || sources.proposal !== plan.proposal_sha256 ||
      sources.policy !== reviewDigest(authority.policy) ||
      // Source: architect-os fcf9d2c6, tools/plan/src/application/prepare.ts.
      authority.decision.approval_sha256 !== reviewDigest(JSON.stringify(authority.manifest))) return undefined;
  if (!Object.hasOwn(expected, "brief.md") || !Object.hasOwn(expected, "step.json") ||
      names.length !== Object.keys(authority.files).length ||
      names.some(name => !Object.hasOwn(authority.files, name) ||
        expected[name] !== reviewDigest(authority.files[name]!))) return undefined;

  return authority;
}
