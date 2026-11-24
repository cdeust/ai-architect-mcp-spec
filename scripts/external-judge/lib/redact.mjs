/**
 * Redaction — strip credentials from anything that might get logged.
 *
 * Precondition: `value` is a JSON-serializable object (headers map, request
 * options, error payload, etc.) or a string.
 * Postcondition: returns a deep-cloned value with credentials and endpoint
 * configuration masked. Known secrets are also masked in free-form text.
 *
 * Invariant: no code path in this module ever logs `config.apiKey` or an
 * "Authorization" header value verbatim — this is the single choke point
 * every debug-output call site must route through.
 */

const REDACTED = "***REDACTED***";
const SENSITIVE_KEYS = new Set(["apikey", "api_key", "authorization", "baseurl", "allowedorigins"]);

function literalPattern(apiKey, baseUrl) {
  const url = baseUrl && URL.canParse(baseUrl) ? new URL(baseUrl) : undefined;
  const literals = [apiKey, baseUrl, url?.href, url?.origin === "null" ? undefined : url?.origin]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!literals.length) return null;
  const escaped = literals.map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"), "g");
}

/**
 * @template T
 * @param {T} value
 * @param {{apiKey?: string, baseUrl?: string}} [context]
 * @returns {T}
 */
export function redact(value, { apiKey, baseUrl } = {}) {
  const sensitive = literalPattern(apiKey, baseUrl);
  function visit(current) {
    if (typeof current === "string") {
      const text = sensitive ? current.replace(sensitive, REDACTED) : current;
      return text.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);
    }
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, val]) => [
        key, SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : visit(val),
      ]));
    }
    return current;
  }
  return visit(value);
}
