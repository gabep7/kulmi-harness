import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ...(await filesUnder(resolve(root, "src"))),
  ...(await filesUnder(resolve(root, "scripts"))),
  resolve(root, "package.json"),
  resolve(root, "package-lock.json"),
  resolve(root, "tsconfig.json"),
  resolve(root, "tsconfig.build.json"),
].sort();
const hash = createHash("sha256");
for (const path of files) {
  hash.update(relative(root, path));
  hash.update("\0");
  hash.update(await readFile(path));
  hash.update("\0");
}
const fingerprint = hash.digest("hex");

if (process.argv.includes("--write")) {
  await writeFile(resolve(root, "dist", ".source-fingerprint"), `${fingerprint}\n`, "utf8");
} else {
  process.stdout.write(`${fingerprint}\n`);
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
