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

/**
 * Match a secret in any per-character percent-encoding: each character may appear
 * raw or as its UTF-8 bytes in either hex case, and a space may also appear as `+`.
 * This covers `encodeURIComponent`, form encoding and over-encoding alike.
 */
function encodedPattern(secret) {
  return [...secret.toWellFormed()].map(char => {
    const bytes = [...new TextEncoder().encode(char)].map(byte => "%" + byte.toString(16).padStart(2, "0"));
    const encoded = bytes.join("").replace(/[a-f]/g, letter => `[${letter}${letter.toUpperCase()}]`);
    return `(?:${escapeLiteral(char)}|${encoded}${char === " " ? "|\\+" : ""})`;
  }).join("");
}

function literalPattern(apiKey, baseUrl) {
  // Each alternative has its literal length so overlapping secrets match longest first.
  const alternatives = [];
  function add(literal, pattern = escapeLiteral(literal)) {
    alternatives.push({ length: literal.length, pattern });
  }
  if (apiKey) {
    add(apiKey);
    add(apiKey, encodedPattern(apiKey));
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
        // The default port may be written or omitted; any other port is part of the literal.
        const port = authority.match(/^(.*):(\d+)$/s);
        const defaultPort = url.protocol === "https:" ? 443 : 80;
        const isDefault = !port || Number(port[2]) === defaultPort;
        const host = port && isDefault ? port[1] : authority;
        // Only the authority folds case. Preserve multi-character case mappings in raw IDNs.
        const prefix = escapeLiteral(host).replace(/\p{L}/gu, c =>
          `(?:${[...new Set([c, c.toLowerCase(), c.toUpperCase()])].join("|")})`);
        const path = form.slice(authority.length);
        let end = path.length;
        while (path[end - 1] === "/") end--;
        const stem = path.slice(0, end);
        for (const suffix of new Set([path, stem, stem + "/"])) {
          add(authority + suffix, prefix + (isDefault ? `(?::0*${defaultPort}(?!\\d))?` : "") + escapeLiteral(suffix));
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
