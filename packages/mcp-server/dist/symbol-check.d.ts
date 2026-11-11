/**
 * Optional symbol-existence input of the two PRD validators (issue #118):
 * the host passes the symbol names it read from its code graph, and the
 * report gains the inline-code symbol references none of them resolve.
 */
import { z } from "zod";
import { type SymbolExistenceReport } from "@prd-gen/validation";
export declare const KnownSymbolsSchema: z.ZodOptional<z.ZodArray<z.ZodString>>;
/** The validation report, plus the symbol check when the host sent a graph. */
export declare function withSymbolCheck<T extends object>(report: T, content: string | readonly string[], knownSymbols: readonly string[] | undefined): T & {
    symbolExistence?: SymbolExistenceReport;
};
//# sourceMappingURL=symbol-check.d.ts.map