// The minutes of an hour-and-minute duration written in digits, for
// contradictory-requirement-rules.ts: two decimal digits of any script, read
// by their value.

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
export function isMinuteDigits(spelling: string): boolean {
  const digits = [...spelling];
  return digits.length === 2 && digits.every((d) => DECIMAL_DIGIT.test(d)) && digitValue(digits[0]!) <= 5;
}
