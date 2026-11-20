/**
 * Prompt-builder field-presence tests.
 *
 * Per cross-audit test-engineer M4 (Phase 3+4, 2026-04): meta-prompting is
 * high-stakes. A regression that drops a required field from a generated
 * prompt does NOT surface in any downstream test that uses canned subagent
 * responses (the canned dispatcher returns a fixed verdict regardless of the
 * prompt it receives).
 *
 * Strategy: assert that load-bearing inputs make it INTO the rendered prompt,
 * not that the prompt is "well-written." We pin the structural contract
 * (feature description, prior Q&A, prior violations, codebase context) so a
 * reader of the prompt can do the work the prompt was constructed for.
 */

import { describe, expect, it } from "vitest";
import {
  buildClarificationPrompt,
  buildSectionPrompt,
  buildJiraPrompt,
  buildGitHistoryPrompt,
} from "../index.js";

describe("buildClarificationPrompt", () => {
  it("includes the feature description verbatim", () => {
    const out = buildClarificationPrompt({
      feature_description: "build OAuth login for the admin console",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
    });
    expect(out).toContain("build OAuth login for the admin console");
  });

  it("includes the prd_context displayName (not just the enum value)", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
    });
    // PRD_CONTEXT_CONFIGS["feature"].displayName = "Feature"
    expect(out).toContain("Feature");
  });

  it("tells the composer the last round: the size's when the run has one, else the kind's (#119)", () => {
    const round = (request_size?: "standard" | "tiny", prd_context: "feature" | "incident" = "feature") =>
      buildClarificationPrompt({
        feature_description: "x",
        prd_context,
        request_size,
        round: 2,
        prior_qa: [],
        recall_summary: "",
      });
    // One block per line, the empty lines dropped: the prompt is text, not a list.
    expect(round()).toContain("</role>\n<feature>x</feature>\n<round>2 of 10</round>\n<prior_questions_and_answers>");
    expect(round("standard")).toContain("<round>2 of 10</round>");
    expect(round("tiny")).toContain("<round>2 of 5</round>");
    // An incident is never a fast path.
    expect(round("tiny", "incident")).toContain("<round>2 of 12</round>");
  });

  it("includes prior Q&A when present", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 2,
      prior_qa: [
        {
          question: "What is the success metric?",
          answer: "p95 latency under 250ms",
        },
      ],
      recall_summary: "",
    });
    expect(out).toContain("What is the success metric?");
    expect(out).toContain("p95 latency under 250ms");
  });

  it("labels each prior_qa entry with its chronological round (1..N, not all identical)", () => {
    // Regression test: the round label must be derived from the entry's
    // position in prior_qa (round 1 first, chronological, no gaps — see
    // handlers/clarification.ts), never from a round-independent expression.
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 4,
      prior_qa: [
        { question: "Q1?", answer: "A1" },
        { question: "Q2?", answer: "A2" },
        { question: "Q3?", answer: "A3" },
      ],
      recall_summary: "",
    });
    expect(out).toContain("Round 1:\nQ: Q1?\nA: A1");
    expect(out).toContain("Round 2:\nQ: Q2?\nA: A2");
    expect(out).toContain("Round 3:\nQ: Q3?\nA: A3");
    expect(out).not.toContain("Round 4:");
  });

  it("renders '(no prior questions)' when prior_qa is empty", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
    });
    expect(out).toContain("(no prior questions)");
  });

  it("includes the round number against the context max", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 3,
      prior_qa: [],
      recall_summary: "",
    });
    // PRD_CONTEXT_CONFIGS["feature"].clarificationRange[1] = 10
    expect(out).toContain("3 of 10");
  });

  it("includes recall_summary in a bounded codebase_context block", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "MEMORY EXCERPT: oauth handler at src/auth.ts",
    });
    expect(out).toContain("MEMORY EXCERPT: oauth handler at src/auth.ts");
    expect(out).toContain("<codebase_context>");
  });

  it("omits the codebase_context block when recall_summary is empty", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
    });
    expect(out).not.toContain("<codebase_context>");
  });

  it("includes git_history_summary in a bounded git_history block", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
      git_history_summary: "PR #409 tried an LRU cache here; reverted.",
    });
    expect(out).toContain("PR #409 tried an LRU cache here; reverted.");
    expect(out).toContain("<git_history>");
  });

  it("omits the git_history block when git_history_summary is absent/empty", () => {
    const withoutField = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
    });
    const withEmpty = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
      git_history_summary: "",
    });
    expect(withoutField).not.toContain("<git_history>");
    expect(withEmpty).not.toContain("<git_history>");
  });
});

describe("buildSectionPrompt", () => {
  it("includes the section display name and PRD context", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "OAuth login",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    // SECTION_DISPLAY_NAMES["requirements"] = "Requirements"
    expect(out).toContain("Requirements");
    expect(out).toContain("Feature");
  });

  it("includes the feature description", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "OAuth login for admin console",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    expect(out).toContain("OAuth login for admin console");
  });

  it("includes clarification Q&A only when answer is present", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [
        { question: "Answered Q?", answer: "Yes — measured." },
        { question: "Pending Q?", answer: "" },
      ],
      prior_violations: [],
      attempt: 1,
    });
    expect(out).toContain("Answered Q?");
    expect(out).toContain("Yes — measured.");
    expect(out).not.toContain("Pending Q?");
  });

  it("uses the shared decision register once in place of the older Q&A block", () => {
    const register = "<decision_register>Recorded evidence.</decision_register>";
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [{ question: "Old question", answer: "Old answer" }],
      decision_register: register,
      prior_violations: [],
      attempt: 1,
    });
    expect(out.split(register)).toHaveLength(2);
    expect(out).not.toContain("<clarifications>");
    expect(out).not.toContain("Old answer");
  });

  it("on attempt > 1, embeds prior_violations in a previous_attempt_failed block", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: ["[fr_numbering_gaps] FR-099 missing predecessors"],
      attempt: 2,
    });
    expect(out).toContain("Attempt 1 produced violations:");
    expect(out).toContain("fr_numbering_gaps");
    expect(out).toContain("Fix every violation in this attempt.");
  });

  it("on attempt 1, does NOT include the previous_attempt_failed block", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    expect(out).not.toContain("previous_attempt_failed");
    expect(out).not.toContain("Fix every violation");
  });

  it("renders a <strategies> block when strategy_assignment is provided (Phase 4 wiring)", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "OAuth login",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
      strategy_assignment: {
        required: ["chain_of_thought", "verified_reasoning"],
        optional: ["self_consistency"],
        forbidden: ["zero_shot"],
        expectedImprovement: 0.32,
        assignmentConfidence: 0.85,
        claimAnalysis: {
          claim: "Requirements: OAuth login",
          characteristics: ["multi_step_logic", "structural_reasoning"],
          complexityScore: 0.5,
          complexityTier: "moderate",
          analysisNotes: [],
        },
        researchCitations: ["arXiv:2501.12948"],
      },
    });
    expect(out).toContain("<strategies>");
    expect(out).toContain("chain_of_thought");
    expect(out).toContain("verified_reasoning");
    expect(out).toContain("self_consistency");
    expect(out).toContain("zero_shot");
    expect(out).toContain("REQUIRED");
    expect(out).toContain("OPTIONAL");
    expect(out).toContain("FORBIDDEN");
    expect(out).toContain("arXiv:2501.12948");
    expect(out).toContain("32.0%");
    expect(out).toContain("85.0%");
  });

  it("omits the <strategies> block when strategy_assignment is absent (back-compat)", () => {
    const out = buildSectionPrompt({
      // Use `overview` rather than `requirements` for this back-compat
      // assertion: requirements section guidance contains the word
      // "FORBIDDEN" as part of "SP column FORBIDDEN here", which would
      // mask a real regression. Overview's guidance is strategy-block-free.
      section_type: "overview",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    expect(out).not.toContain("<strategies>");
    expect(out).not.toContain("REQUIRED (apply all of these)");
    expect(out).not.toContain("FORBIDDEN (do NOT apply");
  });

  it("renders a <codebase_grounding> block with real symbols/communities/processes when grounding is provided", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "OAuth login",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
      codebase_grounding: {
        finding_summary: "OAuth touches 3 auth-layer symbols.",
        matched_symbols: [
          {
            qualified_name: "src/auth.ts::loginHandler",
            name: "loginHandler",
            label: "function",
            file_path: "src/auth.ts",
            community_id: 7,
          },
          {
            qualified_name: "src/session.ts::SessionStore",
            name: "SessionStore",
            label: "class",
            file_path: "src/session.ts",
            community_id: 7,
          },
        ],
        impacted_communities: ["auth", "session"],
        impacted_processes: ["login_flow", "token_refresh"],
        graph_stats: {
          nodes: 1200,
          edges: 4300,
          communities: 18,
          processes: 12,
        },
      },
    });
    expect(out).toContain("<codebase_grounding>");
    // matched-symbol text: name + file_path + community
    expect(out).toContain("loginHandler");
    expect(out).toContain("src/auth.ts");
    expect(out).toContain("community 7");
    expect(out).toContain("SessionStore");
    // impacted communities + processes
    expect(out).toContain("auth");
    expect(out).toContain("login_flow");
    // graph stats header
    expect(out).toContain("1200 nodes");
    // finding summary
    expect(out).toContain("OAuth touches 3 auth-layer symbols.");
  });

  it("caps matched symbols at 15 and reports the true total", () => {
    const matched_symbols = Array.from({ length: 40 }, (_, i) => ({
      qualified_name: `src/f${i}.ts::sym${i}`,
      name: `sym${i}`,
      file_path: `src/f${i}.ts`,
      community_id: i,
    }));
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
      codebase_grounding: { matched_symbols },
    });
    expect(out).toContain("showing 15 of 40");
    expect(out).toContain("sym0");
    expect(out).toContain("sym14");
    // 16th symbol (index 15) must be dropped by the cap
    expect(out).not.toContain("sym15 —");
  });

  it("includes the <git_history> block when git_history_summary is present", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
      git_history_summary: "Commit a1b2c3d introduced the auth module.",
    });
    expect(out).toContain("<git_history>");
    expect(out).toContain("Commit a1b2c3d introduced the auth module.");
  });

  it("omits the <git_history> block when git_history_summary is absent (back-compat, byte-identical)", () => {
    const base = {
      section_type: "overview" as const,
      feature_description: "x",
      prd_context: "feature" as const,
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    };
    const withoutField = buildSectionPrompt(base);
    const withUndefined = buildSectionPrompt({
      ...base,
      git_history_summary: undefined,
    });
    expect(withoutField).not.toContain("<git_history>");
    expect(withUndefined).toBe(withoutField);
  });

  it("omits the <codebase_grounding> block when grounding is absent (back-compat, byte-identical)", () => {
    const base = {
      section_type: "overview" as const,
      feature_description: "x",
      prd_context: "feature" as const,
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    };
    const withoutField = buildSectionPrompt(base);
    const withUndefined = buildSectionPrompt({
      ...base,
      codebase_grounding: undefined,
    });
    expect(withoutField).not.toContain("<codebase_grounding>");
    expect(withUndefined).not.toContain("<codebase_grounding>");
    // No empty tag, and the two renderings are identical → backward compatible.
    expect(withUndefined).toBe(withoutField);
  });

  it("omits the <codebase_grounding> block when grounding is present but carries no usable evidence", () => {
    const out = buildSectionPrompt({
      section_type: "overview",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
      codebase_grounding: {
        matched_symbols: [],
        impacted_communities: [],
        impacted_processes: [],
      },
    });
    expect(out).not.toContain("<codebase_grounding>");
  });

  it("includes the COMMON_RULES that gate downstream validators", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    // Load-bearing rules — these align with the validation package's regex
    // patterns. If a rule is dropped here AND in validation, the contract
    // silently weakens. The tests in @prd-gen/validation pin the validator
    // side; this pins the prompt side.
    expect(out).toContain("FR-XXX");
    expect(out).toContain("AC-XXX");
    expect(out).toContain("Source:");
  });

  it("includes the affected-symbols instruction for technical_specification only (stage-6.md §4.2)", () => {
    const techSpec = buildSectionPrompt({
      section_type: "technical_specification",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    expect(techSpec).toContain("<!-- AFFECTED_SYMBOLS_JSON -->");
    expect(techSpec).toContain("affected_symbols");
    expect(techSpec).toContain("scope_claims");
    expect(techSpec).toContain("qualified_name");

    const requirements = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    expect(requirements).not.toContain("AFFECTED_SYMBOLS_JSON");
    expect(requirements).not.toContain("affected_symbols_instruction");
  });
});

describe("buildJiraPrompt", () => {
  it("includes feature description and source sections", () => {
    const out = buildJiraPrompt({
      feature_description: "OAuth login for admin console",
      source_sections: [
        {
          section_type: "requirements",
          content: "## Requirements\n\n- FR-001: OAuth login.",
        },
        {
          section_type: "acceptance_criteria",
          content: "## Acceptance Criteria\n\n- AC-001: User signs in.",
        },
      ],
    });
    expect(out).toContain("OAuth login for admin console");
    expect(out).toContain("FR-001");
    expect(out).toContain("AC-001");
  });

  it("filters out sections with empty content", () => {
    const out = buildJiraPrompt({
      feature_description: "x",
      source_sections: [
        { section_type: "requirements", content: "## Requirements\n- FR-001: x" },
        { section_type: "user_stories", content: "" }, // empty → filtered
      ],
    });
    expect(out).toContain("FR-001");
    // The empty section's heading should NOT appear in the source block.
    // The phrase "## Source: user_stories" would be the rendered header.
    expect(out).not.toContain("## Source: user_stories");
  });

  it("includes load-bearing JIRA rules (AC reuse, SP arithmetic, no self-deps)", () => {
    const out = buildJiraPrompt({
      feature_description: "x",
      source_sections: [
        { section_type: "requirements", content: "## Requirements\n- FR-001: x" },
      ],
    });
    expect(out).toContain("AC IDs MUST match");
    expect(out).toContain("SP totals");
    expect(out.toLowerCase()).toContain("self-dependency");
  });
});

describe("buildGitHistoryPrompt", () => {
  it("includes codebase_path, feature description, and the not-a-git-repo instruction", () => {
    const out = buildGitHistoryPrompt({
      feature_description: "build OAuth login",
      codebase_path: "/repo/target",
    });
    expect(out).toContain("/repo/target");
    expect(out).toContain("build OAuth login");
    expect(out).toContain("not inside a git repository");
    expect(out).not.toContain("code_graph_hint");
  });

  it("includes the grounding_summary hint when provided", () => {
    const out = buildGitHistoryPrompt({
      feature_description: "x",
      codebase_path: "/repo",
      grounding_summary: "Code-graph grounding found 3 matched symbol(s).",
    });
    expect(out).toContain("<code_graph_hint>");
    expect(out).toContain("3 matched symbol(s)");
  });

  it("omits the code_graph_hint block when grounding_summary is absent (back-compat, byte-identical)", () => {
    const base = { feature_description: "x", codebase_path: "/repo" };
    const withoutField = buildGitHistoryPrompt(base);
    const withUndefined = buildGitHistoryPrompt({
      ...base,
      grounding_summary: undefined,
    });
    expect(withoutField).not.toContain("<code_graph_hint>");
    expect(withUndefined).toBe(withoutField);
  });
});
