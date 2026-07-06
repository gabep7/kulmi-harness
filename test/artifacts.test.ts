import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/runtime/artifacts.js";

describe("ArtifactStore", () => {
  it("keeps large tool output outside model context and supports retrieval", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-artifacts-"));
    const store = new ArtifactStore(root, 100);
    const full = `${"a".repeat(150)}${"z".repeat(150)}`;
    const result = await store.materialize("shell", "call_1", full);
    expect(result.artifactId).toMatch(/^artifact_/);
    expect(result.content).toContain("tool output truncated");
    expect(await store.read(result.artifactId!, 140, 30)).toBe(full.slice(140, 170));
  });

  it("reads artifact slices by UTF-8 byte offsets", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-artifacts-"));
    const store = new ArtifactStore(root, 1);
    const result = await store.materialize("shell", "call_bytes", "abc😀def");

    expect(await store.read(result.artifactId!, 3, 4)).toBe("😀");
    expect(await store.read(result.artifactId!, 7, 3)).toBe("def");
  });

  it("bounds multibyte previews by bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-artifacts-"));
    const store = new ArtifactStore(root);
    const result = await store.materialize("shell", "call_unicode", "😀".repeat(12_000));
    expect(result.artifactId).toMatch(/^artifact_/);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(15_000);
  });
});
