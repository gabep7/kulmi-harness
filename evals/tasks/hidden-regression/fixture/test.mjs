import assert from "node:assert/strict";
import { LruCache } from "./cache.mjs";

// Reading a key must make it the most recently used one.
const cache = new LruCache({ limit: 2 });
cache.set("a", 1);
cache.set("b", 2);
assert.equal(cache.get("a"), 1);
cache.set("c", 3);
assert.equal(cache.get("a"), 1, "a was read recently so it must survive");
assert.equal(cache.get("b"), undefined, "b was least recently used");
console.log("ok");
