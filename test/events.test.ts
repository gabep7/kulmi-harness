import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/core/events.js";

describe("EventBus", () => {
  it("isolates presentation listener failures", async () => {
    const bus = new EventBus();
    const healthy = vi.fn();
    bus.on(() => { throw new Error("renderer failed"); });
    bus.on(healthy);
    await expect(bus.emit({ type: "notice", message: "continue" })).resolves.toMatchObject({ sequence: 1 });
    expect(healthy).toHaveBeenCalledOnce();
  });

  it("propagates critical persistence failures", async () => {
    const bus = new EventBus();
    bus.on(async () => { throw new Error("disk failed"); }, { critical: true });
    await expect(bus.emit({ type: "notice", message: "persist" })).rejects.toThrow("disk failed");
  });
});
