import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export function safeChildEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "kulmi-sandbox-"));
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(temporary, { mode: 0o700 });
  const safePath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry && isAbsolute(entry))
    .join(delimiter);
  const env: NodeJS.ProcessEnv = {
    PATH: safePath,
    HOME: home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: temporary,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    SYSTEMROOT: process.env.SYSTEMROOT,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    TERM: "dumb",
    KULMI_SANDBOX_ROOT: root,
    KULMI_SANDBOX_HOME: home,
    KULMI_SANDBOX_TMP: temporary,
    ...extra,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

export function disposeChildEnvironment(env: NodeJS.ProcessEnv): void {
  const root = env.KULMI_SANDBOX_ROOT;
  if (root?.startsWith(join(tmpdir(), "kulmi-sandbox-"))) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A dying child can still be writing here; leave the dir to OS temp cleanup
      // rather than failing an otherwise successful run.
    }
  }
}
