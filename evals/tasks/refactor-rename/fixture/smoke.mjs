import assert from "node:assert";
import { invoiceTotal } from "./invoice.mjs";
import { computeTotal } from "./math.mjs";
import { reportLine } from "./report.mjs";

assert.equal(computeTotal([1, 2, 3]), 6);
assert.equal(invoiceTotal([2, 3], 1), 4);
assert.equal(reportLine([4]), "total=4");
console.log("ok");
