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

export const KnownSymbolsSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Optional symbol names from the host's code graph (plain, or qualified with ., :: or #). " +
      "When given, the report gains `symbolExistence`: the code symbols named in inline code spans " +
      "that none of these resolve — each is either introduced by the PRD or fabricated. Not scored.",
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
