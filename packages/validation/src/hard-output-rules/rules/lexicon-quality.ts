import type { LexiconConcept } from "./lexicon-types.js";

/**
 * Bilingual concept groups consumed by senior-quality-rules.ts,
 * `unboundedQualityTerms` by measurable-requirement-rules.ts,
 * `untestableOutcomeTerms` by testable-acceptance-criteria-rules.ts, and
 * `quantityUnits` by contradictory-requirement-rules.ts.
 */
export const QUALITY_LEXICON = {
  /**
   * Terms that state a quality without a bound. Matched as whole words
   * (a hyphen counts as part of a word, so "fast-track" is not "fast").
   * source: ISO/IEC/IEEE 29148:2018 §5.2.7, unbounded or ambiguous terms
   * (subjective language, ambiguous adjectives and adverbs, loopholes).
   * Terms of art that name a bounded property ("responsive layout",
   * "best-effort", "reliable delivery") are left out.
   */
  unboundedQualityTerms: {
    en: [
      "fast",
      "quick",
      "quickly",
      "rapid",
      "rapidly",
      "user-friendly",
      "user friendly",
      "easy",
      "easily",
      "intuitive",
      "intuitively",
      "seamless",
      "seamlessly",
      "efficient",
      "efficiently",
      "robust",
      "adequate",
      "adequately",
      "as appropriate",
      "if possible",
      "as needed",
      "minimal",
      "significant",
      "significantly",
      "optimal",
      "optimally",
      "performant",
      "smooth",
      "smoothly",
    ],
    fr: [
      "rapide",
      "rapidement",
      "convivial",
      "conviviale",
      "facile",
      "facilement",
      "intuitif",
      "intuitive",
      "intuitivement",
      "fluide",
      "efficace",
      "efficacement",
      "robuste",
      "adéquat",
      "adéquate",
      "si possible",
      "au besoin",
      "optimal",
      "optimale",
      "performant",
      "performante",
      "significatif",
      "significative",
    ],
  },
  /**
   * Verbs and adjectives that state how a person feels about the product
   * ("Readers love the confirmation."). An acceptance criterion made of one
   * names no behaviour a test can observe: it is not verifiable. Matched as
   * whole words, like `unboundedQualityTerms`. Words with an ordinary
   * testable sense in a criterion are left out: "like" (a preposition),
   * "prefer" (`prefers-reduced-motion`), "satisfied" (a satisfied
   * condition), "happy" (the happy path), "feel" (look and feel).
   * source: ISO/IEC/IEEE 29148:2018 §5.2.5, a requirement is verifiable;
   * §5.2.7, subjective language is to be avoided.
   */
  untestableOutcomeTerms: {
    en: [
      "love",
      "loves",
      "loved",
      "enjoy",
      "enjoys",
      "enjoyed",
      "delighted",
      "appreciate",
      "appreciates",
      "appreciated",
      "pleased",
      "frustrated",
      "annoyed",
    ],
    fr: [
      "adore",
      "adorent",
      "aime",
      "aiment",
      "apprécie",
      "apprécient",
      "ravi",
      "ravie",
      "ravis",
      "ravies",
      "frustré",
      "frustrés",
      "agacé",
      "agacés",
    ],
  },
  /**
   * Units of a quantity, in the singular (a plural is read by its final "s"
   * removed). A number followed by one measures something ("two seconds",
   * "5 MB", "3 fois"); a number followed by anything else names something
   * ("Tier 1", "Step 2"). Matched as a whole token, lowercase, in a statement
   * of either language.
   *
   * Only units of measure are listed. A count noun (user, file, step, row,
   * result…) follows a number that names as often as one that counts: in
   * "Tier 1 users can export CSV." the 1 names a tier. A word that is also a
   * verb is left out too ("time", "attempt", "click", "request": "Step 2
   * times out"), and so is a unit of one language that is a common word of
   * the other ("to", "go", "an", "o" for terabyte, gigabyte, year and byte
   * read as English words): the statement's language is not known. Two
   * requirements that differ in a count ("10 users" against "50 users") are
   * therefore not reported; the rule is a heuristic and keeps its precision.
   * source: issue #118, seeded defect `contradiction`; review 1 of #318,
   * note 1.
   */
  quantityUnits: {
    en: [
      "%", "percent", "ms", "millisecond", "s", "sec", "second", "min", "minute", "h", "hr",
      "hour", "day", "week", "month", "year", "b", "byte", "kb", "mb", "gb", "tb", "kib", "mib",
      "gib", "bit", "kbps", "mbps", "px", "pt", "em", "rem", "fps", "rps", "qps",
    ],
    fr: [
      "pourcent", "milliseconde", "seconde", "heure", "jour", "semaine", "mois", "ans",
      "année", "octet", "ko", "mo", "fois",
    ],
  },
  namedConstantSignals: {
    en: [
      "named constant",
      "named variable",
      "const ",
      "static let",
      "static final",
      "companion object",
      "no magic number",
      "extract constant",
      "configuration value",
    ],
    fr: [
      "constante nommée",
      "constantes nommées",
      "variable nommée",
      "aucun nombre magique",
      "extraire en constante",
      "valeur de configuration",
    ],
  },
  namingConventionSignals: {
    en: [
      "naming convention",
      "naming standard",
      "naming rule",
      "camelcase",
      "camel case",
      "snake_case",
      "snake case",
      "pascalcase",
      "pascal case",
      "kebab-case",
      "descriptive name",
      "self-documenting",
      "meaningful name",
      "no abbreviation",
      "full word",
      "consistent naming",
    ],
    fr: [
      "convention de nommage",
      "conventions de nommage",
      "règle de nommage",
      "nom descriptif",
      "nom explicite",
      "nommage cohérent",
      "pas d'abréviation",
    ],
  },
  defensiveCodingSignals: {
    en: [
      "guard",
      "precondition",
      "require",
      "assert",
      "null safe",
      "null check",
      "nil check",
      "optional",
      "non-null",
      "nonnull",
      "notnull",
      "bounds check",
      "range check",
      "defensive",
      "fail fast",
      "early return",
      "validation",
      "contract",
      "invariant",
    ],
    fr: [
      "garde",
      "précondition",
      "vérification de nullité",
      "sécurité vis-à-vis des valeurs nulles",
      "vérification des limites",
      "vérification de plage",
      "défensif",
      "échec rapide",
      "retour anticipé",
      "validation",
      "contrat",
      "invariant",
    ],
  },
  apiContractTopic: {
    en: ["api contract", "endpoint", "api", "public interface"],
    fr: ["contrat d'api", "point de terminaison", "api", "interface publique"],
  },
  apiContractDocumentationSignals: {
    en: [
      "request schema",
      "response schema",
      "api contract",
      "openapi",
      "swagger",
      "api spec",
      "endpoint spec",
      "request body",
      "response body",
      "status code",
      "content-type",
      "accept header",
      "api documentation",
      "typed request",
      "typed response",
    ],
    fr: [
      "schéma de requête",
      "schéma de réponse",
      "contrat d'api",
      "spécification d'api",
      "spécification de point de terminaison",
      "corps de la requête",
      "corps de la réponse",
      "code de statut",
      "documentation de l'api",
      "requête typée",
      "réponse typée",
    ],
  },
  deprecationTopic: {
    en: ["deprecation", "api version", "breaking change", "public api"],
    fr: [
      "dépréciation",
      "version de l'api",
      "changement incompatible",
      "api publique",
    ],
  },
  deprecationStrategySignals: {
    en: [
      "deprecat",
      "sunset",
      "breaking change",
      "migration path",
      "backward compat",
      "backwards compat",
      "version",
      "api version",
      "v1",
      "v2",
      "changelog",
      "upgrade guide",
      "migration guide",
    ],
    fr: [
      "obsolèt",
      "dépréciat",
      "fin de vie",
      "changement incompatible",
      "chemin de migration",
      "rétrocompatibilité",
      "version",
      "version de l'api",
      "journal des modifications",
      "guide de mise à niveau",
      "guide de migration",
    ],
  },
} as const satisfies Record<string, LexiconConcept>;
