import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeUtf8Slice, utf8Prefix, utf8Suffix } from "../core/utf8.js";


export interface MaterializedOutput {
  content: string;
  artifactId?: string;
}

export interface StoredAttachment {
  attachmentId: string;
  path: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export class ArtifactStore {
  readonly #root: string;
  readonly #threshold: number;

  constructor(sessionPath: string, threshold = 16_000) {
    this.#root = join(sessionPath, "artifacts");
    this.#threshold = threshold;
  }

  async materialize(tool: string, callId: string, content: string): Promise<MaterializedOutput> {
    const bytes = Buffer.byteLength(content);
    if (bytes <= this.#threshold) return { content };
    const digest = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const artifactId = `artifact_${digest}`;
    await mkdir(this.#root, { recursive: true });
    await writeFile(join(this.#root, `${artifactId}.txt`), content, "utf8");
    const head = utf8Prefix(content, 10_000);
    const tail = utf8Suffix(content, 4_000);
    return {
      artifactId,
      content:
        `[tool output truncated: ${bytes} bytes; full output ${artifactId}; source ${tool}/${callId}]\n` +
        `${head}\n\n[...truncated...]\n\n${tail}`,
    };
  }

  async storeAttachment(input: {
    source: string;
    bytes: Uint8Array;
    mimeType: string;
    extension: string;
  }): Promise<StoredAttachment> {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const attachmentId = `attachment_${sha256.slice(0, 16)}`;
    const extension = input.extension.replace(/^\./, "");
    await mkdir(this.#root, { recursive: true });
    const path = join(this.#root, `${attachmentId}.${extension}`);
    await writeFile(path, input.bytes);
    return {
      attachmentId,
      path,
      mimeType: input.mimeType,
      size: input.bytes.byteLength,
      sha256,
    };
  }

  async read(id: string, offset: number, limit: number): Promise<string> {
    if (!/^artifact_[a-f0-9]{16}$/.test(id)) throw new Error(`invalid artifact ID ${id}`);
    const content = await readFile(join(this.#root, `${id}.txt`));
    return decodeUtf8Slice(content, offset, offset + limit);
  }
}
