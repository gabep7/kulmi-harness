import assert from "node:assert/strict";
import { countLowerBefore } from "./rank.mjs";

// Correctness on small inputs, including ties and negatives.
assert.deepEqual(countLowerBefore([]), []);
assert.deepEqual(countLowerBefore([{ score: 5 }]), [0]);
assert.deepEqual(
  countLowerBefore([{ score: 3 }, { score: 1 }, { score: 2 }, { score: 3 }]),
  [0, 0, 1, 2],
  "ties must not count as strictly lower",
);
assert.deepEqual(
  countLowerBefore([{ score: -5 }, { score: 0 }, { score: -5 }, { score: -10 }]),
  [0, 1, 0, 0],
  "negative and duplicate scores must be handled",
);

// A brute-force reference agrees on random input.
const random = Array.from({ length: 400 }, () => ({ score: Math.floor(Math.random() * 50) - 25 }));
const reference = random.map((event, index) =>
  random.slice(0, index).filter((earlier) => earlier.score < event.score).length
);
assert.deepEqual(countLowerBefore(random), reference, "must match brute force on random input");

// Scale: 200k events must finish quickly. A quadratic solution needs about
// 2e10 comparisons here and cannot pass, while an O(n log n) or counting
// approach finishes in well under a second.
const size = 200_000;
const large = Array.from({ length: size }, (_, index) => ({ score: (index * 7919) % 10_007 }));
const started = Date.now();
const result = countLowerBefore(large);
const elapsed = Date.now() - started;
assert.equal(result.length, size);

// Spot check a few positions against brute force over a bounded window.
for (const index of [0, 1, 1000, 50_000, size - 1]) {
  const expected = large.slice(0, index).filter((earlier) => earlier.score < large[index].score).length;
  assert.equal(result[index], expected, `wrong count at index ${index}`);
}
assert.ok(elapsed < 4000, `expected sub-quadratic scaling, took ${elapsed}ms for ${size} events`);

console.log("ok");
