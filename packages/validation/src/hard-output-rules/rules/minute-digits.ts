// The decimal digits of any script, for contradictory-requirement-rules.ts:
// the minutes of an hour-and-minute duration (two digits, read by their
// value), the ASCII spelling of the digits of a number or a word, and the
// folded spelling of a word or a unit (letters of any width, lowercase).

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
 * `spelling` with each decimal digit of any script written as its ASCII
 * digit (`２h３０` → `2h30`, `2h٣٠` → `2h30`); every other character is kept.
 * `Number` reads only ASCII digits, so a value is read from this spelling.
 * source: review 1 of #332, note 1 (`２h３０` against `2h30` was reported:
 * the digits kept their own script as their value).
 */
export function asciiDigits(spelling: string): string {
  let out = "";
  for (const ch of spelling) out += DECIMAL_DIGIT.test(ch) ? String(digitValue(ch)) : ch;
  return out;
}

/** A string that holds a decimal digit of any script. */
const HOLDS_DIGIT = /\p{Nd}/u;

/**
 * `token` folded as a word or a unit is read: each character in its
 * compatibility form (NFKC), lowercase, except a character that is not a
 * decimal digit and whose compatibility form holds one. NFKC writes a
 * fullwidth letter as its letter (`Ｈ` → `H`, `ｓ` → `s`), a fullwidth or
 * mathematical digit as its ASCII digit, and a composed form as one (`ﬁ` →
 * `fi`), so `２０２４Ｈ１` and `2024H1`, or `５ ｓ` and `5 s`, read alike. A
 * superscript, a subscript, a circled or a fraction form of a digit (`²`,
 * `₂`, `②`, `½`) is kept: its compatibility form is a digit, but it writes
 * another number than that digit in a word (`x10²` is a hundred, `x102` is
 * not), so `x10²` and `x102` stay two words; one of a letter (`ⁿ`, `ₐ`,
 * `Ⓗ`) holds no digit and is folded to its letter. It leaves the digits of a script with
 * its own shapes (`٣`) as they are: `asciiDigits` writes those. The kept
 * characters are left as they are, and the others recomposed (NFC), as NFKC
 * of the whole token would. Linear in the length.
 * source: review 1 of #334, note 2 (a fullwidth letter was only lowercased,
 * `Ｈ` to `ｈ`, so the word `２０２４Ｈ１` was `2024ｈ1` where the word `2024H1`
 * is `2024h1`: `Release ２０２４Ｈ１ waits 2 s` and `Release 2024H1 waits 5 s` were
 * two forms; both tokens were words either way, `splitGlued` rejecting
 * `2024H1` at its one-digit `1` and `２０２４Ｈ１` at its `ｈ`, no unit for
 * `unitOf`, so the `ｈ` the word kept was the only cause); review 1 of #335,
 * note 2 (NFKC of the whole
 * token wrote `²` as `2`, so `Grid x10² waits 2 s` and `Grid x102 waits 5 s`
 * were one form and were reported); review 1 of #336, notes 1 and 3 (the
 * reason `２０２４Ｈ１` was rejected; no test failed without the NFC
 * recomposition: two conjoining jamo, `\u1100\u1161`, are one syllable `가`);
 * review 1 of #337, notes 1 and 2 (the rejection by `splitGlued` was given as
 * the cause of the two forms; a form of a letter was said to be kept);
 * review 1 of #338, note 2 (`2024H1` was said to be the word `2024h`).
 */
export function folded(token: string): string {
  let out = "";
  for (const ch of token) {
    const compatible = ch.normalize("NFKC");
    out += !DECIMAL_DIGIT.test(ch) && HOLDS_DIGIT.test(compatible) ? ch : compatible;
  }
  return out.normalize("NFC").toLowerCase();
}

/**
 * A word of a cut form: folded (`folded`), with each decimal digit of any
 * script written as its ASCII digit, so `２０２４Ｈ１`, `٢٠٢٤H1` and `2024H1`
 * are one word, as `２h３０` and `2h30` are one duration
 * (contradictory-requirement-rules.ts, digitsValue).
 * source: review 1 of #333, note 2 (a word or a rejected glued token kept the
 * script of its digits, so `Release ２０２４H1 waits 2 s` and `Release 2024H1
 * waits 5 s` were two forms and were not compared); review 1 of #334, note 2
 * (its letters were not folded).
 */
export function wordOf(token: string): string {
  return asciiDigits(folded(token));
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
