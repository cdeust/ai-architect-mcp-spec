/**
 * Unit tests for the tool-profile logic (issue #28, criteria 5 & 8).
 */
import { describe, expect, it } from "vitest";
import {
  INTERNAL_TOOL_NAMES,
  VERIFIER_TOOL_NAMES,
  instructions,
  isAllowed,
  parseProfile,
  resolveProfile,
} from "../tool-profiles.js";

const ALL_TOOL_NAMES = [
  "get_config",
  "read_skill_config",
  "check_health",
  "get_prd_context_info",
  "list_available_strategies",
  "validate_prd_section",
  "validate_prd_document",
  "get_quality_history",
  "get_strategy_effectiveness",
  "map_failure_to_retrieval",
  "start_pipeline",
  "submit_action_result",
  "get_pipeline_state",
  "plan_section_verification",
  "plan_document_verification",
  "conclude_verification",
] as const;

describe("resolveProfile", () => {
  it("defaults to full", () => {
    expect(resolveProfile([], {})).toBe("full");
  });

  it("reads PRD_GEN_PROFILE when no flag", () => {
    expect(resolveProfile([], { PRD_GEN_PROFILE: "agent" })).toBe("agent");
  });

  it("flag wins over env", () => {
    expect(resolveProfile(["--profile", "full"], { PRD_GEN_PROFILE: "agent" })).toBe("full");
  });

  it("supports --profile=<value>", () => {
    expect(resolveProfile(["--profile=agent"], {})).toBe("agent");
    expect(resolveProfile(["--profile=verifier"], {})).toBe("verifier");
  });

  it("throws on an unknown profile name (criterion 8)", () => {
    expect(() => resolveProfile([], { PRD_GEN_PROFILE: "bogus" })).toThrow(/invalid profile/);
    expect(() => parseProfile("scout")).toThrow(/expected full, agent, verifier/);
  });

  it("throws on a trailing --profile with no value", () => {
    expect(() => resolveProfile(["--profile"], {})).toThrow(/requires a value/);
  });
});

describe("isAllowed", () => {
  it("full allows every tool", () => {
    for (const name of INTERNAL_TOOL_NAMES) {
      expect(isAllowed("full", name)).toBe(true);
    }
    expect(isAllowed("full", "start_pipeline")).toBe(true);
  });

  it("agent excludes exactly the internal tools", () => {
    for (const name of INTERNAL_TOOL_NAMES) {
      expect(isAllowed("agent", name)).toBe(false);
    }
  });

  it("agent allows the pipeline/generation tools", () => {
    for (const name of [
      "start_pipeline",
      "submit_action_result",
      "get_pipeline_state",
      "map_failure_to_retrieval",
      "validate_prd_document",
      "conclude_verification",
    ]) {
      expect(isAllowed("agent", name)).toBe(true);
    }
  });

  it("verifier allows exactly the two deterministic validators", () => {
    expect(VERIFIER_TOOL_NAMES).toEqual([
      "validate_prd_section",
      "validate_prd_document",
    ]);
    expect(ALL_TOOL_NAMES).toHaveLength(16);

    for (const name of ALL_TOOL_NAMES) {
      expect(isAllowed("verifier", name)).toBe(
        (VERIFIER_TOOL_NAMES as readonly string[]).includes(name),
      );
    }
  });

  it("verifier rejects unknown and non-validator tools", () => {
    expect(isAllowed("verifier", "start_pipeline")).toBe(false);
    expect(isAllowed("verifier", "get_config")).toBe(false);
    expect(isAllowed("verifier", "not_registered")).toBe(false);
  });
});

describe("instructions", () => {
  it("differ by profile and describe their entry points", () => {
    const full = instructions("full");
    const agent = instructions("agent");
    const verifier = instructions("verifier");
    expect(full).not.toBe(agent);
    expect(verifier).not.toBe(full);
    expect(full).toContain("full");
    expect(agent).toContain("agent");
    expect(verifier).toContain("verifier");
    expect(full).toContain("start_pipeline");
    expect(agent).toContain("start_pipeline");
    expect(verifier).toContain("validate_prd_document");
    expect(verifier).toContain("does not establish factual accuracy");
  });
});
