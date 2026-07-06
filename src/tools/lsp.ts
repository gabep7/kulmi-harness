import { readFile } from "node:fs/promises";
import { type ChildProcess, spawn } from "node:child_process";
import { z } from "zod";
import { resolveToolBinary } from "../runtime/binaries.js";
import { resolveWorkspacePath } from "../security/paths.js";
import { defineTool } from "./types.js";

interface LspMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const SYMBOL_KIND_NAME: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
  15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
  20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};

class LspClient {
  #process: ChildProcess | null = null;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #buffer = "";
  #initialized = false;
  #openFiles = new Set<string>();
  readonly #workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = workspaceRoot;
  }

  async ensureRunning(): Promise<void> {
    if (this.#initialized && this.#process) return;

    const binary = await resolveToolBinary("typescript-language-server");
    if (!binary) {
      throw new Error("LSP server unavailable. Install dependencies with npm install or add typescript-language-server to PATH.");
    }
    try {
      this.#process = spawn(binary, ["--stdio"], {
        cwd: this.#workspaceRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw new Error("LSP server unavailable. Install dependencies with npm install or add typescript-language-server to PATH.");
    }

    this.#process.on("error", (err) => {
      const msg = err.message.includes("ENOENT")
        ? "LSP server unavailable. Install dependencies with npm install or add typescript-language-server to PATH."
        : "LSP server disconnected";
      this.#process = null;
      this.#initialized = false;
      for (const pending of this.#pending.values()) pending.reject(new Error(msg));
      this.#pending.clear();
    });

    this.#process.on("exit", () => {
      this.#process = null;
      this.#initialized = false;
      for (const pending of this.#pending.values()) pending.reject(new Error("LSP server exited"));
      this.#pending.clear();
    });

    this.#process.stdout?.on("data", (chunk: Buffer | string) => {
      this.#buffer += typeof chunk === "string" ? chunk : chunk.toString();
      this.#parseResponses();
    });

    this.#process.stderr?.on("data", () => {});

    await this.#initialize();
  }

  async #initialize(): Promise<void> {
    await this.#sendRequest("initialize", {
      processId: process.pid,
      rootUri: `file://${this.#workspaceRoot}`,
      capabilities: {},
    });
    this.#sendNotification("initialized", {});
    this.#initialized = true;
  }

  #sendNotification(method: string, params: unknown): void {
    if (!this.#process?.stdin) throw new Error("LSP server not running");
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.#process.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  #sendRequest(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!this.#process?.stdin) throw new Error("LSP server not running");
    const id = this.#nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.#process!.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  }

  #parseResponses(): void {
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const contentLengthMatch = this.#buffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) return;

      const lenStr = contentLengthMatch[1];
      if (lenStr === undefined) return;

      const len = parseInt(lenStr, 10);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.length < bodyStart + len) return;

      const body = this.#buffer.slice(bodyStart, bodyStart + len);
      this.#buffer = this.#buffer.slice(bodyStart + len);

      let msg: LspMessage;
      try {
        msg = JSON.parse(body) as LspMessage;
      } catch {
        continue;
      }

      if (msg.id === undefined) continue;

      const handler = this.#pending.get(msg.id);
      if (!handler) continue;

      this.#pending.delete(msg.id);
      if (msg.error) {
        handler.reject(new Error(`LSP error: ${msg.error.message}`));
      } else {
        handler.resolve(msg.result);
      }
    }
  }

  async openFile(filePath: string): Promise<void> {
    if (this.#openFiles.has(filePath)) return;
    const content = await readFile(filePath, "utf-8");
    this.#sendNotification("textDocument/didOpen", {
      textDocument: { uri: `file://${filePath}`, languageId: "typescript", version: 1, content },
    });
    this.#openFiles.add(filePath);
  }

  async definition(file: string, line: number, column: number): Promise<unknown> {
    await this.openFile(file);
    return this.#sendRequest("textDocument/definition", {
      textDocument: { uri: `file://${file}` },
      position: { line: line - 1, character: column - 1 },
    });
  }

  async references(file: string, line: number, column: number): Promise<unknown> {
    await this.openFile(file);
    return this.#sendRequest("textDocument/references", {
      textDocument: { uri: `file://${file}` },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: true },
    });
  }

  async hover(file: string, line: number, column: number): Promise<unknown> {
    await this.openFile(file);
    return this.#sendRequest("textDocument/hover", {
      textDocument: { uri: `file://${file}` },
      position: { line: line - 1, character: column - 1 },
    });
  }

  async symbols(query: string): Promise<unknown> {
    return this.#sendRequest("workspace/symbol", { query });
  }

  dispose(): void {
    if (this.#process) {
      this.#process.kill();
      this.#process = null;
    }
    this.#initialized = false;
    for (const pending of this.#pending.values()) pending.reject(new Error("LSP client disposed"));
    this.#pending.clear();
  }
}

const clients = new Map<string, LspClient>();

function getClient(workspaceRoot: string): LspClient {
  let client = clients.get(workspaceRoot);
  if (!client) {
    client = new LspClient(workspaceRoot);
    clients.set(workspaceRoot, client);
  }
  return client;
}

function formatDefinition(result: unknown): string {
  if (!result) return "No definition found";
  const locs: unknown[] = Array.isArray(result) ? result : [result];
  if (locs.length === 0) return "No definition found";

  return locs.map((loc) => {
    const r = loc as Record<string, unknown>;
    const uri = (r.uri ?? r.targetUri ?? "") as string;
    const range = (r.range ?? r.targetRange) as { start: { line: number; character: number } } | undefined;
    return `${uri.replace(/^file:\/\//, "")}:${(range?.start?.line ?? 0) + 1}:${(range?.start?.character ?? 0) + 1}`;
  }).join("\n");
}

async function formatReferences(result: unknown): Promise<string> {
  const locs = result as Array<{ uri: string; range: { start: { line: number; character: number } } }> | undefined;
  if (!locs || locs.length === 0) return "No references found";

  const fileCache = new Map<string, string[]>();
  const lines: string[] = [];

  for (const loc of locs) {
    const path = loc.uri.replace(/^file:\/\//, "");
    const line = loc.range.start.line + 1;
    const col = loc.range.start.character + 1;

    let contextLine = "";
    try {
      let fileLines = fileCache.get(path);
      if (!fileLines) {
        fileLines = (await readFile(path, "utf-8")).split("\n");
        fileCache.set(path, fileLines);
      }
      contextLine = fileLines[loc.range.start.line]?.trim() ?? "";
    } catch {
      // File may not be readable; omit context
    }

    lines.push(contextLine ? `${path}:${line}:${col} | ${contextLine}` : `${path}:${line}:${col}`);
  }

  return lines.join("\n");
}

function formatHover(result: unknown): string {
  if (!result) return "No hover information";
  const { contents } = result as { contents: string | { value: string } | Array<string | { value: string }> | undefined };
  if (!contents) return "No hover information";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
  }
  return contents.value;
}

function formatSymbols(result: unknown): string {
  const syms = result as Array<{
    name: string;
    kind: number;
    location: { uri: string; range: { start: { line: number } } };
  }> | undefined;
  if (!syms || syms.length === 0) return "No symbols found";

  return syms.map((sym) => {
    const kind = SYMBOL_KIND_NAME[sym.kind] ?? `Unknown(${sym.kind})`;
    const path = sym.location.uri.replace(/^file:\/\//, "");
    return `${sym.name} | ${kind} | ${path}:${sym.location.range.start.line + 1}`;
  }).join("\n");
}

export const lspTool = defineTool({
  name: "lsp",
  description:
    "Query language servers for code intelligence: jump to definition, find all references, hover type info, or search workspace symbols. Requires a running LSP server (kulmi auto-detects TypeScript).",
  schema: z.object({
    action: z.enum(["definition", "references", "hover", "symbols"]),
    file: z.string().min(1),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    symbol: z.string().optional(),
  }),
  readOnly: true,
  isParallelSafe: () => true,
  async execute(context, input) {
    const client = getClient(context.workspaceRoot);
    const { action } = input;

    try {
      await client.ensureRunning();

      if (action === "symbols") {
        if (!input.symbol) throw new Error("symbol name is required for 'symbols' action");
        return { content: formatSymbols(await client.symbols(input.symbol)) };
      }

      const filePath = await resolveWorkspacePath({
        workspaceRoot: context.workspaceRoot,
        cwd: context.cwd,
        input: input.file,
        mustExist: true,
      });

      switch (action) {
        case "definition":
          return { content: formatDefinition(await client.definition(filePath, input.line, input.column)) };
        case "references":
          return { content: await formatReferences(await client.references(filePath, input.line, input.column)) };
        case "hover":
          return { content: formatHover(await client.hover(filePath, input.line, input.column)) };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("LSP server unavailable")) throw err;
      throw new Error(`LSP ${action} failed: ${msg}`);
    }
  },
});
