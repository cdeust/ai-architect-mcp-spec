/**
 * What a finding names when it lists identifiers (#125).
 *
 * A rule that named every identifier it found had no bound on its message. A
 * numbering rule named every number missing between the smallest and the
 * largest identifier of a section: a 23-char section holding `AC-1` and
 * `AC-20000` gave one violation of 189,076 chars, and `AC-2000000` one of
 * 22.9 MB (measured 2026-11-13 on main @ a2c2fb6), above the 100,000-char
 * budget the MCP server declares for a whole response. The same rule walked
 * the whole range to find the missing numbers and stored each one, so its
 * time and memory grew with the width of the gap, not with the size of the
 * document: with `AC-2000000000` it threw `RangeError: Invalid array length`
 * after about 2 s.
 *
 * A finding names the first MAX_LISTED_IDS identifiers and counts the rest.
 * The count is exact; what is no longer in the message is the name of each
 * identifier past the first ones. The author of a document with that many
 * findings of one kind fixes the cause, and the next report names what is
 * left.
 */

/**
 * Identifiers named in one list of a finding; the rest are counted. The
 * value `dependency_targets_defined` already used (#118).
 */
export const MAX_LISTED_IDS = 20;

/**
 * precondition:  `ids` are in the order they are to be named; `total` is the
 *                number of identifiers the list is about, `ids.length` or
 *                more (a caller that has only the first ones passes the
 *                full count).
 * postcondition: the first MAX_LISTED_IDS of `ids` joined by ", ", followed
 *                by " and N more" when `total` is larger than what is named.
 */
export function listedIds(ids: readonly string[], total: number = ids.length): string {
  const named = ids.slice(0, MAX_LISTED_IDS);
  const more = total - named.length;
  const names = named.join(", ");
  return more > 0 ? `${names} and ${more} more` : names;
}

export interface MissingNumbers {
  /** The smallest missing numbers, ascending: at most MAX_LISTED_IDS. */
  readonly first: readonly number[];
  /** How many numbers are missing in all. */
  readonly count: number;
}

/**
 * precondition:  `sorted` holds distinct non-negative integers in ascending
 *                order.
 * postcondition: the integers strictly between two consecutive elements of
 *                `sorted`: how many there are, and the smallest
 *                MAX_LISTED_IDS of them. The cost grows with the length of
 *                `sorted`, not with the width of the range it spans.
 */
export function missingNumbers(sorted: readonly number[]): MissingNumbers {
  const first: number[] = [];
  let count = 0;
  for (let i = 1; i < sorted.length; i++) {
    const low = sorted[i - 1];
    const high = sorted[i];
    count += high - low - 1;
    for (let n = low + 1; n < high && first.length < MAX_LISTED_IDS; n++) first.push(n);
  }
  return { first, count };
}
