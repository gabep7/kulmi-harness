// An LRU cache with a size limit.
// get() must count as a use, so the most recently read key is evicted last.
// Expired entries (ttlMs) must behave as if absent.
export class LruCache {
  #map = new Map();
  #limit;
  #ttlMs;
  #now;

  constructor({ limit = 3, ttlMs = Infinity, now = () => Date.now() } = {}) {
    this.#limit = limit;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  set(key, value) {
    this.#map.set(key, { value, storedAt: this.#now() });
    if (this.#map.size > this.#limit) {
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
    }
  }

  get(key) {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (this.#now() - entry.storedAt >= this.#ttlMs) {
      this.#map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  get size() {
    return this.#map.size;
  }
}
