import { existsSync } from "node:fs";
import { z } from "zod";
import { defineTool } from "./types.js";
import { assertPublicUrl } from "./web-search.js";

const chromiumCandidates = [
  process.env.KULMI_CHROMIUM,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((value): value is string => Boolean(value));

export const browserQaTool = defineTool({
  name: "browser_qa",
  description: "Open a URL in a real headless Chromium browser, return page title/text, and optionally store a screenshot attachment. Only public http/https URLs and localhost are reachable. Requires Chrome/Chromium or KULMI_CHROMIUM.",
  schema: z.object({
    url: z.string().url(),
    wait_until: z.enum(["domcontentloaded", "load", "networkidle"]).default("domcontentloaded"),
    screenshot: z.boolean().default(false),
    max_text_bytes: z.number().int().min(1_000).max(100_000).default(20_000),
  }),
  readOnly: true,
  async execute(context, input) {
    await assertPublicUrl(new URL(input.url), { allowLoopback: true });
    const executablePath = chromiumCandidates.find((path) => existsSync(path));
    if (!executablePath) throw new Error("Chromium not found. Install Chrome/Chromium or set KULMI_CHROMIUM to the executable path.");
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(input.url, { waitUntil: input.wait_until, timeout: context.commandTimeoutMs });
      const title = await page.title();
      const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
      const textBytes = Buffer.from(bodyText, "utf8");
      const clipped = textBytes.length > input.max_text_bytes;
      const text = textBytes.subarray(0, input.max_text_bytes).toString("utf8");
      const lines = [`title: ${title}`, `url: ${page.url()}`, "", text];
      if (clipped) lines.push("\n[truncated]");
      if (input.screenshot) {
        const bytes = await page.screenshot({ fullPage: true, type: "png" });
        const attachment = await context.artifacts.storeAttachment({
          source: `browser_qa:${input.url}`,
          bytes,
          mimeType: "image/png",
          extension: "png",
        });
        lines.push("", `screenshot: ${attachment.attachmentId} ${attachment.path} ${attachment.size} bytes`);
      }
      return { content: lines.join("\n") };
    } finally {
      await browser.close();
    }
  },
});
