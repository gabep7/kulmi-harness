import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SessionController } from "../src/runtime/controller.js";
import { SessionStore } from "../src/runtime/session-store.js";

const exec = promisify(execFile);

describe("SessionController resume", () => {
  it("rejects resuming a transcript in another repository", async () => {
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-controller-data-"));
    const first = await mkdtemp(join(tmpdir(), "kulmi-controller-one-"));
    const second = await mkdtemp(join(tmpdir(), "kulmi-controller-two-"));
    await exec("git", ["init", first]);
    await exec("git", ["init", second]);
    const session = await SessionStore.create({ cwd: first, model: "mimo-v2.5-pro" });

    await expect(SessionController.create({
      cwd: second,
      mode: "task",
      resumeSessionId: session.id,
    })).rejects.toThrow("belongs to");
  });
});
