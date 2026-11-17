/**
 * Tolerant JSON-object extractor.
 *
 * Extract the first balanced JSON object from a text response. Tolerant to
 * markdown fences, prose preambles, and trailing commentary. Used wherever
 * we receive free-form agent output that should contain a structured object
 * (judge verdicts, clarification questions, etc.).
 *
 * Pure function — no I/O, no logging, no shared state. Throws on malformed
 * input rather than returning a fallback so callers must explicitly handle
 * the parse-failure case.
 *
 * Origin: previously lived in `@prd-gen/ecosystem-adapters/clients/subagent-client.ts`.
 * The Phase 3+4 cross-audit (code-reviewer H1) flagged orchestration handlers
 * importing this utility from the infrastructure layer as a §2.2 violation.
 * It belongs in core because it has no infrastructure dependency.
 *
 * source: cross-audit code-reviewer H1 (Phase 3+4, 2026-04).
 */

export function extractJsonObject(text: string): unknown {
  const stripped = stripFences(text);
  const start = stripped.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in response");
  return JSON.parse(stripped.slice(start, balancedEnd(stripped, start, "object") + 1));
}

/**
 * Extract the first JSON array or object that parses. Same tolerance as
 * extractJsonObject (fences, preamble, trailing prose). Used where a
 * response is a list (a batched judge verdict, issue #119) but a single
 * object stays a valid answer for a list of one. A bracketed span of the
 * prose that is balanced but not valid JSON (`Verdict for [AC-001]: {...}`)
 * is skipped and the scan goes on after it (review note 1 of #325), where
 * it used to fail the whole response. Each character is scanned once: a
 * skipped span is not re-read, and a bracket that never closes ends the
 * scan, so a reply of many unclosed brackets stays linear.
 *
 * postcondition: returns the first balanced candidate that parses; throws
 *                when none is found, with the failure of the last one tried.
 */
export function extractJsonValue(text: string): unknown {
  const stripped = stripFences(text);
  let lastError: Error | undefined;
  let start = nextOpening(stripped, 0);
  while (start !== -1) {
    const kind = stripped[start] === "[" ? "array" : "object";
    const end = balancedEnd(stripped, start, kind);
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch (err) {
      lastError = err as Error;
    }
    start = nextOpening(stripped, end + 1);
  }
  throw lastError ?? new Error("no JSON array or object found in response");
}

function nextOpening(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "[" || text[i] === "{") return i;
  }
  return -1;
}

function stripFences(text: string): string {
  return text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
}

/** Index of the bracket that closes the one at `start`; throws when none does. */
function balancedEnd(stripped: string, start: number, kind: "object" | "array"): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced JSON ${kind} in response`);
}
