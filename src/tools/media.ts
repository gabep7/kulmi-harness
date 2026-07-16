import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { assertNotSensitivePath, resolveWorkspacePath } from "../security/paths.js";
import { defineTool } from "./types.js";

export const attachImageTool = defineTool({
  name: "attach_image",
  description: "Store a workspace image as a session attachment and return metadata. Prompts can also attach images by including @image <path>.",
  schema: z.object({ path: z.string().min(1) }),
  readOnly: true,
  async execute(context, input) {
    const path = await resolveWorkspacePath({ workspaceRoot: context.workspaceRoot, cwd: context.cwd, input: input.path, mustExist: true });
    assertNotSensitivePath(path);
    const bytes = await readFile(path);
    if (bytes.length > 50 * 1024 * 1024) throw new Error(`image is too large: ${input.path}`);
    const mimeType = mimeTypeFor(path);
    const attachment = await context.artifacts.storeAttachment({
      source: input.path,
      bytes,
      mimeType,
      extension: extname(path).slice(1).toLowerCase(),
    });
    return { content: JSON.stringify(attachment, null, 2) };
  },
});

function mimeTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      throw new Error(`unsupported image type: ${path}`);
  }
}
