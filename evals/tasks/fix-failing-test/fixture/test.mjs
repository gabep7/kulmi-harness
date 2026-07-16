import assert from "node:assert";
import { sumRange } from "./lib.mjs";

assert.equal(sumRange(1, 3), 6, "sumRange(1, 3) must include both bounds");
assert.equal(sumRange(0, 0), 0, "sumRange(0, 0) must be 0");
assert.equal(sumRange(2, 5), 14, "sumRange(2, 5) must be 14");
console.log("ok");
