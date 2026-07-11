import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
let fixtures: string;
let binaries: string;
let releaseArchive: string;
let sourceArchive: string;
let validChecksum: string;

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "kulmi-installer-fixtures-"));
  binaries = join(fixtures, "bin");
  await mkdir(binaries);

  const release = join(fixtures, "release");
  await mkdir(join(release, "dist"), { recursive: true });
  await mkdir(join(release, "node_modules"), { recursive: true });
  await writeFile(join(release, "dist", "cli.js"), "#!/usr/bin/env node\n", "utf8");
  await writeFile(join(release, "node_modules", ".keep"), "fixture\n", "utf8");
  releaseArchive = join(fixtures, "kulmi-node.tar.gz");
  await exec("tar", ["-czf", releaseArchive, "-C", release, "."]);
  validChecksum = createHash("sha256").update(await readFile(releaseArchive)).digest("hex");

  const sourceParent = join(fixtures, "source");
  const source = join(sourceParent, "kulmi-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "package.json"), '{"name":"kulmi-source-fixture"}\n', "utf8");
  sourceArchive = join(fixtures, "kulmi-source.tar.gz");
  await exec("tar", ["-czf", sourceArchive, "-C", sourceParent, "kulmi-source"]);

  await executable("uname", "#!/bin/sh\nprintf '%s\\n' Linux\n");
  await executable("bwrap", "#!/bin/sh\nexit 0\n");
  await executable("gh", "#!/bin/sh\nexit 1\n");
  await executable("npm", [
    "#!/bin/sh",
    "case \"$*\" in",
    "  *\"run build\"*) mkdir -p dist; printf '#!/usr/bin/env node\\n' > dist/cli.js ;;",
    "  *\"ci\"*) mkdir -p node_modules; printf fixture > node_modules/.keep ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  await executable("curl", [
    "#!/bin/sh",
    "destination=",
    "write_out=0",
    "url=",
    "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in",
    "    --output|-o) destination=$2; shift 2 ;;",
    "    --write-out) write_out=1; shift 2 ;;",
    "    --fail|--location|--silent|--show-error) shift ;;",
    "    *) url=$1; shift ;;",
    "  esac",
    "done",
    "printf '%s\\n' \"$url\" >> \"$FAKE_CURL_LOG\"",
    "if [ \"$url\" = \"$KULMI_RELEASE_URL\" ]; then",
    "  if [ \"$FAKE_RELEASE_STATUS\" = missing ]; then [ \"$write_out\" -eq 0 ] || printf 404; exit 22; fi",
    "  cp \"$FAKE_RELEASE_ARCHIVE\" \"$destination\"",
    "elif [ \"$url\" = \"$KULMI_RELEASE_CHECKSUM_URL\" ]; then",
    "  if [ \"$FAKE_CHECKSUM_STATUS\" = missing ]; then [ \"$write_out\" -eq 0 ] || printf 404; exit 22; fi",
    "  printf '%s\\n' \"$FAKE_CHECKSUM\" > \"$destination\"",
    "else",
    "  cp \"$FAKE_SOURCE_ARCHIVE\" \"$destination\"",
    "fi",
    "[ \"$write_out\" -eq 0 ] || printf 200",
    "",
  ].join("\n"));
});

afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
});

describe.sequential("remote installer release integrity", () => {
  it.each([
    { name: "valid", checksumStatus: "present", checksum: () => validChecksum, success: true, error: "" },
    { name: "missing", checksumStatus: "missing", checksum: () => validChecksum, success: false, error: "release checksum is missing" },
    { name: "malformed", checksumStatus: "present", checksum: () => "not-a-sha256", success: false, error: "release checksum is malformed" },
    { name: "mismatched", checksumStatus: "present", checksum: () => "0".repeat(64), success: false, error: "release checksum mismatch" },
  ] as const)("handles a $name release checksum", async ({ name, checksumStatus, checksum, success, error }) => {
    const result = await runInstaller({ checksumStatus, checksum: checksum() });
    try {
      expect(result.ok).toBe(success);
      if (success) {
        expect(await readFile(join(result.install, "dist", "cli.js"), "utf8")).toBe("#!/usr/bin/env node\n");
      } else {
        expect(result.stderr).toContain(error);
      }
      expect(await readFile(result.log, "utf8")).not.toContain("/archive/");
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });

  it("falls back to source only when the release archive is absent", async () => {
    const result = await runInstaller({
      releaseStatus: "missing",
      checksumStatus: "present",
      checksum: validChecksum,
    });
    try {
      expect(result.ok, result.stderr).toBe(true);
      expect(result.stdout).toContain("No prebuilt release found; falling back to source");
      expect(await readFile(join(result.install, "dist", "cli.js"), "utf8")).toBe("#!/usr/bin/env node\n");
      expect(await readFile(result.log, "utf8")).toContain("/archive/");
    } finally {
      await rm(result.root, { recursive: true, force: true });
    }
  });
});

async function executable(name: string, content: string): Promise<void> {
  const path = join(binaries, name);
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function runInstaller(options: {
  releaseStatus?: "present" | "missing";
  checksumStatus: "present" | "missing";
  checksum: string;
}): Promise<{ root: string; install: string; log: string; ok: boolean; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "kulmi-installer-case-"));
  const install = join(root, "install");
  const log = join(root, "curl.log");
  await writeFile(log, "", "utf8");
  try {
    const { stdout, stderr } = await exec("/bin/sh", [resolve("install.sh")], {
      cwd: resolve("."),
      env: {
        ...process.env,
        PATH: `${binaries}:${process.env.PATH ?? ""}`,
        HOME: join(root, "home"),
        KULMI_INSTALL_REMOTE: "1",
        KULMI_INSTALL_MODE: "copy",
        KULMI_INSTALL_VERSION: "v-test",
        KULMI_INSTALL_DIR: install,
        KULMI_BIN_DIR: join(root, "bin"),
        KULMI_NO_PATH_UPDATE: "1",
        KULMI_RELEASE_URL: "https://fixtures.test/kulmi-node.tar.gz",
        KULMI_RELEASE_CHECKSUM_URL: "https://fixtures.test/kulmi-node.tar.gz.sha256",
        FAKE_CURL_LOG: log,
        FAKE_RELEASE_ARCHIVE: releaseArchive,
        FAKE_SOURCE_ARCHIVE: sourceArchive,
        FAKE_RELEASE_STATUS: options.releaseStatus ?? "present",
        FAKE_CHECKSUM_STATUS: options.checksumStatus,
        FAKE_CHECKSUM: options.checksum,
      },
    });
    return { root, install, log, ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return { root, install, log, ok: false, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
  }
}
