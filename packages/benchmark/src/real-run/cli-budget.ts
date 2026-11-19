import type { BigNumber } from "mathjs";

export function effectiveDollars(available: BigNumber): number {
  if (available.lte(0)) return 0;
  const rounded = available.times(1e6).floor().div(1e6);
  const dollars = rounded.toNumber();
  if (rounded.gte(String(dollars))) return dollars;
  // When a microdollar is narrower than the spacing between JSON numbers,
  // converting to Number can round back up. Use the preceding positive binary64.
  const value = new Float64Array([dollars]);
  const bits = new BigUint64Array(value.buffer);
  bits[0] -= 1n;
  return value[0];
}
