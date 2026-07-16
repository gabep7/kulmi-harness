import { computeTotal } from "./math.mjs";

export function invoiceTotal(items, discount = 0) {
  return computeTotal(items) - discount;
}
