import assert from "node:assert";
import { slugify } from "./slugify.mjs";

assert.equal(slugify("Hello, World!"), "hello-world");
assert.equal(slugify("  Kulmi   Harness  "), "kulmi-harness");
assert.equal(slugify("already-slugged"), "already-slugged");
assert.equal(slugify("A1 b2--C3"), "a1-b2-c3");
console.log("ok");
