import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { SearchConfig } from "../config/config.js";
import { defineTool, type AnyTool } from "./types.js";
import { USER_AGENT, VERSION } from "../core/version.js";

const searchInputSchema = z.object({
  query: z.string().min(2).max(400),
  limit: z.number().int().min(1).max(10).optional(),
  recency_days: z.number().int().min(1).max(3650).optional(),
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

interface SearchResponse {
  provider: "searxng" | "bing-rss";
  results: SearchResult[];
}

export function freeWebSearchTool(config: SearchConfig): AnyTool {
  return defineTool({
    name: "web_search",
    description:
      "Search the public web without a paid API. Uses a configured self-hosted SearXNG instance or Bing's personal-use RSS results. Follow important results with fetch_url and prefer primary sources.",
    schema: searchInputSchema,
    readOnly: true,
    async execute(context, input) {
      const limit = Math.min(10, Math.max(1, input.limit ?? config.resultLimit));
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
      const response = await searchFree(config, input.query, limit, input.recency_days, signal);
      return {
        content: JSON.stringify({
          provider: response.provider,
          query: input.query,
          results: response.results,
        }),
      };
    },
  });
}

export function fetchUrlTool(): AnyTool {
  return defineTool({
    name: "fetch_url",
    description:
      "Fetch a public HTTP or HTTPS page as bounded model-readable text. Use after web_search to inspect primary sources. Private networks, credentials, nonstandard ports, and binary content are blocked.",
    schema: z.object({
      url: z.string().url().max(4_000),
      max_chars: z.number().int().min(1_000).max(100_000).default(30_000),
    }),
    readOnly: true,
    async execute(context, input) {
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]);
      const result = await fetchPublicText(input.url, input.max_chars, signal);
      return { content: JSON.stringify(result) };
    },
  });
}

async function searchFree(
  config: SearchConfig,
  query: string,
  limit: number,
  recencyDays: number | undefined,
  signal: AbortSignal,
): Promise<SearchResponse> {
  if (config.provider === "searxng") {
    if (!config.searxngUrl) throw new Error("search.provider=searxng requires search.searxng_url");
    return { provider: "searxng", results: await searchSearxng(config.searxngUrl, query, limit, recencyDays, signal) };
  }
  if (config.provider === "auto" && config.searxngUrl) {
    try {
      const quickSignal = AbortSignal.any([signal, AbortSignal.timeout(2_500)]);
      const results = await searchSearxng(config.searxngUrl, query, limit, recencyDays, quickSignal);
      if (results.length > 0) return { provider: "searxng", results };
    } catch {
      // The configured free local service is optional in auto mode.
    }
  }
  return { provider: "bing-rss", results: await searchBingRss(query, limit, recencyDays, signal) };
}

async function searchSearxng(
  baseUrl: string,
  query: string,
  limit: number,
  recencyDays: number | undefined,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const endpoint = new URL("/search", ensureHttpUrl(baseUrl));
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("categories", "general");
  endpoint.searchParams.set("safesearch", "1");
  if (recencyDays !== undefined) {
    endpoint.searchParams.set("time_range", recencyDays <= 1 ? "day" : recencyDays <= 31 ? "month" : "year");
  }
  const response = await fetch(endpoint, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}: ${await responseSnippet(response, signal)}`);
  const body = await readBounded(response, 1_000_000, signal);
  const payload = z.object({
    results: z.array(z.object({
      title: z.string().catch("Untitled"),
      url: z.string(),
      content: z.string().catch(""),
      publishedDate: z.string().optional(),
    }).passthrough()).catch([]),
  }).passthrough().parse(JSON.parse(new TextDecoder().decode(body.data)));
  return payload.results
    .map((item) => normalizeResult(item.title, item.url, item.content, item.publishedDate))
    .filter((item): item is SearchResult => item !== undefined)
    .slice(0, limit);
}

async function searchBingRss(
  query: string,
  limit: number,
  recencyDays: number | undefined,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const endpoint = new URL("https://www.bing.com/search");
  const datedQuery = recencyDays === undefined
    ? query
    : `${query} after:${new Date(Date.now() - recencyDays * 86_400_000).toISOString().slice(0, 10)}`;
  endpoint.searchParams.set("q", datedQuery);
  endpoint.searchParams.set("format", "rss");
  const response = await fetch(endpoint, {
    signal,
    headers: { accept: "application/rss+xml,application/xml,text/xml", "user-agent": `Kulmi/${VERSION}` },
  });
  if (!response.ok) throw new Error(`Bing RSS HTTP ${response.status}: ${await responseSnippet(response, signal)}`);
  const xml = new TextDecoder().decode((await readBounded(response, 1_000_000, signal)).data);
  if (!/<rss\b/i.test(xml)) throw new Error("Bing did not return an RSS feed");
  const results: SearchResult[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = match[1] ?? "";
    const title = readXmlField(item, "title");
    const url = readXmlField(item, "link");
    const description = readXmlField(item, "description");
    const publishedAt = readXmlField(item, "pubDate");
    const normalized = normalizeResult(title, url, htmlToText(description), publishedAt || undefined);
    if (normalized) results.push(normalized);
    if (results.length >= limit) break;
  }
  return results;
}

function readXmlField(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
  return decodeEntities((match?.[1] ?? "").replace(/^<!\[CDATA\[|\]\]>$/g, "").trim());
}

async function fetchPublicText(rawUrl: string, maxChars: number, signal: AbortSignal): Promise<{
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
}> {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicUrl(url);
    const response = await fetch(url, {
      signal,
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml,application/json,text/plain,text/markdown,application/xml;q=0.9",
        "user-agent": USER_AGENT,
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`redirect ${response.status} did not include a location`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`fetch HTTP ${response.status}: ${await responseSnippet(response, signal)}`);
    const contentType = (response.headers.get("content-type") ?? "text/plain").split(";", 1)[0]!.trim().toLowerCase();
    if (!isTextContentType(contentType)) throw new Error(`blocked non-text content type ${contentType}`);
    const bytes = await readBounded(response, Math.min(1_000_000, maxChars * 4), signal);
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.data);
    const text = contentType.includes("html") ? htmlToText(decoded) : decoded;
    const bounded = text.slice(0, maxChars);
    return {
      url: url.toString(),
      contentType,
      text: `<untrusted-web-content>\n${bounded}\n</untrusted-web-content>`,
      truncated: bytes.truncated || text.length > bounded.length,
    };
  }
  throw new Error("too many redirects");
}

// Residual risk: this validates the DNS resolution, but the subsequent fetch()
// resolves the hostname independently, so a DNS-rebinding attacker could return a
// public address here and a private one to the fetch. Closing this fully requires a
// custom undici dispatcher that connects to the exact validated IP while preserving
// the Host header and TLS servername.
export async function assertPublicUrl(url: URL, options: { allowLoopback?: boolean } = {}): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only HTTP and HTTPS URLs are allowed");
  if (url.username || url.password) throw new Error("URL credentials are blocked");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (options.allowLoopback && (host === "localhost" || isLoopbackAddress(host))) {
    return;
  }
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("nonstandard URL ports are blocked");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("local network URLs are blocked");
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("private or unresolved network address is blocked");
  }
}

function isLoopbackAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value === "::1") return true;
  const mapped = mappedIpv4(value);
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : undefined);
  if (!ipv4) return false;
  const [a = 0] = ipv4.split(".").map(Number);
  return a === 127;
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (
    value === "::1" || value === "::" || value.startsWith("fe8") || value.startsWith("fe9") ||
    value.startsWith("fea") || value.startsWith("feb") || value.startsWith("fc") || value.startsWith("fd") ||
    value.startsWith("fec") || value.startsWith("fed") || value.startsWith("fee") || value.startsWith("fef") ||
    value.startsWith("ff") || value.startsWith("2001:db8:") || value.startsWith("64:ff9b:")
  ) return true;
  const mapped = mappedIpv4(value);
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : undefined);
  if (!ipv4) return false;
  const parts = ipv4.split(".").map(Number);
  const [a = 0, b = 0] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function mappedIpv4(value: string): string | undefined {
  const dotted = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return dotted;
  const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<{ data: Uint8Array; truncated: boolean }> {
  if (!response.body) return { data: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("fetch aborted");
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      if (value.length > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        size = limit;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return { data: output, truncated };
}

async function responseSnippet(response: Response, signal: AbortSignal): Promise<string> {
  return new TextDecoder().decode((await readBounded(response, 2_000, signal)).data).slice(0, 500);
}

function isTextContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || [
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/xhtml+xml",
  ].includes(contentType);
}

function normalizeResult(
  title: string,
  rawUrl: string,
  snippet: string,
  publishedAt?: string,
): SearchResult | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return {
    title: decodeEntities(title).slice(0, 500),
    url: url.toString(),
    snippet: decodeEntities(snippet).slice(0, 2_000),
    ...(publishedAt ? { publishedAt: publishedAt.slice(0, 200) } : {}),
  };
}

function ensureHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SearXNG URL must use http or https");
  }
  return url;
}

function htmlToText(html: string): string {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|main|header|footer|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}
