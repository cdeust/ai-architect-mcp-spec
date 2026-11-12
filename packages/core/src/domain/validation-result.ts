import { z } from "zod";
import { HardOutputRuleSchema } from "./hard-output-rule.js";
import { SectionTypeSchema } from "./section-type.js";

export const HardOutputRuleViolationSchema = z.object({
  rule: HardOutputRuleSchema,
  sectionType: SectionTypeSchema.nullable(),
  message: z.string(),
  offendingContent: z.string().nullable(),
  location: z.string().nullable(),
  isCritical: z.boolean(),
  scorePenalty: z.number().min(0).max(1),
  /**
   * True when the violation only says that expected vocabulary is absent
   * (a lexicon check), not that a defect is present. Advisory violations are
   * reported to the author but carry no penalty, are never critical and do
   * not trigger a section retry: a lexicon cannot tell whether a topic
   * applies to the feature (issue #117). Absent means blocking, the
   * behaviour of every violation produced before this field existed.
   */
  isAdvisory: z.boolean().optional(),
});

export type HardOutputRuleViolation = z.infer<typeof HardOutputRuleViolationSchema>;

/**
 * True when the violation blocks a section: every violation not explicitly
 * marked advisory. Only blocking violations fail a section or trigger a retry.
 */
export function isBlockingViolation(v: HardOutputRuleViolation): boolean {
  return v.isAdvisory !== true;
}

export const ValidationReportSchema = z.object({
  violations: z.array(HardOutputRuleViolationSchema),
  rulesChecked: z.array(HardOutputRuleSchema),
  rulesPassed: z.array(HardOutputRuleSchema),
  sectionType: SectionTypeSchema.nullable(),
  hasCriticalViolations: z.boolean(),
  totalScore: z.number().min(0).max(1),
  checkedAt: z.string().datetime(),
});

export type ValidationReport = z.infer<typeof ValidationReportSchema>;

export const CrossRefValidationResultSchema = z.object({
  danglingReferences: z.array(z.object({
    id: z.string(),
    referencedIn: z.string(),
    type: z.string(),
  })),
  orphanNodes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    reason: z.string(),
  })),
  cycles: z.array(z.array(z.string())),
  numberingGaps: z.array(z.object({
    prefix: z.string(),
    expected: z.number(),
    actual: z.number(),
  })),
  duplicateIds: z.array(z.string()),
  isValid: z.boolean(),
});

export type CrossRefValidationResult = z.infer<typeof CrossRefValidationResultSchema>;
