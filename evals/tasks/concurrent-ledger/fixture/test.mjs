import assert from "node:assert/strict";
import { openLedger } from "./projection.mjs";

// Single stream, rebuilt from scratch.
{
  const { store, projection } = openLedger();
  store.append("acct-1", 0, [
    { type: "credit", account: "alice", amount: 100 },
    { type: "debit", account: "alice", amount: 30 },
  ]);
  projection.apply("acct-1");
  assert.equal(projection.balance("alice"), 70, "single stream must project correctly");
}

// Incremental resume must not double count.
{
  const { store, projection } = openLedger();
  store.append("acct-1", 0, [{ type: "credit", account: "bob", amount: 50 }]);
  projection.apply("acct-1");
  projection.apply("acct-1");
  assert.equal(projection.balance("bob"), 50, "re-applying must not double count");

  store.append("acct-1", 1, [{ type: "credit", account: "bob", amount: 25 }]);
  projection.apply("acct-1");
  assert.equal(projection.balance("bob"), 75, "incremental apply must pick up new events");
}

// Two streams interleaved: this is where a single shared checkpoint breaks,
// because each stream numbers its own versions from 1.
{
  const { store, projection } = openLedger();
  store.append("acct-1", 0, [
    { type: "credit", account: "carol", amount: 10 },
    { type: "credit", account: "carol", amount: 10 },
    { type: "credit", account: "carol", amount: 10 },
  ]);
  store.append("acct-2", 0, [
    { type: "credit", account: "dave", amount: 7 },
    { type: "credit", account: "dave", amount: 7 },
  ]);

  projection.apply("acct-1");
  assert.equal(projection.balance("carol"), 30, "first stream fully applied");

  projection.apply("acct-2");
  assert.equal(projection.balance("dave"), 14, "second stream must not be skipped by the first stream's checkpoint");

  // Re-applying both must still be idempotent.
  projection.apply("acct-1");
  projection.apply("acct-2");
  assert.equal(projection.balance("carol"), 30, "carol must not be double counted");
  assert.equal(projection.balance("dave"), 14, "dave must not be double counted");
}

// Appending to one stream must not resurrect already-applied events elsewhere.
{
  const { store, projection } = openLedger();
  store.append("s1", 0, [{ type: "credit", account: "eve", amount: 100 }]);
  store.append("s2", 0, [{ type: "debit", account: "eve", amount: 40 }]);
  projection.apply("s1");
  projection.apply("s2");
  assert.equal(projection.balance("eve"), 60);

  store.append("s2", 1, [{ type: "debit", account: "eve", amount: 10 }]);
  projection.apply("s2");
  assert.equal(projection.balance("eve"), 50, "only the new event may apply");

  projection.apply("s1");
  assert.equal(projection.balance("eve"), 50, "re-applying s1 must change nothing");
}

// Optimistic concurrency must still reject stale writers.
{
  const { store } = openLedger();
  store.append("s", 0, [{ type: "credit", account: "x", amount: 1 }]);
  assert.throws(() => store.append("s", 0, [{ type: "credit", account: "x", amount: 1 }]), /version conflict/);
  store.append("s", 1, [{ type: "credit", account: "x", amount: 1 }]);
}

console.log("ok");
