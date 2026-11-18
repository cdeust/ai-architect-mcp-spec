/**
 * Domain-type contract tests.
 *
 * Per cross-audit test-engineer C1 (Phase 3+4, 2026-04): @prd-gen/core defines
 * load-bearing constants (CAPABILITIES, PRD_CONTEXT_CONFIGS, VerdictSchema,
 * SectionTypeSchema) that every downstream package depends on. A silent change
 * to any of them cascades through the full pipeline. These tests pin the
 * contracts so a regression surfaces at this layer instead of a downstream
 * smoke test that may or may not exercise the affected branch.
 */

import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  PRDContextSchema,
  PRD_CONTEXT_CONFIGS,
  PRD_CONTEXT_DEFAULT,
  SectionTypeSchema,
  VerdictSchema,
  EXPECTED_VERDICT_DISTRIBUTION,
  isDistributionSuspicious,
  AgentIdentitySchema,
  agentSubagentType,
  ClaimSchema,
  JudgeVerdictSchema,
  extractJsonObject,
} from "../index.js";

describe("Capabilities", () => {
  it("exposes the full pipeline feature set (no tier gating)", () => {
    expect(CAPABILITIES.maxStrategies).toBe(16);
    expect(CAPABILITIES.maxClarificationRounds).toBe(Infinity);
    expect(CAPABILITIES.maxSections).toBe(11);
    expect(CAPABILITIES.verificationLevel).toBe("full");
    expect(CAPABILITIES.allowedContextTypes.length).toBe(8);
  });

  it("maxStrategies equals allowedStrategies.length (Darwin difficulty-book invariant)", () => {
    // Pre-fix the trial tier declared maxStrategies=17 while
    // allowedStrategies.length=16. This invariant catches off-by-one drift.
    expect(CAPABILITIES.maxStrategies).toBe(CAPABILITIES.allowedStrategies.length);
  });

  it("allows all 8 PRD contexts", () => {
    const expected = ["proposal", "feature", "bug", "incident", "poc", "mvp", "release", "cicd"];
    for (const ctx of expected) {
      expect(CAPABILITIES.allowedContextTypes).toContain(ctx);
    }
  });
});

describe("PRDContext", () => {
  it("Schema accepts the eight canonical contexts", () => {
    const expected = ["proposal", "feature", "bug", "incident", "poc", "mvp", "release", "cicd"];
    for (const ctx of expected) {
      expect(PRDContextSchema.safeParse(ctx).success).toBe(true);
    }
    expect(PRDContextSchema.safeParse("epic").success).toBe(false);
    // A size is not a kind (#119): `tiny` is a RequestSize.
    expect(PRDContextSchema.safeParse("tiny").success).toBe(false);
  });

  it("PRD_CONTEXT_DEFAULT is 'feature'", () => {
    expect(PRD_CONTEXT_DEFAULT).toBe("feature");
  });

  it("PRD_CONTEXT_CONFIGS has an entry for every PRDContext", () => {
    for (const ctx of PRDContextSchema.options) {
      const config = PRD_CONTEXT_CONFIGS[ctx];
      expect(config).toBeDefined();
      expect(config.displayName).toBeTruthy();
      expect(config.clarificationRange[0]).toBeLessThanOrEqual(
        config.clarificationRange[1],
      );
      expect(config.expectedSectionCount).toBeGreaterThan(0);
      expect(config.ragMaxHops).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("Verdict", () => {
  it("Schema accepts the five canonical verdicts in fixed order", () => {
    expect(VerdictSchema.options).toEqual([
      "PASS",
      "SPEC-COMPLETE",
      "NEEDS-RUNTIME",
      "INCONCLUSIVE",
      "FAIL",
    ]);
  });

  it("EXPECTED_VERDICT_DISTRIBUTION expects FAIL = 0 (precautionary)", () => {
    // Any FAIL verdict in a healthy distribution indicates a real defect;
    // the expected band is exactly zero. Catching a regression that softens
    // this to "tolerate occasional failures" is load-bearing.
    expect(EXPECTED_VERDICT_DISTRIBUTION.FAIL.min).toBe(0);
    expect(EXPECTED_VERDICT_DISTRIBUTION.FAIL.max).toBe(0);
  });

  it("isDistributionSuspicious returns false for cluster size < 5", () => {
    expect(isDistributionSuspicious(["PASS"])).toBe(false);
    expect(isDistributionSuspicious(["PASS", "PASS", "PASS", "PASS"])).toBe(false);
  });

  it("isDistributionSuspicious returns true for 100% PASS at cluster size >= 5", () => {
    expect(
      isDistributionSuspicious(["PASS", "PASS", "PASS", "PASS", "PASS"]),
    ).toBe(true);
  });

  it("isDistributionSuspicious returns false when ANY non-PASS verdict appears", () => {
    expect(
      isDistributionSuspicious(["PASS", "PASS", "PASS", "PASS", "FAIL"]),
    ).toBe(false);
    expect(
      isDistributionSuspicious(["PASS", "PASS", "PASS", "PASS", "INCONCLUSIVE"]),
    ).toBe(false);
  });
});

describe("SectionType", () => {
  it("Schema accepts every canonical section type", () => {
    // Spot-check the load-bearing types referenced elsewhere in the codebase.
    const required = [
      "overview",
      "goals",
      "requirements",
      "user_stories",
      "technical_specification",
      "acceptance_criteria",
      "data_model",
      "api_specification",
      "security_considerations",
      "performance_requirements",
      "testing",
    ];
    for (const t of required) {
      expect(SectionTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it("rejects unknown section types", () => {
    expect(SectionTypeSchema.safeParse("epilogue").success).toBe(false);
    expect(SectionTypeSchema.safeParse("").success).toBe(false);
  });
});

describe("SECTION_ORDER", () => {
  // Cross-audit closure (test-engineer M3, Phase 3+4 follow-up, 2026-04).
  // SECTION_ORDER drives 9-file PRD output ordering. A silent mutation
  // (swapping two values, shifting all values by 1, etc.) reorders the
  // output files without breaking any other test. Pin the contract.
  it("assigns unique non-negative ordering values to every SectionType", async () => {
    const { SECTION_ORDER } = await import("../domain/section-type.js");
    const values = Object.values(SECTION_ORDER);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("places overview first and the synthetic jira_tickets last", async () => {
    const { SECTION_ORDER } = await import("../domain/section-type.js");
    expect(SECTION_ORDER.overview).toBe(0);
    // jira_tickets is appended outside the section_generation loop and
    // must sort after the canonical PRD sections so file_export emits
    // it after the source PRD content.
    const values = Object.values(SECTION_ORDER);
    const max = Math.max(...values);
    expect(SECTION_ORDER.jira_tickets).toBe(max);
  });

  it("preserves the canonical PRD section order (load-bearing for file_export)", async () => {
    const { SECTION_ORDER } = await import("../domain/section-type.js");
    // Pin specific ordering relationships that downstream consumers depend on.
    expect(SECTION_ORDER.overview).toBeLessThan(SECTION_ORDER.goals);
    expect(SECTION_ORDER.goals).toBeLessThan(SECTION_ORDER.requirements);
    expect(SECTION_ORDER.requirements).toBeLessThan(
      SECTION_ORDER.acceptance_criteria,
    );
    expect(SECTION_ORDER.requirements).toBeLessThan(
      SECTION_ORDER.technical_specification,
    );
    // Tests must come after the things they test.
    expect(SECTION_ORDER.testing).toBeGreaterThan(SECTION_ORDER.requirements);
    expect(SECTION_ORDER.testing).toBeGreaterThan(
      SECTION_ORDER.acceptance_criteria,
    );
  });
});

describe("AgentIdentity + agentSubagentType", () => {
  it("genius identity maps to zetetic-team-subagents:genius:<name>", () => {
    expect(agentSubagentType({ kind: "genius", name: "fermi" })).toBe(
      "zetetic-team-subagents:genius:fermi",
    );
  });

  it("team identity maps to zetetic-team-subagents:<name> (no genius prefix)", () => {
    expect(agentSubagentType({ kind: "team", name: "engineer" })).toBe(
      "zetetic-team-subagents:engineer",
    );
  });

  it("AgentIdentitySchema rejects an unknown genius name", () => {
    const out = AgentIdentitySchema.safeParse({
      kind: "genius",
      name: "not_a_real_genius",
    });
    expect(out.success).toBe(false);
  });

  it("AgentIdentitySchema rejects a team name not in the team enum", () => {
    const out = AgentIdentitySchema.safeParse({
      kind: "team",
      name: "back-end-engineer",
    });
    expect(out.success).toBe(false);
  });
});

describe("ClaimSchema + JudgeVerdictSchema", () => {
  it("ClaimSchema requires claim_id, claim_type, text, evidence", () => {
    const valid = ClaimSchema.safeParse({
      claim_id: "FR-001",
      claim_type: "fr_traceability",
      text: "OAuth login is supported",
      evidence: "## Requirements\n- FR-001: OAuth login",
    });
    expect(valid.success).toBe(true);

    const missingId = ClaimSchema.safeParse({
      claim_type: "fr_traceability",
      text: "x",
      evidence: "y",
    });
    expect(missingId.success).toBe(false);

    const wrongType = ClaimSchema.safeParse({
      claim_id: "X-1",
      claim_type: "definitely_not_a_real_type",
      text: "x",
      evidence: "y",
    });
    expect(wrongType.success).toBe(false);
  });

  it("JudgeVerdictSchema bounds confidence to [0, 1]", () => {
    const ok = JudgeVerdictSchema.safeParse({
      judge: { kind: "genius", name: "fermi" },
      claim_id: "FR-001",
      verdict: "PASS",
      rationale: "x",
      caveats: [],
      confidence: 0.5,
    });
    expect(ok.success).toBe(true);

    const tooHigh = JudgeVerdictSchema.safeParse({
      judge: { kind: "genius", name: "fermi" },
      claim_id: "FR-001",
      verdict: "PASS",
      rationale: "x",
      caveats: [],
      confidence: 1.5,
    });
    expect(tooHigh.success).toBe(false);

    const negative = JudgeVerdictSchema.safeParse({
      judge: { kind: "genius", name: "fermi" },
      claim_id: "FR-001",
      verdict: "PASS",
      rationale: "x",
      caveats: [],
      confidence: -0.1,
    });
    expect(negative.success).toBe(false);
  });
});

describe("extractJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });

  it("strips markdown fences (```json ... ```)", () => {
    expect(extractJsonObject('```json\n{"verdict": "PASS"}\n```')).toEqual({
      verdict: "PASS",
    });
  });

  it("ignores prose preamble and trailing commentary", () => {
    const text = 'Here is my verdict:\n{"verdict": "FAIL"}\nThanks!';
    expect(extractJsonObject(text)).toEqual({ verdict: "FAIL" });
  });

  it("handles nested objects with balanced braces", () => {
    expect(extractJsonObject('{"outer": {"inner": [1, 2, 3]}}')).toEqual({
      outer: { inner: [1, 2, 3] },
    });
  });

  it("throws on text with no JSON object", () => {
    expect(() => extractJsonObject("just a sentence")).toThrow(/no JSON object/);
  });

  it("throws on unbalanced braces", () => {
    expect(() => extractJsonObject('{"a": 1')).toThrow(/unbalanced/);
  });

  it("treats braces inside strings as literal characters", () => {
    expect(extractJsonObject('{"msg": "hello { world }"}')).toEqual({
      msg: "hello { world }",
    });
  });

  it("respects escape sequences inside strings", () => {
    // The closing quote after \" must not terminate the string.
    expect(extractJsonObject('{"msg": "say \\"hi\\""}')).toEqual({
      msg: 'say "hi"',
    });
  });
});
