import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export function safeChildEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "kulmi-sandbox-home-"));
  const safePath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry && isAbsolute(entry))
    .join(delimiter);
  const env: NodeJS.ProcessEnv = {
    PATH: safePath,
    HOME: home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    SYSTEMROOT: process.env.SYSTEMROOT,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    TERM: "dumb",
    KULMI_SANDBOX_HOME: home,
    ...extra,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

export function disposeChildEnvironment(env: NodeJS.ProcessEnv): void {
  const home = env.KULMI_SANDBOX_HOME;
  if (home?.startsWith(join(tmpdir(), "kulmi-sandbox-home-"))) {
    rmSync(home, { recursive: true, force: true });
  }
}
