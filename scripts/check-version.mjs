import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const versionSource = await readFile(resolve(root, "src", "core", "version.ts"), "utf8");
const sourceVersion = versionSource.match(/export const VERSION = "([^"]+)";/)?.[1];

if (!sourceVersion) throw new Error("could not read VERSION from src/core/version.ts");
if (sourceVersion !== packageJson.version) {
  throw new Error(`version mismatch: package.json=${packageJson.version}, src/core/version.ts=${sourceVersion}`);
}
