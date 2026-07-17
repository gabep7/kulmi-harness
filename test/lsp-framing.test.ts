import { describe, expect, it } from "vitest";
import { extractLspFrames } from "../src/tools/lsp.js";

function frame(body: string): Buffer {
  const bodyBuf = Buffer.from(body, "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${bodyBuf.length}\r\n\r\n`, "ascii"), bodyBuf]);
}

describe("extractLspFrames", () => {
  it("decodes consecutive frames with multibyte body characters intact", () => {
    const body1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "héllo → 世界" });
    const body2 = JSON.stringify({ jsonrpc: "2.0", id: 2, result: "ok" });
    const input = Buffer.concat([frame(body1), frame(body2)]);

    const { frames, rest } = extractLspFrames(input);

    expect(frames).toEqual([body1, body2]);
    expect(rest.length).toBe(0);
  });

  it("waits for remaining bytes when a chunk splits a multibyte character", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "世界" });
    const full = frame(body);

    // Split inside the multibyte UTF-8 sequence of the first CJK character.
    // "世界" starts after the ASCII JSON prefix; find the first non-ASCII byte.
    const bodyStart = full.indexOf("\r\n\r\n") + 4;
    const bodyBytes = full.subarray(bodyStart);
    let splitAt = -1;
    for (let i = 0; i < bodyBytes.length; i++) {
      if (bodyBytes[i]! >= 0x80) {
        // Split after the first byte of a multibyte sequence.
        splitAt = bodyStart + i + 1;
        break;
      }
    }
    expect(splitAt).toBeGreaterThan(0);

    const first = full.subarray(0, splitAt);
    const second = full.subarray(splitAt);

    const partial = extractLspFrames(first);
    expect(partial.frames).toEqual([]);
    expect(partial.rest.equals(first)).toBe(true);

    const complete = extractLspFrames(Buffer.concat([partial.rest, second]));
    expect(complete.frames).toEqual([body]);
    expect(complete.rest.length).toBe(0);
  });

  it("drops a header block missing Content-Length and still parses the next frame", () => {
    const badHeader = Buffer.from("Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n", "ascii");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    const input = Buffer.concat([badHeader, frame(body)]);

    const { frames, rest } = extractLspFrames(input);

    expect(frames).toEqual([body]);
    expect(rest.length).toBe(0);
  });
});
