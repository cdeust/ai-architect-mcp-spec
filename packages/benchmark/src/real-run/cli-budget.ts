import { all, create, type BigNumber } from "mathjs";
import type { Row } from "./types.js";

// One digit for each decimal position representable by a reported JSON number.
const precision = Math.floor(Math.log10(Number.MAX_VALUE)) - Math.floor(Math.log10(Number.MIN_VALUE)) + 1;
const decimal = create(all, { precision }).bignumber;

export function reportedDollars(dollars: number): BigNumber {
  return decimal(String(dollars));
}

export interface CostTally {
  cost_usd: BigNumber;
  unmetered_calls: number;
}

export function addCost(total: CostTally, usage: Row["usage"]): void {
  if (usage?.cost_usd == null) total.unmetered_calls++;
  else total.cost_usd = total.cost_usd.plus(String(usage.cost_usd));
}

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
