import assert from "node:assert/strict";
import { Loader } from "./loader.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Concurrent gets for one key must call the loader exactly once.
let calls = 0;
const loader = new Loader(async (key) => {
  calls += 1;
  await sleep(30);
  return `value:${key}`;
});
const results = await Promise.all([loader.get("a"), loader.get("a"), loader.get("a"), loader.get("a")]);
assert.deepEqual(results, ["value:a", "value:a", "value:a", "value:a"]);
assert.equal(calls, 1, `concurrent gets must dedupe, loader ran ${calls} times`);

// A cached value is served without another load.
assert.equal(await loader.get("a"), "value:a");
assert.equal(calls, 1, "a cached key must not reload");

// Different keys load independently.
await Promise.all([loader.get("b"), loader.get("c")]);
assert.equal(calls, 3, `distinct keys must each load once, saw ${calls}`);

// A failure reaches every concurrent waiter.
let failures = 0;
const flaky = new Loader(async () => {
  failures += 1;
  await sleep(10);
  throw new Error(`boom ${failures}`);
});
const settled = await Promise.allSettled([flaky.get("x"), flaky.get("x"), flaky.get("x")]);
assert.equal(settled.filter((entry) => entry.status === "rejected").length, 3, "all waiters must see the failure");
assert.equal(failures, 1, `a failing load must also dedupe, ran ${failures} times`);

// A failure must not be cached: the next get retries.
await assert.rejects(flaky.get("x"), /boom 2/, "a rejected load must not be cached");
assert.equal(failures, 2);

// Recovery after failure caches the successful value.
let attempt = 0;
const recovering = new Loader(async () => {
  attempt += 1;
  await sleep(5);
  if (attempt === 1) throw new Error("first fails");
  return "recovered";
});
await assert.rejects(recovering.get("k"));
assert.equal(await recovering.get("k"), "recovered");
assert.equal(await recovering.get("k"), "recovered");
assert.equal(attempt, 2, `must not reload after a successful load, ran ${attempt} times`);

// A slow key must not block a different key.
const started = Date.now();
const gate = new Loader(async (key) => {
  await sleep(key === "slow" ? 120 : 5);
  return key;
});
const slow = gate.get("slow");
assert.equal(await gate.get("fast"), "fast");
assert.ok(Date.now() - started < 100, "a pending load must not block other keys");
await slow;

console.log("ok");
