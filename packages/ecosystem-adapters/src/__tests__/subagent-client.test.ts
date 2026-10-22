import { describe, it, expect, beforeEach } from "vitest";
import type { JudgeRequest, SubagentInvocation } from "@prd-gen/core";
import { HostQueueSubagentClient } from "../clients/subagent-client.js";

const req = (id: string, judge: JudgeRequest["judge"] = { kind: "genius", name: "liskov" }): JudgeRequest => ({
  judge,
  claim: {
    claim_id: id,
    claim_type: "fr_traceability",
    text: "System must support OAuth login",
    evidence: "From requirements section.",
    source_section: "requirements",
  },
  context: { prd_excerpt: undefined, codebase_excerpts: [], memory_excerpts: [] },
});

const good = JSON.stringify({
  verdict: "PASS",
  rationale: "traceable",
  caveats: ["none"],
  confidence: 0.9,
});

describe("HostQueueSubagentClient — judge batches", () => {
  let c: HostQueueSubagentClient;
  beforeEach(() => {
    c = new HostQueueSubagentClient();
  });

  it("enqueues one pending invocation per request with the judge's subagent type", () => {
    const { batch_id, pending } = c.enqueueJudgeRequests([
      req("FR-001"),
      req("FR-002", { kind: "team", name: "code-reviewer" }),
    ]);
    expect(pending).toHaveLength(2);
    expect(pending[0]!.batch_id).toBe(batch_id);
    expect(pending[0]!.subagent_type).toBe("zetetic-team-subagents:genius:liskov");
    expect(pending[1]!.subagent_type).toBe("zetetic-team-subagents:code-reviewer");
    expect(pending[0]!.expected).toBe("judge_verdict");
    expect(pending[0]!.invocation_id).not.toBe(pending[1]!.invocation_id);
  });

  it("is incomplete until every invocation has a response", () => {
    const { batch_id, pending } = c.enqueueJudgeRequests([req("A"), req("B")]);
    expect(c.isBatchComplete(batch_id)).toBe(false);
    c.submitResponse(pending[0]!.invocation_id, good);
    expect(c.isBatchComplete(batch_id)).toBe(false);
    expect(() => c.collectJudgeVerdicts(batch_id)).toThrow(/not complete/);
    c.submitResponse(pending[1]!.invocation_id, good);
    expect(c.isBatchComplete(batch_id)).toBe(true);
  });

  it("collects parsed verdicts, tolerating prose around the JSON", () => {
    const { batch_id, pending } = c.enqueueJudgeRequests([req("A")]);
    c.submitResponse(pending[0]!.invocation_id, `Here you go:\n\`\`\`json\n${good}\n\`\`\``);
    const [v] = c.collectJudgeVerdicts(batch_id);
    expect(v).toMatchObject({ claim_id: "A", verdict: "PASS", confidence: 0.9 });
    expect(v!.judge).toEqual({ kind: "genius", name: "liskov" });
  });

  it("turns an unparseable response into a zero-confidence INCONCLUSIVE verdict", () => {
    const { batch_id, pending } = c.enqueueJudgeRequests([req("A")]);
    c.submitResponse(pending[0]!.invocation_id, "not json at all");
    const [v] = c.collectJudgeVerdicts(batch_id);
    expect(v!.verdict).toBe("INCONCLUSIVE");
    expect(v!.confidence).toBe(0);
    expect(v!.rationale).toContain("parse_error");
    expect(v!.caveats).toContain("judge_invocation_failed");
  });

  it("rejects schema-invalid verdict JSON the same way", () => {
    const { batch_id, pending } = c.enqueueJudgeRequests([req("A")]);
    c.submitResponse(
      pending[0]!.invocation_id,
      JSON.stringify({ verdict: "PASS", rationale: "x", confidence: 7 }),
    );
    expect(c.collectJudgeVerdicts(batch_id)[0]!.verdict).toBe("INCONCLUSIVE");
  });

  it("records host-reported errors as INCONCLUSIVE and completes the batch", () => {
    const { batch_id, pending } = c.enqueueJudgeRequests([req("A")]);
    c.submitError(pending[0]!.invocation_id, "agent timed out");
    expect(c.isBatchComplete(batch_id)).toBe(true);
    expect(c.collectJudgeVerdicts(batch_id)[0]!.rationale).toContain("agent timed out");
  });

  it("rejects an invalid claim before queueing anything", () => {
    const bad = req("A");
    (bad.claim as { claim_type: string }).claim_type = "bogus";
    expect(() => c.enqueueJudgeRequests([bad])).toThrow();
  });

  it("throws on unknown batch and invocation ids", () => {
    expect(() => c.isBatchComplete("nope")).toThrow(/Unknown batch id/);
    expect(() => c.collectJudgeVerdicts("nope")).toThrow(/Unknown batch id/);
    expect(() => c.submitResponse("nope", "x")).toThrow(/Unknown invocation id/);
    expect(() => c.submitError("nope", "x")).toThrow(/Unknown invocation id/);
    expect(() => c.collectFreeformResponse("nope")).toThrow(/Unknown invocation id/);
  });
});

describe("HostQueueSubagentClient — freeform invocations", () => {
  const inv = (agent: SubagentInvocation["agent"]): SubagentInvocation => ({
    agent,
    task_description: "design schema",
    prompt: "do it",
    expected_format: "markdown",
    isolation: "worktree",
  });

  it("maps genius and team agents to subagent types and round-trips the response", () => {
    const c = new HostQueueSubagentClient();
    const g = c.enqueueInvocation(inv({ kind: "genius", name: "liskov" }));
    const t = c.enqueueInvocation(inv({ kind: "team", name: "dba" }));
    expect(g.subagent_type).toBe("zetetic-team-subagents:genius:liskov");
    expect(t.subagent_type).toBe("zetetic-team-subagents:dba");
    expect(g).toMatchObject({ expected: "markdown", isolation: "worktree", description: "design schema" });

    c.submitResponse(g.invocation_id, "# done");
    c.submitResponse(t.invocation_id, "ok");
    expect(c.collectFreeformResponse(g.invocation_id)).toEqual({
      agent: { kind: "genius", name: "liskov" },
      text: "# done",
    });
    expect(c.collectFreeformResponse(t.invocation_id).agent).toEqual({ kind: "team", name: "dba" });
  });

  it("refuses to collect before a response or after an error", () => {
    const c = new HostQueueSubagentClient();
    const a = c.enqueueInvocation(inv({ kind: "team", name: "dba" }));
    expect(() => c.collectFreeformResponse(a.invocation_id)).toThrow(/no response yet/);
    c.submitError(a.invocation_id, "boom");
    expect(() => c.collectFreeformResponse(a.invocation_id)).toThrow(/failed: boom/);
  });
});
