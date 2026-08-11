// A read-through cache in front of an expensive loader.
//
// Contract:
// - get(key) resolves with the loaded value.
// - Concurrent gets for the same key must trigger exactly ONE loader call
//   (in-flight deduplication), and all callers get that value.
// - A rejected load must propagate to every waiter and must NOT be cached:
//   a later get retries the loader.
// - Different keys never share a load.
export class Loader {
  #cache = new Map();
  #load;

  constructor(load) {
    this.#load = load;
  }

  async get(key) {
    if (this.#cache.has(key)) return this.#cache.get(key);
    const value = await this.#load(key);
    this.#cache.set(key, value);
    return value;
  }
}
