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
  return parseBalanced(stripped, start, "object");
}

/**
 * Extract the first balanced JSON array or object, whichever opens first.
 * Same tolerance as extractJsonObject (fences, preamble, trailing prose).
 * Used where a response is a list (a batched judge verdict, issue #119) but
 * a single object stays a valid answer for a list of one.
 *
 * postcondition: returns the parsed array or object; throws when neither is
 *                found or the first one is unbalanced or malformed.
 */
export function extractJsonValue(text: string): unknown {
  const stripped = stripFences(text);
  const obj = stripped.indexOf("{");
  const arr = stripped.indexOf("[");
  if (obj === -1 && arr === -1) throw new Error("no JSON array or object found in response");
  const start = arr !== -1 && (obj === -1 || arr < obj) ? arr : obj;
  return parseBalanced(stripped, start, stripped[start] === "[" ? "array" : "object");
}

function stripFences(text: string): string {
  return text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
}

function parseBalanced(stripped: string, start: number, kind: "object" | "array"): unknown {
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
      if (depth === 0) {
        return JSON.parse(stripped.slice(start, i + 1));
      }
    }
  }
  throw new Error(`unbalanced JSON ${kind} in response`);
}
