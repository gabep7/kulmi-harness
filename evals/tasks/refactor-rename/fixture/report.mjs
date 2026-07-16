import { computeTotal } from "./math.mjs";

export function reportLine(items) {
  return `total=${computeTotal(items)}`;
}
