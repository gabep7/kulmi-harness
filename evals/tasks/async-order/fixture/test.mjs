import assert from "node:assert/strict";
import { mapLimit } from "./map-limit.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Concurrency must actually be used: 6 items x 50ms with limit 3 must not be serial.
let inFlight = 0;
let peak = 0;
const started = Date.now();
const out = await mapLimit([1, 2, 3, 4, 5, 6], 3, async (n) => {
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  await sleep(50);
  inFlight -= 1;
  return n * 2;
});
const elapsed = Date.now() - started;

assert.deepEqual(out, [2, 4, 6, 8, 10, 12], "results must be in input order");
assert.ok(peak > 1, `expected parallelism, peak in flight was ${peak}`);
assert.ok(peak <= 3, `limit exceeded, peak in flight was ${peak}`);
// The peak assertions above already prove the mapper ran concurrently. This
// timing check is only a coarse guard against a fully serial implementation
// (6 x 50ms = 300ms), with generous headroom so a loaded machine does not fail
// a correct answer.
assert.ok(elapsed < 280, `expected concurrent execution, took ${elapsed}ms`);

// Order must hold when later items finish first.
const reversed = await mapLimit([100, 10, 1], 3, async (ms) => {
  await sleep(ms);
  return ms;
});
assert.deepEqual(reversed, [100, 10, 1], "slowest item must stay first");

// Errors must propagate.
await assert.rejects(
  mapLimit([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error("boom");
    await sleep(10);
    return n;
  }),
  /boom/,
);

console.log("ok");
