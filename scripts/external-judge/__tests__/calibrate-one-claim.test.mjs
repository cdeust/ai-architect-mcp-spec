import { test } from "node:test";
import assert from "node:assert/strict";
import { oneClaimResult, summarize } from "../calibrate.mjs";

const ok = (extra) => ({ status: "ok", model: "m", provider: "p", latency_ms: 1, ...extra });
const v = (claim_id, verdict = "PASS") => ({ claim_id, verdict, rationale: "r", caveats: [], confidence: 0.5 });

// Codex review of #326: runJudge returns `verdicts` when a model wraps its
// answer in an array; calibration reads one claim per prompt.
test("oneClaimResult: a one-element array naming the claim becomes its verdict", () => {
  const out = oneClaimResult(ok({ verdicts: [v("AC-008", "FAIL")] }), "AC-008");
  assert.equal(out.status, "ok");
  assert.equal(out.verdict.verdict, "FAIL");
  assert.equal(out.verdicts, undefined);
});

test("oneClaimResult: any other array is a per-claim error", () => {
  assert.match(oneClaimResult(ok({ verdicts: [v("AC-001")] }), "AC-008").reason, /expected one verdict for AC-008, got 1: AC-001/);
  assert.equal(oneClaimResult(ok({ verdicts: [v("AC-008"), v("AC-009")] }), "AC-008").status, "error");
  assert.equal(oneClaimResult(ok({ verdicts: [] }), "AC-008").status, "error");
});

test("oneClaimResult: leaves a single verdict, a skip and an error unchanged", () => {
  const single = ok({ verdict: v(undefined) });
  assert.equal(oneClaimResult(single, "AC-008"), single);
  const skipped = { status: "skipped", reason: "no key" };
  assert.equal(oneClaimResult(skipped, "AC-008"), skipped);
});

test("summarize: reads normalized rows without crashing", () => {
  const rows = [
    { claim: { claim_id: "AC-008", expected_verdict: "FAIL" }, result: oneClaimResult(ok({ verdicts: [v("AC-008", "FAIL")] }), "AC-008") },
    { claim: { claim_id: "AC-001", expected_verdict: "PASS" }, result: oneClaimResult(ok({ verdicts: [v("X")] }), "AC-001") },
  ];
  const s = summarize(rows);
  assert.equal(s.scored, 1);
  assert.equal(s.errored, 1);
  assert.equal(s.ac008Caught, true);
});
