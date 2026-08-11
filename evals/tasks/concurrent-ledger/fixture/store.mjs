// A tiny append-only event store with optimistic concurrency.
// Version numbers are per-stream and must be gapless, starting at 1.
export class EventStore {
  #streams = new Map();

  append(stream, expectedVersion, events) {
    const current = this.#streams.get(stream) ?? [];
    if (expectedVersion !== current.length) {
      throw new Error(`version conflict on ${stream}: expected ${expectedVersion}, actual ${current.length}`);
    }
    const appended = events.map((event, index) => ({ ...event, version: current.length + index + 1 }));
    this.#streams.set(stream, [...current, ...appended]);
    return current.length + appended.length;
  }

  read(stream, fromVersion = 0) {
    return (this.#streams.get(stream) ?? []).filter((event) => event.version > fromVersion);
  }
}
