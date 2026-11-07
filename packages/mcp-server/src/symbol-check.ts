/**
 * Optional symbol-existence input of the two PRD validators (issue #118):
 * the host passes the symbol names it read from its code graph, and the
 * report gains the inline-code symbol references none of them resolve.
 */

import { z } from "zod";
import {
  checkSymbolExistence,
  type SymbolExistenceReport,
} from "@prd-gen/validation";

/**
 * Bounds on the host-sent graph: generous for a real codebase, and they keep
 * one call from holding the stdio server on an absurd input.
 * source: provisional heuristic (PR #174 review r4501819785).
 */
const MAX_KNOWN_SYMBOLS = 200_000;
const MAX_SYMBOL_LENGTH = 512;

export const KnownSymbolsSchema = z
  .array(z.string().max(MAX_SYMBOL_LENGTH))
  .max(MAX_KNOWN_SYMBOLS)
  .optional()
  .describe(
    "Optional symbol names from the host's code graph (plain, or qualified with ., ::, # or -> (read as .); a signature such as (email:), " +
      "generic arguments and trailing ?/! are ignored). When given, the report gains `symbolExistence` " +
      "{checkedSymbols, knownSymbols, unresolvedSymbols[]}: the code symbols named in inline code spans outside fenced " +
      "blocks that none of these resolve — each is either introduced by the PRD or fabricated. Not scored. " +
      "Checked spans: calls on a bare name or a receiver starting upper-case, ::/# paths, Upper.member. Skipped: " +
      "lower-case receivers, JS built-ins, std:: paths, # after anything but one PascalCase name (anchors), file names. " +
      "Rust relative roots (crate::, self::, super::, Self::) are dropped and the rest is checked; a non-call " +
      "left with one name (Self::CONST, crate::Foo) is not checked. " +
      "[] means an empty graph: " +
      "omit the field when the graph lookup failed.",
  );

/** The validation report, plus the symbol check when the host sent a graph. */
export function withSymbolCheck<T extends object>(
  report: T,
  content: string | readonly string[],
  knownSymbols: readonly string[] | undefined,
): T & { symbolExistence?: SymbolExistenceReport } {
  if (knownSymbols === undefined) return report;
  return { ...report, symbolExistence: checkSymbolExistence(content, knownSymbols) };
}
