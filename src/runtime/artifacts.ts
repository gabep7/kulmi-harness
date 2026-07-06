import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const artifactDecoder = new TextDecoder("utf-8");

export interface MaterializedOutput {
  content: string;
  artifactId?: string;
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
    const encoded = Buffer.from(content, "utf8");
    const head = encoded.subarray(0, 10_000).toString("utf8");
    const tail = encoded.subarray(Math.max(0, encoded.length - 4_000)).toString("utf8");
    return {
      artifactId,
      content:
        `[tool output truncated: ${bytes} bytes; full output ${artifactId}; source ${tool}/${callId}]\n` +
        `${head}\n\n[...truncated...]\n\n${tail}`,
    };
  }

  async read(id: string, offset: number, limit: number): Promise<string> {
    if (!/^artifact_[a-f0-9]{16}$/.test(id)) throw new Error(`invalid artifact ID ${id}`);
    const content = await readFile(join(this.#root, `${id}.txt`));
    return artifactDecoder.decode(content.subarray(offset, offset + limit));
  }
}
