import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchConfig } from "../src/config/config.js";
import { assertPublicUrl, fetchUrlTool, freeWebSearchTool } from "../src/tools/web-search.js";
import type { ToolContext } from "../src/tools/types.js";


describe("free web search", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the configured SearXNG endpoint and returns bounded sources", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://search.internal");
      expect(url.searchParams.get("q")).toBe("cache docs");
      expect(url.searchParams.get("format")).toBe("json");
      return new Response(JSON.stringify({
        results: [
          { title: "One", url: "https://example.com/one", content: "first" },
          { title: "Two", url: "https://example.com/two", content: "second" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = freeWebSearchTool(config());
    const result = await tool.execute({ signal: new AbortController().signal } as ToolContext, {
      query: "cache docs",
      limit: 1,
    });
    expect(JSON.parse(result.content)).toMatchObject({
      provider: "searxng",
      results: [{ title: "One", url: "https://example.com/one" }],
    });
  });

  it("blocks private-network fetches before issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = fetchUrlTool();
    await expect(tool.execute({ signal: new AbortController().signal } as ToolContext, {
      url: "http://127.0.0.1/secrets",
      max_chars: 30_000,
    })).rejects.toThrow("private");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the keyless Bing RSS fallback without credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("www.bing.com");
      expect(url.searchParams.get("format")).toBe("rss");
      return new Response(`<?xml version="1.0"?><rss><channel><item>
        <title>Primary &amp; source</title>
        <link>https://example.com/docs</link>
        <description>Current &lt;b&gt;documentation&lt;/b&gt;.</description>
        <pubDate>Thu, 18 Jun 2026 12:00:00 GMT</pubDate>
      </item></channel></rss>`, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }));
    const tool = freeWebSearchTool({ ...config(), provider: "auto", searxngUrl: "" });
    const result = await tool.execute({ signal: new AbortController().signal } as ToolContext, {
      query: "current docs",
    });
    expect(JSON.parse(result.content)).toMatchObject({
      provider: "bing-rss",
      results: [{ title: "Primary & source", url: "https://example.com/docs", snippet: "Current documentation." }],
    });
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-http schemes and link-local addresses", async () => {
    await expect(assertPublicUrl(new URL("file:///etc/passwd"))).rejects.toThrow("only HTTP and HTTPS");
    await expect(assertPublicUrl(new URL("http://169.254.169.254/"))).rejects.toThrow("private");
  });

  it("blocks localhost without allowLoopback and accepts it with the carve-out", async () => {
    await expect(assertPublicUrl(new URL("http://localhost"))).rejects.toThrow("local network");
    await expect(assertPublicUrl(new URL("http://localhost:5173"))).rejects.toThrow();
    await expect(assertPublicUrl(new URL("http://127.0.0.1:5173"))).rejects.toThrow();
    await expect(assertPublicUrl(new URL("http://localhost:5173"), { allowLoopback: true })).resolves.toBeUndefined();
    await expect(assertPublicUrl(new URL("http://127.0.0.1:5173"), { allowLoopback: true })).resolves.toBeUndefined();
    await expect(assertPublicUrl(new URL("http://[::1]:5173"), { allowLoopback: true })).resolves.toBeUndefined();
  });

  it("still rejects .local hostnames even with allowLoopback", async () => {
    await expect(assertPublicUrl(new URL("http://some-name.local/"), { allowLoopback: true })).rejects.toThrow(
      "local network",
    );
  });
});

function config(): SearchConfig {
  return {
    mode: "free",
    resultLimit: 5,
    provider: "searxng",
    searxngUrl: "https://search.internal",
  };
}
