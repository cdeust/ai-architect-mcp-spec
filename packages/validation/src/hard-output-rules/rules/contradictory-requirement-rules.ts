import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";
import { listedIds } from "./listed-ids.js";
import { phrases } from "./lexicon.js";
import { requirementDefinitions } from "./requirement-definitions.js";

// Document-Level Rule: Contradictory Requirements
//
// Two requirements that state the same thing with a different quantity
// ("the button reads "Copied" for two seconds" and "… for five seconds")
// cannot both hold: the set of requirements is not consistent
// (ISO/IEC/IEEE 29148:2018 §5.2.6, a set of requirements contains no
// conflicts). No test of the product can pass both.
//
// The rule reads each requirement definition (FR-n, NFR-n) with the block
// tree of requirement-definitions.ts and keeps its statement: the first cell
// of a table row, or the text of a list item, heading or bold line. It cuts
// the statement into words, numbers and marks, and puts a placeholder where
// each number stands (digits, or a number word of NUMBER_VALUES). Two
// statements contradict each other when their cut forms are the same, their
// numbers differ, and every number that differs is a quantity: followed by a
// unit of measure of the `quantityUnits` lexicon concept (seconds, MB, %,
// fois…; EN and FR). A number that names rather than measures ("Tier 1",
// "Step 2", `FR-001`) is not followed by such a unit, so two statements that
// differ there are about two different things and are not reported; a count
// noun ("users", "files") is not a unit, since it follows a naming number as
// often ("Tier 1 users"). Two spellings of the same value ("two" and "2",
// "1,000" and "1000") are the same number.
//
// It fires on the presence of a defect, so it is blocking, but not critical:
// it sees only a contradiction of identical wording, and the unit list is a
// heuristic. A finding costs the non-critical penalty and triggers no
// critical retry. Two statements of one cut form can measure a number
// differently (the minutes of `2 h 5` are not a quantity, those of `2 h 30`
// are), and a number that differs counts only where both measure it, so a
// first requirement that does not measure a number would hide every later
// contradiction there. A requirement is therefore compared with at most three
// earlier ones of its cut form: the first, the first that measures the same
// numbers, and the first that measures all it can (`references`). The cost
// grows with the number of requirements, not with its square: a third
// statement that differs from the second but agrees with the one it is
// compared with is not reported. Every later requirement is compared, so a
// second one that states the same value as a reported one is reported too.
//
// source: issue #118, seeded defect `contradiction` (FR-004 keeps the
// confirmation for five seconds, against FR-003's two), which the document
// check did not diagnose.

/**
 * The value of each number word: two spellings of one value are one number.
 * "one", "un" and "une" are read here, unlike in measurable-requirement-rules.ts:
 * a number is compared with the number at the same place in an otherwise
 * identical statement, so an article is compared with an article.
 */
const NUMBER_VALUES: ReadonlyMap<string, number> = new Map([
  // EN
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11],
  ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16],
  ["seventeen", 17], ["eighteen", 18], ["nineteen", 19], ["twenty", 20], ["thirty", 30],
  ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80],
  ["ninety", 90], ["hundred", 100], ["thousand", 1000], ["million", 1e6], ["billion", 1e9],
  // FR
  ["zéro", 0], ["un", 1], ["une", 1], ["deux", 2], ["trois", 3], ["quatre", 4], ["cinq", 5],
  ["sept", 7], ["huit", 8], ["neuf", 9], ["dix", 10], ["onze", 11], ["douze", 12],
  ["treize", 13], ["quatorze", 14], ["quinze", 15], ["seize", 16], ["vingt", 20],
  ["trente", 30], ["quarante", 40], ["cinquante", 50], ["soixante", 60], ["cent", 100],
  ["mille", 1000],
]);

/**
 * A number in digits (`2`, `1.5`, `1,5`) with the letters and digits glued
 * after it (`10MB`, `1b`, `2h30`), a word that starts with a letter and may
 * hold digits (`B2B`, `v2`, `H264`), or any other character but a space. A
 * word is one token, so the digit inside `B2B` is not a number and its `B` is
 * not a unit; a glued run is split by `splitGlued`. Each alternative ends
 * where its character class ends and none can fail after it started, so the
 * scan is linear.
 * source: review 1 of #319, note 3 (`Tier 1 B2B customers` read 1 as a
 * quantity of bytes).
 */
const TOKEN = /\p{N}+(?:[.,]\p{N}+)*[\p{L}\p{N}]*|\p{L}[\p{L}\p{N}]*|[^\s\p{L}\p{N}]/gu;

const DIGITS = /^\p{N}/u;

/**
 * The runs of a token that starts with a digit: its leading number, then
 * letters and digits by turns (`2h30` is `2`, `h`, `30`). The token holds no
 * separator after its first letter, so the runs alternate.
 */
const GLUED_RUNS = /\p{N}+(?:[.,]\p{N}+)*|\p{L}+/gu;

/**
 * The units read glued to a number although they are one letter: `5s`, `3h`.
 * A glued `b` is left out: `Phase 1b`, `Step 2b` name a sub-step more often
 * than `1b` writes a byte or a bit, which a PRD writes `1 B` or `1 KB`.
 * Glued units of two letters or more (`10MB`, `200ms`) are all read.
 * source: review 1 of #319, note 3.
 */
const GLUED_ONE_LETTER_UNITS: ReadonlySet<string> = new Set(["s", "h"]);

/** A token that starts with a digit, read as its numbers and what is glued after each. */
export interface GluedToken {
  /** The numbers, in order, as the token writes them. */
  readonly numbers: readonly string[];
  /**
   * What is glued after each number: a unit in its singular form, another
   * word lowercase (only after a later number: `1h30m`), null when nothing is.
   */
  readonly after: readonly (string | null)[];
}

/**
 * The units of an hour, singular, that a number of minutes can follow
 * (`2h30`, `2 h 30`, `2 heures 30`).
 */
const HOUR_UNITS: ReadonlySet<string> = new Set(["h", "hr", "hour", "heure"]);

/** A decimal digit of any script: `3`, `３` (fullwidth), `٣` (Arabic-Indic). */
const DECIMAL_DIGIT = /^\p{Nd}$/u;

/**
 * precondition: `digit` is one decimal digit (DECIMAL_DIGIT).
 * postcondition: its value, 0 to 9. Unicode encodes the decimal digits of each
 * script as one contiguous run from 0 to 9, and adjacent runs (the five of
 * the mathematical digits) are whole runs of ten, so the value is the distance
 * from the start of the run, modulo 10. At most 49 steps back.
 */
function digitValue(digit: string): number {
  const at = digit.codePointAt(0)!;
  let start = at;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start--;
  return (at - start) % 10;
}

/**
 * The minutes of an hour-and-minute duration: two decimal digits from 00
 * to 59, in any script (`2h30`, `2h05`, `2 h 30`, `２h３０`). `2h75` and
 * `2 h 60` count no minutes.
 * source: review 1 of #330, note 2 (any two digits up to 99 were minutes, so
 * `2 h 60` against `2 h 75` was reported and `2 hours sixty` against
 * `2 hours seventy` was not); review 1 of #331, note 3 (`/^[0-5][0-9]$/`
 * read only ASCII digits, so `２h３０` became a word).
 */
function isMinuteDigits(spelling: string): boolean {
  const digits = [...spelling];
  return digits.length === 2 && digits.every((d) => DECIMAL_DIGIT.test(d)) && digitValue(digits[0]!) <= 5;
}

/** What may follow the minutes of a glued duration: nothing, `m`, or a unit of a minute. */
function isGluedMinuteUnit(letters: string): boolean {
  const unit = unitOf(letters);
  return letters.toLowerCase() === "m" || unit === "min" || unit === "minute";
}

/**
 * precondition: `token` starts with a digit.
 * postcondition: the numbers of the token and what is glued after each when
 * the token is a number alone (`7`), a number and a unit (`10MB`, `5s`), or a
 * duration in hours and minutes: a unit of an hour, then two digits from 00
 * to 59, then nothing, `m` or a unit of a minute (`2h30`, `10h30`, `1h30m`,
 * `1h30min`);
 * null otherwise, so the token is a word and names something: letters that
 * are not a unit (`1a`, `2nd`, `3D`), a one-letter unit not read glued
 * (`1b`, see GLUED_ONE_LETTER_UNITS), or a later number that is not the
 * minutes of an hour (`2024H1`, `2025S1`, `4s2p`, `1b30`, `2h5`, `2h75`). The `m`
 * after the minutes is kept lowercase: the lexicon does not list it as a
 * unit. Linear in the length of the token.
 * source: review 1 of #320, note 2 (`2h30` read as a word since #320);
 * review 1 of #321, note 2 (any later number was read, so `2024H1` against
 * `2024H2` was reported, where it had been a word).
 */
export function splitGlued(token: string): GluedToken | null {
  const runs = token.match(GLUED_RUNS)!;
  if (runs.length === 1) return { numbers: [runs[0]!], after: [null] };
  const unit = unitOf(runs[1]!);
  if (unit === null || (unit.length === 1 && !GLUED_ONE_LETTER_UNITS.has(unit))) return null;
  if (runs.length === 2) return { numbers: [runs[0]!], after: [unit] };
  if (!HOUR_UNITS.has(unit) || runs.length > 4 || !isMinuteDigits(runs[2]!)) return null;
  const minuteUnit = runs[3];
  if (minuteUnit === undefined) return { numbers: [runs[0]!, runs[2]!], after: [unit, null] };
  if (!isGluedMinuteUnit(minuteUnit)) return null;
  return { numbers: [runs[0]!, runs[2]!], after: [unit, unitOf(minuteUnit) ?? minuteUnit.toLowerCase()] };
}

/** The units of the `quantityUnits` concept, lowercase. */
const UNITS: ReadonlySet<string> = new Set(phrases("quantityUnits"));

/** Marks a number in a cut form; not a character a statement can hold as a token. */
const NUMBER_SLOT = "\u0000";

/**
 * The unit a token names, in its singular form, else null. A unit is listed
 * in the singular; a plural is read by its final "s" removed ("seconds",
 * "secondes"), unless the token is itself listed ("ms", "mois", "fois").
 */
export function unitOf(token: string): string | null {
  const word = token.toLowerCase();
  if (UNITS.has(word)) return word;
  if (word.length > 2 && word.endsWith("s") && UNITS.has(word.slice(0, -1))) return word.slice(0, -1);
  return null;
}

/**
 * The value of a number written in digits, as a string. A separator followed
 * by exactly three digits, when every separator is the same character and is
 * followed by three digits, groups thousands: `1,000`, `1,000,000`,
 * `1.000.000`. With two kinds of separator, the last one is the decimal mark
 * (`1,000.5`, `1.000,5`). Any other separator is the decimal mark (`1,5`,
 * `1.5`, `2.25`). A group of thousands never follows a leading `0`, so
 * `0,250` and `0,001` read as decimals (0.25, 0.001), and a form with two
 * kinds of separator after a leading `0` (`0,250.5`, `0.250,5`), whose first
 * separator could only group thousands, does not read as a number. A form
 * that does not read as a number (`1.2.3`) is its own value, its digits as
 * written, so two different forms never read as equal. `1,500` stays 1500: it may be a
 * French 1.5, which the statement's language does not settle.
 * source: review 1 of #318, note 1 (only the first comma was replaced, so
 * `1,000` read as 1 and `1,000,000` as NaN, equal to any other NaN); review 1
 * of #319, note 2 (`0,250` read as 250); review 1 of #320, note 1 (`0,250.5`
 * read as 250.5).
 */
export function digitsValue(token: string): string {
  const separators = token.match(/[.,]/gu) ?? [];
  const groups = token.split(/[.,]/u);
  const kinds = new Set(separators);
  const leadingZero = groups[0]!.startsWith("0");
  let normalized: string;
  if (kinds.size === 2) {
    if (leadingZero) return token;
    const decimal = separators[separators.length - 1]!;
    const at = token.lastIndexOf(decimal);
    normalized = `${token.slice(0, at).replace(/[.,]/gu, "")}.${token.slice(at + 1)}`;
  } else if (separators.length > 0 && !leadingZero && groups.slice(1).every((g) => g.length === 3) && (separators.length > 1 || separators[0] === ",")) {
    normalized = groups.join("");
  } else if (separators.length === 1) {
    normalized = groups.join(".");
  } else {
    normalized = token;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? String(value) : token;
}

/** The longest spelling a finding quotes; a longer one is cut and ends with "…". */
const MAX_QUOTED_CHARS = 24;

function quoted(spelling: string): string {
  return spelling.length > MAX_QUOTED_CHARS ? `${spelling.slice(0, MAX_QUOTED_CHARS)}…` : spelling;
}

/** A statement cut into its form, with a slot for each number, and the numbers. */
export interface CutStatement {
  /** The words and marks, lowercase, with NUMBER_SLOT for each number and units in the singular. */
  readonly form: string;
  /** The value of each number, in order. */
  readonly values: readonly string[];
  /** The spelling of each number, in order, as the statement writes it. */
  readonly spellings: readonly string[];
  /** For each number, whether it is a quantity (`isMeasured`). */
  readonly measured: readonly boolean[];
  /** For each number, whether a statement of the form can measure it (`isMeasurable`). */
  readonly measurable: readonly boolean[];
}

/**
 * The statement of a definition text: the first cell of a table row (the
 * other cells are joined after " | "), without the colon or dash that
 * follows the identifier of a list item or a heading.
 */
function statementOf(text: string): string {
  return text.split(" | ")[0]!.replace(/^[\s:–—-]+/u, "");
}

/**
 * What may follow the minutes of a spaced duration in a cut form: nothing, a
 * mark (`.`, `,`, `)`), or `m`. A word is not: in `1 hour 10 users` the `10`
 * counts users, not minutes. A unit of a minute is read by `isMeasured`'s
 * first test, like any unit.
 */
function endsSpacedMinutes(next: string | undefined): boolean {
  if (next === undefined || next === "m") return true;
  return next !== NUMBER_SLOT && !/^[\p{L}\p{N}]/u.test(next);
}

/**
 * A number word that can count the minutes of an hour: its value is between
 * 10 and 59, the minutes isMinuteDigits reads that are written without a
 * leading 0, so a word and its digits read alike (`two hours five` is not
 * minutes, as `2 h 5` is not; `sixty` is not, as `2 h 60` is not).
 * `deux heures cinq` is left out with `2 h 5`.
 * source: review 1 of #329, note 3 (`2 hours five` against `2 hours seven`
 * was reported, `2 h 5` against `2 h 7` was not); review 1 of #330, note 2.
 */
function isMinuteWord(spelling: string): boolean {
  const value = NUMBER_VALUES.get(spelling.toLowerCase());
  return value !== undefined && value >= 10 && value < 60;
}

/**
 * Whether the number at `slot` of a cut form, spelled `spelling`, is a
 * quantity: a unit follows it (`5 s`, `10 mb`), or it counts the minutes of
 * a spaced duration. Spaced minutes follow a number and a unit of an hour,
 * are two digits from 00 to 59 (isMinuteDigits, the bound `splitGlued` puts on
 * the digits of glued minutes) or a number word from 10 to 59, and are
 * followed by nothing, a mark or `m` (`2 h 30`, `1 h 30 m`, `deux heures
 * trente`): that bound on what follows is `endsSpacedMinutes`, not
 * `splitGlued`. The minutes of a glued duration `splitGlued` accepted are
 * measured by `cutStatement` whatever token follows (`2h30 before`, `2h30
 * 45`). A glued and a spaced duration therefore measure their minutes alike
 * only when the minutes have two digits from 00 to 59 and nothing, a mark or
 * `m` follows them: neither a word (`2h30 before` measures its `30`,
 * `2 h 30 before` does not) nor a number (`2h30 45` measures its `30`,
 * `2 h 30 45` does not). With one digit, only a unit of a minute makes the
 * spaced number a quantity (`2 h 5 min`); `2 h 5` is not, and a glued `2h5`
 * or `2h5min` is a word.
 * source: review 1 of #321, note 1 (`2 h 30` then `2h45` was reported, but
 * `2h30` then `2 h 45` was not); review 2 of #322, notes 1 and 2 (any number
 * after a spaced hour was read as minutes, so `Within 1 hour 10 users …`
 * against `… 50 users …` was reported, and `2 h 5` against `2 h 7` was,
 * where `2h5` against `2h7` was not); Codex review of #329, P2 (`2h30
 * before stopping` lost the minutes `splitGlued` had read); review 1 of
 * #330, note 3 (this docstring gave `splitGlued` the bound on what follows
 * the minutes, and left out a number that follows them).
 */
function isMeasured(form: readonly string[], slot: number, spelling: string): boolean {
  const next = form[slot + 1];
  if (next !== undefined && UNITS.has(next)) return true;
  if (slot < 2 || !HOUR_UNITS.has(form[slot - 1]!) || form[slot - 2] !== NUMBER_SLOT) return false;
  return (isMinuteDigits(spelling) || isMinuteWord(spelling)) && endsSpacedMinutes(next);
}

/**
 * Whether the number at `slot` of a cut form can be a quantity in some
 * statement of that form: a unit follows it, or it stands where the minutes
 * of a duration stand (after a number and a unit of an hour). Every number
 * `isMeasured` or `splitGlued` measures is measurable; the converse depends on
 * the spelling (`2 h 5`), on the glue (`2h30 before`) and on what follows.
 * The answer depends on the form only, so every statement of a form has the
 * same measurable numbers.
 */
function isMeasurable(form: readonly string[], slot: number): boolean {
  const next = form[slot + 1];
  if (next !== undefined && UNITS.has(next)) return true;
  return slot >= 2 && HOUR_UNITS.has(form[slot - 1]!) && form[slot - 2] === NUMBER_SLOT;
}

/** precondition: none. postcondition: the cut form of the statement of `text`, linear in its length. */
export function cutStatement(text: string): CutStatement {
  const tokens = statementOf(text).match(TOKEN) ?? [];
  const form: string[] = [];
  const values: string[] = [];
  const spellings: string[] = [];
  const slots: number[] = [];
  // The numbers `splitGlued` read as the minutes of a glued duration: a quantity whatever follows the token.
  const gluedMinutes = new Set<number>();
  for (const token of tokens) {
    if (DIGITS.test(token)) {
      const glued = splitGlued(token);
      if (glued === null) {
        form.push(token.toLowerCase());
        continue;
      }
      for (let k = 0; k < glued.numbers.length; k++) {
        if (k > 0) gluedMinutes.add(slots.length);
        slots.push(form.length);
        form.push(NUMBER_SLOT);
        values.push(digitsValue(glued.numbers[k]!));
        spellings.push(glued.numbers[k]!);
        const after = glued.after[k] ?? null;
        // `10MB` and `10 MB`, `2h30` and `2 h 30`, are one form.
        if (after !== null) form.push(after);
      }
      continue;
    }
    const word = NUMBER_VALUES.get(token.toLowerCase());
    if (word === undefined) {
      form.push(unitOf(token) ?? token.toLowerCase());
      continue;
    }
    slots.push(form.length);
    form.push(NUMBER_SLOT);
    values.push(String(word));
    spellings.push(token);
  }
  const measured = slots.map((slot, i) => gluedMinutes.has(i) || isMeasured(form, slot, spellings[i]!));
  const measurable = slots.map((slot) => isMeasurable(form, slot));
  return { form: form.join(" "), values, spellings, measured, measurable };
}

/**
 * The index of the first number at which `a` and `b`, of one cut form,
 * contradict each other, else -1: their values differ somewhere, and every
 * number that differs is a quantity in both statements. Two statements of one
 * form can measure a number differently (`2 h 5` and `2 h 30`, or a glued
 * `2h30 before` and a spaced `2 h 30 before`), so both are read and the
 * result does not depend on which one comes first.
 * source: Codex review of #329, P2 (`2 h 5` then `2 h 30` was reported, the
 * reverse order was not).
 */
export function contradictionAt(a: CutStatement, b: CutStatement): number {
  let first = -1;
  for (let i = 0; i < a.values.length; i++) {
    if (a.values[i] === b.values[i]) continue;
    if (!a.measured[i] || !b.measured[i]) return -1;
    if (first === -1) first = i;
  }
  return first;
}

/** A requirement a later one of its cut form is compared with. */
interface Reference {
  readonly id: string;
  readonly cut: CutStatement;
}

/** The requirements of one cut form that later ones are compared with. */
interface FormReferences {
  /** The first requirement of the form. */
  readonly first: Reference;
  /** The first requirement of the form for each set of measured numbers (`measuredKey`). */
  readonly byMeasured: Map<string, Reference>;
}

/** A set of numbers of a cut statement, as a key: `1` for a number in the set, `0` otherwise. */
function keyOf(set: readonly boolean[]): string {
  return set.map((m) => (m ? "1" : "0")).join("");
}

/** The numbers a cut statement measures, as a key. */
function measuredKey(cut: CutStatement): string {
  return keyOf(cut.measured);
}

/**
 * precondition: `refs` holds the requirements of the cut form of `cut`.
 * postcondition: the earlier requirements `cut` is compared with, in order,
 * each once: the first of the form, the first that measures the same numbers,
 * and the first that measures every number the form can measure
 * (`isMeasurable`): a number that names (`Tier 1`) is measured by no
 * statement of the form, so it does not keep that reference from existing.
 * Only the minutes of a duration are measured in one statement of a form and
 * not in another, so a form with one duration holds two sets of measured
 * numbers, and these references are the first of each; a form with several
 * durations can hold more sets than three, and a requirement is then not
 * compared with the first of the others. Three references at most, so the
 * cost of the rule stays linear.
 * source: review 1 of #330, note 1 (`2 h 5`, then `2 h 30`, then `2 h 45`
 * reported nothing: the first did not measure its minutes, and every later
 * requirement was compared with it only); review 1 of #331, note 2 (the key
 * of every number could not exist in a form with a naming number, so `Tier 1
 * … 2 h 5`, `… 2 h 30`, `… 2 h 45` reported nothing).
 */
function references(refs: FormReferences, cut: CutStatement): Reference[] {
  const all = keyOf(cut.measurable);
  const found = [refs.first, refs.byMeasured.get(measuredKey(cut)), refs.byMeasured.get(all)];
  const unique: Reference[] = [];
  for (const ref of found) if (ref !== undefined && !unique.includes(ref)) unique.push(ref);
  return unique;
}

export function checkDocumentContradictoryRequirements(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const byForm = new Map<string, FormReferences>();
  const flagged = new Set<string>();
  const named: string[] = [];
  for (const section of sections) {
    // Each section is parsed on its own, as the other document rules read it.
    for (const { id, text } of requirementDefinitions(section.content)) {
      const cut = cutStatement(text);
      if (cut.values.length === 0) continue;
      const key = measuredKey(cut);
      const refs = byForm.get(cut.form);
      if (refs === undefined) {
        const first = { id, cut };
        byForm.set(cut.form, { first, byMeasured: new Map([[key, first]]) });
        continue;
      }
      const candidates = references(refs, cut);
      if (!refs.byMeasured.has(key)) refs.byMeasured.set(key, { id, cut });
      // A reused identifier is duplicate_requirement_ids' finding, not a contradiction.
      // source: review 1 of #331, note 1 (FR-001, FR-002, then FR-001 again was
      // reported against FR-002 once the first of the form was no longer the
      // only reference).
      if (refs.first.id === id || flagged.has(id)) continue;
      for (const ref of candidates) {
        if (ref.id === id) continue;
        const at = contradictionAt(cut, ref.cut);
        if (at === -1) continue;
        flagged.add(id);
        named.push(`${id} ("${quoted(cut.spellings[at]!)}", against ${ref.id}: "${quoted(ref.cut.spellings[at]!)}")`);
        break;
      }
    }
  }
  if (flagged.size === 0) return [];
  const names = listedIds(named);
  return [
    makeViolation(
      "contradictory_requirements",
      null,
      `${flagged.size} requirement(s) state a quantity an earlier requirement states differently: ${names}`,
      `Contradictory: ${names}`,
    ),
  ];
}
