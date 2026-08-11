import { EventStore } from "./store.mjs";

// Balance projection over the event store. It must be able to rebuild from
// scratch and to resume incrementally from a checkpoint without double
// counting or skipping events.
export class BalanceProjection {
  #balances = new Map();
  #checkpoint = 0;
  #store;

  constructor(store) {
    this.#store = store;
  }

  apply(stream) {
    const events = this.#store.read(stream, this.#checkpoint);
    for (const event of events) {
      const current = this.#balances.get(event.account) ?? 0;
      if (event.type === "credit") this.#balances.set(event.account, current + event.amount);
      if (event.type === "debit") this.#balances.set(event.account, current - event.amount);
      this.#checkpoint = event.version;
    }
    return this.#balances;
  }

  balance(account) {
    return this.#balances.get(account) ?? 0;
  }
}

export function openLedger() {
  const store = new EventStore();
  return { store, projection: new BalanceProjection(store) };
}
