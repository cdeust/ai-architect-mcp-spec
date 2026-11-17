import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVerdict, extractVerdicts } from "../lib/verdict-extract.mjs";

test("extractVerdict: parses a clean JSON-only reply", () => {
  const raw = '{"verdict":"PASS","rationale":"looks fine","caveats":[],"confidence":0.9}';
  const v = extractVerdict(raw);
  assert.equal(v.verdict, "PASS");
  assert.equal(v.rationale, "looks fine");
  assert.deepEqual(v.caveats, []);
  assert.equal(v.confidence, 0.9);
});

test("extractVerdict: tolerates markdown code fences around the object", () => {
  const raw = '```json\n{"verdict":"FAIL","rationale":"contradiction found","caveats":["c1"],"confidence":0.6}\n```';
  const v = extractVerdict(raw);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.caveats, ["c1"]);
});

test("extractVerdict: tolerates leading prose before the JSON object", () => {
  const raw =
    'Here is my assessment of the claim.\n\n{"verdict":"SPEC-COMPLETE","rationale":"method specified","caveats":[],"confidence":0.75}\n\nLet me know if you need more detail.';
  const v = extractVerdict(raw);
  assert.equal(v.verdict, "SPEC-COMPLETE");
});

test("extractVerdict: handles a brace character inside a quoted rationale without truncating", () => {
  const raw = '{"verdict":"PASS","rationale":"the block { is fine } here","caveats":[],"confidence":0.8}';
  const v = extractVerdict(raw);
  assert.equal(v.rationale, "the block { is fine } here");
});

test("extractVerdict: defaults missing caveats to []", () => {
  const raw = '{"verdict":"PASS","rationale":"ok","confidence":0.5}';
  const v = extractVerdict(raw);
  assert.deepEqual(v.caveats, []);
});

test("extractVerdict: clamps out-of-range confidence into [0,1]", () => {
  assert.equal(extractVerdict('{"verdict":"PASS","rationale":"x","confidence":1.5}').confidence, 1);
  assert.equal(extractVerdict('{"verdict":"PASS","rationale":"x","confidence":-0.2}').confidence, 0);
});

test("extractVerdict: throws a clear error on empty reply", () => {
  assert.throws(() => extractVerdict(""), /empty reply/);
});

test("extractVerdict: throws a clear error when no JSON object is present", () => {
  assert.throws(() => extractVerdict("I refuse to answer in JSON."), /no balanced JSON object/);
});

test("extractVerdict: throws a clear error on an invalid verdict enum value", () => {
  assert.throws(
    () => extractVerdict('{"verdict":"MAYBE","rationale":"x","confidence":0.5}'),
    /must be one of/,
  );
});

test("extractVerdict: throws a clear error on unparseable JSON", () => {
  assert.throws(() => extractVerdict("{verdict: PASS, not valid json}"), /failed to parse/);
});

test("extractVerdict: throws when rationale is missing or empty", () => {
  assert.throws(
    () => extractVerdict('{"verdict":"PASS","rationale":"","confidence":0.5}'),
    /rationale.*non-empty/,
  );
});

// Issue #119: one batched prompt per judge is answered with an array of
// verdicts keyed by claim_id; every element and its claim_id must survive.
test("extractVerdicts: keeps every element of a batched array with its claim_id", () => {
  const reply =
    'Here:\n```json\n[{"claim_id":"FR-001","verdict":"PASS","rationale":"ok","caveats":["a]"],"confidence":0.8},' +
    '{"claim_id":"FR-002","verdict":"FAIL","rationale":"bad","confidence":1.4}]\n```';
  const out = extractVerdicts(reply);
  assert.ok("verdicts" in out);
  assert.deepEqual(
    out.verdicts.map((v) => [v.claim_id, v.verdict, v.confidence]),
    [["FR-001", "PASS", 0.8], ["FR-002", "FAIL", 1]],
  );
  assert.deepEqual(out.verdicts[0].caveats, ["a]"]);
});

test("extractVerdicts: a single object stays one verdict and keeps a claim_id it carries", () => {
  const out = extractVerdicts('{"claim_id":"AC-1","verdict":"PASS","rationale":"r","caveats":[],"confidence":0.5}');
  assert.ok("verdict" in out);
  assert.equal(out.verdict.claim_id, "AC-1");
  const bare = extractVerdicts('{"verdict":"PASS","rationale":"r","caveats":["x [y]"],"confidence":0.5}');
  assert.ok("verdict" in bare);
  assert.equal(bare.verdict.claim_id, undefined);
});

test("extractVerdicts: refuses an element without claim_id or with an invalid verdict, never a partial list", () => {
  assert.throws(() => extractVerdicts('[{"verdict":"PASS","rationale":"r","confidence":0.5}]'), /element 0 has no string "claim_id"/);
  assert.throws(
    () => extractVerdicts('[{"claim_id":"A","verdict":"PASS","rationale":"r","confidence":0.5},{"claim_id":"B","verdict":"MAYBE","rationale":"r","confidence":0.5}]'),
    /"verdict" must be one of/,
  );
  assert.throws(() => extractVerdicts('[{"claim_id":"A"'), /no balanced JSON array/);
});

// Codex review of #326: a bracketed identifier in the prose before the JSON
// is skipped, as the core extractor does, not read as the answer.
test("extractVerdicts: skips a bracketed span of prose before the verdict", () => {
  const out = extractVerdicts('Verdict for [AC-001]: {"claim_id":"AC-001","verdict":"PASS","rationale":"ok","confidence":0.9}');
  assert.ok("verdict" in out);
  assert.equal(out.verdict.claim_id, "AC-001");
  assert.equal(out.verdict.verdict, "PASS");
  const list = extractVerdicts('See {note} then [{"claim_id":"B","verdict":"FAIL","rationale":"r","confidence":0.4}]');
  assert.ok("verdicts" in list);
  assert.equal(list.verdicts[0].claim_id, "B");
});

test("extractVerdicts: a cut array is refused, not read as its first object", () => {
  assert.throws(
    () => extractVerdicts('[{"claim_id":"A","verdict":"PASS","rationale":"r","confidence":0.5}'),
    /no balanced JSON array/,
  );
});

test("extractVerdicts: skips a footnote or checkbox that parses as JSON but is no verdict", () => {
  const out = extractVerdicts('Per [1] and [ ] pending: [{"claim_id":"A","verdict":"PASS","rationale":"r","confidence":0.5}]');
  assert.ok("verdicts" in out);
  assert.equal(out.verdicts[0].claim_id, "A");
  assert.throws(() => extractVerdicts("only [1] and [2] here"), /not a verdict/);
});
