/**
 * Tolerant extraction of the verdict JSON object from a raw LLM reply.
 *
 * The judge prompt instructs "exactly one JSON object, no prose, no
 * markdown fences" (packages/verification/src/judge-prompt.ts
 * RESPONSE_SCHEMA), but external cross-vendor models do not always comply —
 * they may wrap the object in ```json fences or prepend a sentence. This
 * module finds the first balanced `{...}` object in the text and validates
 * it against the same verdict shape, rather than trusting `response.trim()`
 * to already be clean JSON.
 *
 * Precondition: `rawText` is the full text content of the model's reply.
 * Postcondition: returns a `Verdict` object with exactly the fields
 * {verdict, rationale, caveats, confidence}, `caveats` defaulted to `[]` if
 * absent, `confidence` clamped into [0, 1]. Throws `Error` with a message
 * naming the specific failure (no JSON found / JSON invalid / verdict enum
 * invalid / confidence out of range) — never returns a partial object.
 *
 * source (verdict taxonomy + schema): packages/verification/src/judge-prompt.ts
 * (VERDICT_TAXONOMY, RESPONSE_SCHEMA) — duplicated here rather than imported
 * because scripts/external-judge is required to be dependency-free and
 * standalone from packages/ (task scope: scripts/ + docs only, zero overlap
 * with the packages/ tree). Keep the two enums in sync manually if the
 * taxonomy changes upstream.
 */

export const VERDICT_VALUES = /** @type {const} */ ([
  "PASS",
  "SPEC-COMPLETE",
  "NEEDS-RUNTIME",
  "INCONCLUSIVE",
  "FAIL",
]);

/**
 * @typedef {object} Verdict
 * @property {typeof VERDICT_VALUES[number]} verdict
 * @property {string} rationale
 * @property {string[]} caveats
 * @property {number} confidence
 */

/**
 * Scan `text` for the first syntactically balanced `{...}` substring,
 * respecting string literals (so a `}` inside a quoted rationale doesn't
 * terminate the scan early).
 *
 * @param {string} text
 * @returns {string|null}
 */
function findFirstBalancedObject(text) {
  return findFirstBalanced(text, text.indexOf("{"));
}

/**
 * Same scan from `start` (an index of `{` or `[`), counting both kinds of
 * bracket, so an array of objects closes on its own `]`.
 *
 * @param {string} text
 * @param {number} start
 * @returns {string|null}
 */
function findFirstBalanced(text, start) {
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null; // no balanced close found
}

/**
 * @param {string} rawText
 * @returns {Verdict}
 */
export function extractVerdict(rawText) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    throw new Error("extractVerdict: empty reply — no JSON to parse");
  }

  const candidate = findFirstBalancedObject(rawText);
  if (!candidate) {
    throw new Error("extractVerdict: no balanced JSON object found in reply");
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `extractVerdict: candidate JSON object failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return toVerdict(parsed);
}

/**
 * Validate one parsed value as a verdict.
 *
 * @param {unknown} parsed
 * @returns {Verdict}
 */
function toVerdict(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("extractVerdict: parsed value is not an object");
  }

  const obj = /** @type {Record<string, unknown>} */ (parsed);

  if (typeof obj.verdict !== "string" || !VERDICT_VALUES.includes(/** @type {any} */ (obj.verdict))) {
    throw new Error(
      `extractVerdict: "verdict" must be one of ${VERDICT_VALUES.join(", ")}; got ${JSON.stringify(obj.verdict)}`,
    );
  }
  if (typeof obj.rationale !== "string" || obj.rationale.trim().length === 0) {
    throw new Error('extractVerdict: "rationale" must be a non-empty string');
  }
  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
    throw new Error('extractVerdict: "confidence" must be a finite number');
  }
  const confidence = Math.min(1, Math.max(0, obj.confidence));

  const caveats = Array.isArray(obj.caveats) ? obj.caveats.filter((c) => typeof c === "string") : [];

  return {
    verdict: /** @type {typeof VERDICT_VALUES[number]} */ (obj.verdict),
    rationale: obj.rationale,
    caveats,
    confidence,
  };
}

/**
 * @typedef {Verdict & {claim_id?: string}} ClaimVerdict
 */

/**
 * Read a reply to a single-claim prompt or to a batched one (one prompt per
 * judge, issue #119: packages/verification/src/judge-prompt.ts
 * buildBatchedJudgePrompt asks for a JSON array with one object per
 * claim_id).
 *
 * Postcondition: when the first JSON value of the reply is an array, returns
 * `{verdicts}`, one ClaimVerdict per element, each carrying its string
 * `claim_id`; when it is an object, returns `{verdict}`, with its `claim_id`
 * when the object has a string one. Throws on the first element that is not
 * a valid verdict or lacks a claim_id, like extractVerdict — never returns a
 * partial list, so a host does not mistake a dropped claim for an answer.
 *
 * @param {string} rawText
 * @returns {{verdict: ClaimVerdict} | {verdicts: ClaimVerdict[]}}
 */
export function extractVerdicts(rawText) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    throw new Error("extractVerdicts: empty reply — no JSON to parse");
  }
  const obj = rawText.indexOf("{");
  const arr = rawText.indexOf("[");
  if (arr === -1 || (obj !== -1 && obj < arr)) {
    const verdict = withClaimId(extractVerdict(rawText), findFirstBalancedObject(rawText));
    return { verdict };
  }
  const candidate = findFirstBalanced(rawText, arr);
  if (!candidate) {
    throw new Error("extractVerdicts: no balanced JSON array found in reply");
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(
      `extractVerdicts: candidate JSON array failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const verdicts = /** @type {unknown[]} */ (parsed).map((item, i) => {
    const claimId = item && typeof item === "object" ? /** @type {Record<string, unknown>} */ (item).claim_id : undefined;
    if (typeof claimId !== "string" || claimId.length === 0) {
      throw new Error(`extractVerdicts: element ${i} has no string "claim_id"`);
    }
    return { claim_id: claimId, ...toVerdict(item) };
  });
  return { verdicts };
}

/**
 * @param {Verdict} verdict
 * @param {string|null} candidate the object extractVerdict read
 * @returns {ClaimVerdict}
 */
function withClaimId(verdict, candidate) {
  const claimId = candidate ? JSON.parse(candidate).claim_id : undefined;
  return typeof claimId === "string" ? { claim_id: claimId, ...verdict } : verdict;
}
