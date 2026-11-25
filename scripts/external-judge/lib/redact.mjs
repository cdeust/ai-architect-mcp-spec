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
const SENSITIVE_KEYS = new Set([
  "apikey", "api_key", "authorization", "baseurl", "base_url", "allowedorigins", "allowed_origins",
]);

function escapeLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalPattern(apiKey, baseUrl) {
  // Each alternative has its literal length so overlapping secrets match longest first.
  const alternatives = [];
  function add(literal, pattern = escapeLiteral(literal)) {
    alternatives.push({ length: literal.length, pattern });
  }
  if (apiKey) {
    add(apiKey);
    add(encodeURIComponent(apiKey.toWellFormed()));
  }
  if (baseUrl) {
    const url = URL.canParse(baseUrl) ? new URL(baseUrl) : undefined;
    if (url && url.origin !== "null") {
      for (const form of [baseUrl, url.href, url.origin]) {
        const authority = form.match(/^https?:\/\/[^/?#]+/i)?.[0];
        if (!authority) {
          add(form);
          continue;
        }
        // Only the authority folds case. Preserve multi-character case mappings in raw IDNs.
        const prefix = escapeLiteral(authority).replace(/\p{L}/gu, c =>
          `(?:${[...new Set([c, c.toLowerCase(), c.toUpperCase()])].join("|")})`);
        const path = form.slice(authority.length);
        let end = path.length;
        while (path[end - 1] === "/") end--;
        const stem = path.slice(0, end);
        for (const suffix of new Set([path, stem, stem + "/"])) {
          add(authority + suffix, prefix + escapeLiteral(suffix));
        }
      }
    } else {
      add(baseUrl);
    }
  }
  alternatives.sort((a, b) => b.length - a.length);
  return alternatives.length ? new RegExp(alternatives.map(a => a.pattern).join("|"), "g") : null;
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
