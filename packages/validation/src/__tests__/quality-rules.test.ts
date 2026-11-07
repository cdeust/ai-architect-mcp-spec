/**
 * Contract tests for the quality Hard Output Rules.
 *
 * Three of these functions carry an explicit bug history in their own source
 * comments — a self-reference regex that walked across table rows, an operator
 * class that never matched `<=`, and a backtracking header pattern. That
 * history is the reason each rule gets both a positive and a negative case
 * here: these are checks whose failure mode is silence, so "does not flag when
 * it should not" is as load-bearing as "flags when it should".
 */

import { describe, expect, it } from "vitest";
import type { SectionType } from "@prd-gen/core";
import {
  checkDeploymentRollbackPlan,
  checkDocumentVerificationVerdicts,
  checkHonestVerificationVerdicts,
  checkMetricsDisclaimer,
  checkNoSelfReferencingDeps,
  checkRiskMitigationCompleteness,
} from "../hard-output-rules/rules/quality-rules.js";

const REQ = "requirements" as SectionType;
const PERF = "performance_requirements" as SectionType;
const RISKS = "risks" as SectionType;
const DEPLOY = "deployment" as SectionType;

describe("checkNoSelfReferencingDeps", () => {
  it("flags a table row that depends on its own identifier", () => {
    const v = checkNoSelfReferencingDeps("| FR-001 | thing | Depends On: FR-001 |", REQ);
    expect(v.length).toBeGreaterThan(0);
  });

  it("does not flag the same identifier appearing in two different rows", () => {
    // The regression its source comment records: `[^|]*` matched across the
    // newline, so a later row's Depends-On falsely implicated an earlier row.
    const content = "| FR-001 | first |\n| FR-002 | second | Depends On: FR-001 |";
    expect(checkNoSelfReferencingDeps(content, REQ)).toEqual([]);
  });

  it("does not flag a table with no dependency column at all", () => {
    expect(checkNoSelfReferencingDeps("| FR-001 | a |\n| FR-002 | b |", REQ)).toEqual([]);
  });

  it("returns nothing for empty content", () => {
    expect(checkNoSelfReferencingDeps("", REQ)).toEqual([]);
  });
});

describe("checkMetricsDisclaimer", () => {
  const metrics = "Reasoning quality metric: 94%";

  it("flags reasoning metrics published without a disclaimer", () => {
    const v = checkMetricsDisclaimer(metrics, PERF);
    expect(v).toHaveLength(1);
    expect(v[0].message).toMatch(/model-projected/i);
  });

  it.each(["model-projected", "projected", "not independent", "disclaimer"])(
    "accepts %s as the disclaimer",
    (word) => {
      expect(checkMetricsDisclaimer(`${metrics} (${word})`, PERF)).toEqual([]);
    },
  );

  it("is case-insensitive about both the trigger and the disclaimer", () => {
    expect(checkMetricsDisclaimer("REASONING METRIC — MODEL-PROJECTED", PERF)).toEqual([]);
  });

  it("stays silent when the content is not about reasoning metrics", () => {
    expect(checkMetricsDisclaimer("latency is 200ms", PERF)).toEqual([]);
    // Needs BOTH words; one alone must not trigger.
    expect(checkMetricsDisclaimer("a metric", PERF)).toEqual([]);
    expect(checkMetricsDisclaimer("some reasoning", PERF)).toEqual([]);
  });
});

describe("checkHonestVerificationVerdicts", () => {
  const withVerdicts = (nfr: string) =>
    ["## Verification", "", nfr, "", "Verdict: PASS", "Verdict: PASS", ""].join("\n");

  it.each(["p95 <= 200", "p95 < 200", "p95 ≤ 200", "p95: 200", "p95 = 200"])(
    "treats %s as an NFR",
    (nfr) => {
      expect(checkHonestVerificationVerdicts(withVerdicts(nfr), PERF).length).toBeGreaterThan(0);
    },
  );

  it("does not flag when there is no NFR-shaped statement", () => {
    expect(checkHonestVerificationVerdicts(withVerdicts("p99 >= 5"), PERF)).toEqual([]);
  });

  it("returns nothing for empty content", () => {
    expect(checkHonestVerificationVerdicts("", PERF)).toEqual([]);
  });

  // #118: the rule required at least two verdicts, so a single PASS on a
  // latency claim passed the deterministic checks.
  it("flags a single PASS verdict on a latency claim", () => {
    const content = ["## Verification", "", "p95 <= 200", "", "Verdict: PASS"].join("\n");
    const v = checkHonestVerificationVerdicts(content, PERF);
    expect(v.map((x) => x.rule)).toEqual(["honest_verification_verdicts"]);
  });

  it("does not count the English verb 'pass' as a verdict", () => {
    const content = "p95 <= 200 ms. Requests pass through the gateway; retries pass the token.";
    expect(checkHonestVerificationVerdicts(content, PERF)).toEqual([]);
  });

  it("counts a mixed-case verdict written after a Verdict: label", () => {
    const content = ["p95 <= 200", "", "Verdict: Pass"].join("\n");
    const v = checkHonestVerificationVerdicts(content, PERF);
    expect(v.map((x) => x.rule)).toEqual(["honest_verification_verdicts"]);
  });

  it("accepts a labelled mixed-case Spec-Complete next to a PASS", () => {
    const content = ["p95 <= 200", "Verdict: Spec-Complete", "| T-1 | PASS |"].join("\n");
    expect(checkHonestVerificationVerdicts(content, PERF)).toEqual([]);
  });

  it("does not count prose 'fail' as a verdict that cancels a PASS", () => {
    const content = ["p95 <= 200", "Requests fail over to the replica.", "Verdict: PASS"].join("\n");
    const v = checkHonestVerificationVerdicts(content, PERF);
    expect(v.map((x) => x.rule)).toEqual(["honest_verification_verdicts"]);
  });

  it("accepts a single NEEDS-RUNTIME verdict on a latency claim", () => {
    const content = ["p95 <= 200", "", "Verdict: NEEDS-RUNTIME"].join("\n");
    expect(checkHonestVerificationVerdicts(content, PERF)).toEqual([]);
  });

  it("accepts a PASS alongside a SPEC-COMPLETE verdict", () => {
    const content = ["p95 <= 200", "Verdict: PASS", "Verdict: SPEC-COMPLETE"].join("\n");
    expect(checkHonestVerificationVerdicts(content, PERF)).toEqual([]);
  });
});

describe("checkDocumentVerificationVerdicts", () => {
  it("examines the performance sections of a document", () => {
    const v = checkDocumentVerificationVerdicts([
      { type: PERF, content: ["## Verification", "", "p95 <= 200", "", "Verdict: PASS", "Verdict: PASS"].join("\n") },
    ]);
    expect(v.length).toBeGreaterThan(0);
  });

  it("returns nothing when the document has no performance section", () => {
    expect(checkDocumentVerificationVerdicts([{ type: REQ, content: "FR-1 a" }])).toEqual([]);
  });

  it("returns nothing for an empty document", () => {
    expect(checkDocumentVerificationVerdicts([])).toEqual([]);
  });
});

describe("checkRiskMitigationCompleteness", () => {
  const table = (mitigation: string) =>
    ["| Risk | Mitigation |", "|---|---|", `| Data loss | ${mitigation} |`].join("\n");

  it.each(["", "-", "N/A", "na", "TBD", "todo", "None"])(
    "flags %s as a placeholder mitigation",
    (placeholder) => {
      const v = checkRiskMitigationCompleteness(table(placeholder), RISKS);
      expect(v.length).toBeGreaterThan(0);
    },
  );

  it("accepts a real mitigation", () => {
    expect(checkRiskMitigationCompleteness(table("Nightly offsite backups"), RISKS)).toEqual([]);
  });

  it("needs both a risk word and an action word in the header", () => {
    const noAction = ["| Risk | Owner |", "|---|---|", "| Data loss | TBD |"].join("\n");
    expect(checkRiskMitigationCompleteness(noAction, RISKS)).toEqual([]);
  });

  it("ignores the separator row rather than treating it as a risk", () => {
    const v = checkRiskMitigationCompleteness(table("Nightly offsite backups"), RISKS);
    expect(v).toEqual([]);
  });

  it("names the risk in the message so the finding is actionable", () => {
    const v = checkRiskMitigationCompleteness(table("TBD"), RISKS);
    expect(v[0].message + (v[0].offendingContent ?? "")).toMatch(/Data loss/);
  });

  it("returns nothing when there is no table at all", () => {
    expect(checkRiskMitigationCompleteness("prose about risk and mitigation", RISKS)).toEqual([]);
  });
});

describe("checkDeploymentRollbackPlan", () => {
  it("flags a deployment section with no rollback plan", () => {
    const v = checkDeploymentRollbackPlan("Deploy with kubectl apply and monitor.", DEPLOY);
    expect(v.length).toBeGreaterThan(0);
  });

  it("accepts a section that describes a rollback", () => {
    expect(
      checkDeploymentRollbackPlan("Deploy with kubectl apply. Rollback: kubectl rollout undo.", DEPLOY),
    ).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(checkDeploymentRollbackPlan("ROLLBACK PROCEDURE documented", DEPLOY)).toEqual([]);
  });
});
