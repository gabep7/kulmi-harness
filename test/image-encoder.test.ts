import { describe, expect, it } from "vitest";
import { renderTextToFrames, serializeForImaging } from "../src/compaction/image-encoder.js";

describe("image encoder", () => {
  it("produces valid PNG frames from text", () => {
    const frames = renderTextToFrames("hello world", { frameWidth: 200 });
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const first = frames[0]!;
    expect(first.width).toBe(200);
    expect(first.height).toBeGreaterThan(0);
    expect(first.png.length).toBeGreaterThan(50);
    expect(first.png[0]).toBe(0x89);
    expect(first.png[1]).toBe(0x50);
    expect(first.png[2]).toBe(0x4e);
    expect(first.png[3]).toBe(0x47);
  });

  it("splits long text across multiple frames", () => {
    const longText = Array.from({ length: 500 }, (_, i) => `line ${i}: the quick brown fox jumps`).join("\n");
    const frames = renderTextToFrames(longText, { frameWidth: 400, maxFrames: 10 });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.length).toBeLessThanOrEqual(10);
  });

  it("respects maxFrames limit", () => {
    const longText = Array.from({ length: 2000 }, () => "x".repeat(50)).join("\n");
    const frames = renderTextToFrames(longText, { maxFrames: 3 });
    expect(frames.length).toBe(3);
  });

  it("handles empty text", () => {
    const frames = renderTextToFrames("");
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]!.png.length).toBeGreaterThan(50);
  });

  it("serializes conversation messages into dense text", () => {
    const messages = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function" as const, function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "c1", name: "read_file", content: "export const x = 1;" },
      { role: "assistant", content: "found it" },
    ];
    const text = serializeForImaging(messages);
    expect(text).toContain("U: fix the bug");
    expect(text).toContain("read_file(");
    expect(text).toContain("T: export const x = 1;");
    expect(text).toContain("A: found it");
    expect(text).not.toContain("[object Object]");
  });

  it("truncates large tool results in serialization", () => {
    const bigContent = "x".repeat(5_000);
    const messages = [{ role: "tool", tool_call_id: "c1", name: "read_file", content: bigContent }];
    const text = serializeForImaging(messages);
    expect(text).toContain("[...truncated");
    expect(text.length).toBeLessThan(bigContent.length);
  });
});