import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface MaterializedOutput {
  content: string;
  artifactId?: string;
}

export class ArtifactStore {
  readonly #root: string;
  readonly #threshold: number;

  constructor(sessionPath: string, threshold = 40_000) {
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
    const head = content.slice(0, 24_000);
    const tail = content.slice(-8_000);
    return {
      artifactId,
      content:
        `[tool output truncated: ${bytes} bytes; full output ${artifactId}; source ${tool}/${callId}]\n` +
        `${head}\n\n[...truncated...]\n\n${tail}`,
    };
  }

  async read(id: string, offset: number, limit: number): Promise<string> {
    if (!/^artifact_[a-f0-9]{16}$/.test(id)) throw new Error(`invalid artifact ID ${id}`);
    const content = await readFile(join(this.#root, `${id}.txt`), "utf8");
    return content.slice(offset, offset + limit);
  }
}
