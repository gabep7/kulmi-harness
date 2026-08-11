import assert from "node:assert/strict";
import { parseLine } from "./parse-csv.mjs";

assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
assert.deepEqual(parseLine('a,"b,c",d'), ["a", "b,c", "d"]);
assert.deepEqual(parseLine('"he said ""hi""",x'), ['he said "hi"', "x"]);
assert.deepEqual(parseLine("a,,c"), ["a", "", "c"]);
assert.deepEqual(parseLine('""'), [""]);
console.log("ok");
