// Validation engine — HOR rules (HardOutputRuleSchema) + audit flags + cross-ref graph

export {
  validateSection,
  validateDocument,
  rulesForSection,
  DOCUMENT_LEVEL_RULES,
  type DocumentLevelRule,
} from "./hard-output-rules/index.js";
export { validateDefineReadiness } from "./hard-output-rules/rules/define-readiness.js";
export { validateCrossReferences } from "./cross-ref-validator.js";
export {
  checkSymbolExistence,
  symbolFromSpan,
  type SymbolExistenceReport,
  type UnresolvedSymbol,
} from "./symbol-existence.js";
export {
  AuditFlagEngine,
  type AuditFinding,
  type AuditFlagReport,
  type AuditRule,
  type AuditRuleFamily,
} from "./audit-flags/index.js";
export { projectDefineDocument } from "./define-handoff.js";
