import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { decideCommand } from "../src/security/policy.js";

const exec = promisify(execFile);

// The policy reimplements a subset of bash's grammar to decide what a command
// string will run, and `runShell` then hands that string to `/bin/bash -c`.
// Every place the two disagree is a potential bypass, and enumerating known
// tricks only ever catches the ones somebody already thought of. These tests
// use bash itself as the oracle: run the candidate in a jail with an empty PATH
// so no external program can execute, ask bash what it would have run, and
// require the policy's verdict to account for it.
const DANGEROUS = ["rm", "curl", "wget", "sudo", "nc", "ssh", "scp", "chmod", "chown", "dd"];

interface Observation {
  programs: string[];
  wrote: boolean;
}

async function fingerprint(dir: string): Promise<string> {
  const names = (await readdir(dir, { recursive: true })).sort();
  const entries = await Promise.all(names.map(async (name) => {
    const info = await stat(join(dir, name));
    return `${name}:${info.size}:${info.mtimeMs}`;
  }));
  return entries.join("|");
}

async function observe(command: string): Promise<Observation> {
  const jail = await mkdtemp(join(tmpdir(), "kulmi-oracle-"));
  const bin = join(jail, "bin");
  await mkdir(bin);
  await writeFile(join(jail, "seed.txt"), "seed\n");
  const before = await fingerprint(jail);
  let trace = "";
  try {
    // -x traces every simple command before bash attempts it, so the trace is a
    // faithful list of what would run even though the empty PATH makes each
    // external lookup fail.
    const result = await exec("/bin/bash", ["--noprofile", "--norc", "-x", "-c", command], {
      cwd: jail,
      env: { PATH: bin, HOME: jail },
      timeout: 5_000,
    });
    trace = result.stderr;
  } catch (error) {
    // A nonzero exit is expected: the empty PATH makes every external lookup
    // fail. The trace on stderr is still exactly what we came for.
    if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
      trace = error.stderr;
    }
  }
  const programs = trace.split("\n").flatMap((line) => {
    const match = /^\++ (\S+)/.exec(line);
    return match ? [match[1]!.replace(/^.*\//, "")] : [];
  });
  return { programs, wrote: (await fingerprint(jail)) !== before };
}

describe("shell policy differential", () => {
  it("observes what bash really runs, so the corpus below cannot go vacuous", async () => {
    const newline = await observe("cat seed.txt\nrm -rf victim");
    expect(newline.programs).toEqual(["cat", "rm"]);
    const redirect = await observe("cat seed.txt &> out.txt");
    expect(redirect.wrote).toBe(true);
  });

  it.each([
    "\n", "\r\n", "\n\n", ";", "&&", "||", "|", "&", " & ", ";;", "|&",
    "\n# trailing comment\n", " \n ", "\t\n", ";\n", "&\n", "\n;", "\\\n", "&&\n", "\n&&\n",
  ])("never allows a blocked program to run behind separator %j", async (separator) => {
    const command = `cat seed.txt${separator}rm -rf victim`;
    const decision = decideCommand(command, "read", process.cwd());
    if (!decision.allowed) return;
    const { programs } = await observe(command);
    expect(programs.filter((program) => DANGEROUS.includes(program))).toEqual([]);
  });

  it.each([
    ">", ">>", "&>", "&>>", ">|", "1>", "2>", ">&", "1>>", "&> ",
  ])("never lets a read-risk command write to disk through %j", async (redirect) => {
    for (const command of [
      `cat seed.txt ${redirect} out.txt`,
      `cat seed.txt${redirect}out.txt`,
      `cat seed.txt\n${redirect} out.txt`,
    ]) {
      const decision = decideCommand(command, "read", process.cwd());
      if (!decision.allowed) continue;
      const { wrote } = await observe(command);
      expect(wrote, `${JSON.stringify(command)} was allowed at read autonomy`).toBe(false);
    }
  });
});
