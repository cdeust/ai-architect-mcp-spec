import { describe, expect, it } from "vitest";
import { newPipelineState, step } from "../index.js";
import type { PipelineState } from "../index.js";

// source: cdeust/ai-architect-mcp-spec#122 — a failed draft is not a
// deliverable, so no JIRA ticket may be built from it either.
type Section = PipelineState["sections"][number];

function section(section_type: Section["section_type"], status: Section["status"]): Section {
  return {
    section_type,
    status,
    attempt: status === "failed" ? 3 : 1,
    violation_count: 0,
    last_violations: [],
    content: `${status.toUpperCase()} DRAFT of ${section_type}`,
  };
}

function atJira(sections: Section[]): PipelineState {
  const s = newPipelineState({ run_id: "test_jira_failed", feature_description: "x" });
  return { ...s, current_step: "jira_generation", prd_context: "feature", sections };
}

describe("jira_generation — failed section drafts are not source material", () => {
  it("builds the prompt from passed sections only", () => {
    const out = step({
      state: atJira([section("requirements", "passed"), section("user_stories", "failed")]),
    });
    expect(out.action.kind).toBe("spawn_subagents");
    const prompt = out.action.kind === "spawn_subagents" ? out.action.invocations[0].prompt : "";
    expect(prompt).toContain("PASSED DRAFT of requirements");
    expect(prompt).not.toContain("FAILED DRAFT");
  });

  it("skips JIRA generation when every source section failed", () => {
    const out = step({
      state: atJira([
        section("requirements", "failed"),
        section("user_stories", "failed"),
        section("acceptance_criteria", "failed"),
      ]),
    });
    // The runner chains the skip message straight into file_export's first write.
    expect(out.action.kind).toBe("write_file");
    expect(out.state.current_step).toBe("file_export");
  });
});
