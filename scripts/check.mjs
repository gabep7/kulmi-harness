#!/usr/bin/env node
import { spawn } from "node:child_process";

await run("node", ["scripts/check-version.mjs"]);
await Promise.all([
  run("npm", ["run", "typecheck"]),
  run("npm", ["test"]),
]);
await run("npm", ["run", "build"]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`));
    });
  });
}
