import { fromCents } from "./money.mjs";
import { totalCents } from "./pricing.mjs";

export function checkout(items) {
  return fromCents(totalCents(items));
}
