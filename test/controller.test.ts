import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { RunState } from "../src/core/types.js";
import { SessionController } from "../src/runtime/controller.js";
import { SessionStore } from "../src/runtime/session-store.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import type { ProviderMessage } from "../src/provider/types.js";
import { TEST_API_KEY_ENV, TEST_MODEL, TEST_MODEL_PROFILE, writeTestModelConfig } from "./helpers/test-config.js";

const exec = promisify(execFile);
const originalApiKey = process.env[TEST_API_KEY_ENV];
const originalHome = process.env.HOME;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env[TEST_API_KEY_ENV];
  else process.env[TEST_API_KEY_ENV] = originalApiKey;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("SessionController resume", () => {
  it("fails task mode before model setup outside a git worktree", async () => {
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-controller-data-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    const root = await mkdtemp(join(tmpdir(), "kulmi-controller-no-git-"));

    await expect(SessionController.create({
      cwd: root,
      mode: "task",
      autonomy: "medium",
    })).rejects.toThrow("requires a git worktree");
  });

  it("rejects resuming a transcript in another repository", async () => {
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-controller-data-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    const first = await mkdtemp(join(tmpdir(), "kulmi-controller-one-"));
    const second = await mkdtemp(join(tmpdir(), "kulmi-controller-two-"));
    await exec("git", ["init", first]);
    await exec("git", ["init", second]);
    const session = await SessionStore.create({ cwd: first, model: TEST_MODEL });

    await expect(SessionController.create({
      cwd: second,
      mode: "task",
      resumeSessionId: session.id,
    })).rejects.toThrow("belongs to");
  });

  it("preserves task mode and its prompt when the TUI resumes an empty session", async () => {
    process.env[TEST_API_KEY_ENV] = "sk-123456789";
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-controller-data-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    const root = await mkdtemp(join(tmpdir(), "kulmi-controller-task-"));
    await exec("git", ["init", root]);
    await writeTestModelConfig(root);
    const session = await SessionStore.create({
      cwd: root,
      model: TEST_MODEL,
      modelProfile: TEST_MODEL_PROFILE,
    });
    await session.saveRunState(runState("task"));

    const controller = await SessionController.create({
      cwd: root,
      mode: "chat",
      autonomy: "medium",
      resumeSessionId: session.id,
    });
    expect(controller.mode).toBe("task");
    expect(controller.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Task mode"),
    });
    await controller.close();
  });

  it("fails resuming a task session whose workspace is no longer a git worktree", async () => {
    process.env[TEST_API_KEY_ENV] = "sk-123456789";
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-controller-data-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    const root = await mkdtemp(join(tmpdir(), "kulmi-controller-task-no-git-"));
    await writeTestModelConfig(root);
    const session = await SessionStore.create({
      cwd: root,
      model: TEST_MODEL,
      modelProfile: TEST_MODEL_PROFILE,
    });
    await session.saveRunState(runState("task"));

    await expect(SessionController.create({
      cwd: root,
      mode: "chat",
      autonomy: "medium",
      resumeSessionId: session.id,
    })).rejects.toThrow("requires a git worktree");
  });

  it("rejects direct resume of a child-agent transcript", async () => {
    process.env[TEST_API_KEY_ENV] = "sk-123456789";
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-controller-data-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    const root = await mkdtemp(join(tmpdir(), "kulmi-controller-child-"));
    await exec("git", ["init", root]);
    await writeTestModelConfig(root);
    const session = await SessionStore.create({
      cwd: root,
      model: TEST_MODEL,
      modelProfile: TEST_MODEL_PROFILE,
    });
    await session.saveRunState(runState("subagent"));

    await expect(SessionController.create({
      cwd: root,
      mode: "chat",
      resumeSessionId: session.id,
    })).rejects.toThrow("child-agent transcript");
  });

  it("records an explicit chat-to-task mode transition", async () => {
    process.env[TEST_API_KEY_ENV] = "sk-123456789";
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-controller-data-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    const root = await mkdtemp(join(tmpdir(), "kulmi-controller-mode-"));
    await exec("git", ["init", root]);
    await writeTestModelConfig(root);
    const controller = await SessionController.create({
      cwd: root,
      mode: "chat",
      autonomy: "medium",
    });

    await controller.setMode("task");
    expect(controller.mode).toBe("task");
    expect(controller.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("do not call start_task"),
    });
    await controller.close();
  });

  it("fails chat-to-task promotion outside a git worktree", async () => {
    process.env[TEST_API_KEY_ENV] = "sk-123456789";
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-controller-data-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    const root = await mkdtemp(join(tmpdir(), "kulmi-controller-mode-no-git-"));
    await writeTestModelConfig(root);
    const controller = await SessionController.create({
      cwd: root,
      mode: "chat",
      autonomy: "medium",
    });

    await expect(controller.setMode("task")).rejects.toThrow("requires a git worktree");
    expect(controller.mode).toBe("chat");
    await controller.close();
  });

  it("undoes the latest turn, restores run state, and truncates active message history", async () => {
    process.env[TEST_API_KEY_ENV] = "sk-123456789";
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-controller-data-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    const root = await mkdtemp(join(tmpdir(), "kulmi-controller-undo-"));
    await exec("git", ["init", root]);
    await writeTestModelConfig(root);
    const fixture = await createUndoFixture(root);
    const controller = await SessionController.create({
      cwd: root,
      mode: "chat",
      autonomy: "medium",
      resumeSessionId: fixture.sessionId,
    });
    const events: string[] = [];
    controller.events.on((envelope) => {
      if (envelope.event.type === "session.undone") events.push(envelope.event.checkpointId);
    });

    const undone = await controller.undo();
    expect(undone).toMatchObject({
      files: ["file.txt"],
      messageHistory: "truncate",
      removedMessageCount: 2,
      state: { revision: 0, status: "idle" },
    });
    expect(undone.messages).toEqual(fixture.messagesBefore);
    expect(await readFile(fixture.file, "utf8")).toBe("before\n");
    expect(events).toEqual([undone.checkpointId]);
    await expect(controller.undo()).rejects.toThrow("no completed turn");

    const persisted = (await SessionStore.open(fixture.sessionId)).session;
    expect(persisted.messages).toEqual(fixture.messagesBefore);
    expect(persisted.state).toMatchObject({ revision: 0, status: "idle" });
    await controller.close();
  });

  it("can retain undone messages when undo.message_history is keep", async () => {
    process.env[TEST_API_KEY_ENV] = "sk-123456789";
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-controller-data-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    const root = await mkdtemp(join(tmpdir(), "kulmi-controller-undo-keep-"));
    await exec("git", ["init", root]);
    await writeTestModelConfig(root);
    await writeFile(join(root, ".kulmi", "config.toml"), `${await readFile(join(root, ".kulmi", "config.toml"), "utf8")}\n[undo]\nmessage_history = "keep"\n`);
    const fixture = await createUndoFixture(root);
    const controller = await SessionController.create({
      cwd: root,
      mode: "chat",
      autonomy: "medium",
      resumeSessionId: fixture.sessionId,
    });

    const undone = await controller.undo();
    expect(undone.messageHistory).toBe("keep");
    expect(undone.removedMessageCount).toBe(0);
    expect(undone.messages).toHaveLength(fixture.messagesAfter.length + 1);
    expect(undone.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("undo.message_history=keep"),
    });
    expect(await readFile(fixture.file, "utf8")).toBe("before\n");
    const persisted = (await SessionStore.open(fixture.sessionId)).session;
    expect(persisted.messages).toHaveLength(fixture.messagesAfter.length + 1);
    await controller.close();
  });
});

async function createUndoFixture(root: string): Promise<{
  sessionId: string;
  file: string;
  messagesBefore: ProviderMessage[];
  messagesAfter: ProviderMessage[];
}> {
  const file = join(root, "file.txt");
  await writeFile(file, "before\n");
  const session = await SessionStore.create({
    cwd: root,
    model: TEST_MODEL,
    modelProfile: TEST_MODEL_PROFILE,
  });
  const before = runState("task");
  const messagesBefore: ProviderMessage[] = [{ role: "system", content: "stable contract" }];
  const messagesAfter: ProviderMessage[] = [
    ...messagesBefore,
    { role: "user", content: "change the file" },
    { role: "assistant", content: "changed" },
  ];
  await session.saveMessages(messagesBefore);
  await session.saveRunState(before);
  const checkpoints = new CheckpointStore(session.path, root);
  await checkpoints.beginTurn(messagesBefore.length, before.agentId, before);
  await checkpoints.capture(file);
  await writeFile(file, "after\n");
  await checkpoints.finalizeTurn();
  await session.saveMessages(messagesAfter);
  await session.saveRunState({
    ...before,
    status: "completed",
    modifiedFiles: new Set(["file.txt"]),
    revision: 1,
  });
  await session.close("completed");
  return { sessionId: session.id, file, messagesBefore, messagesAfter };
}

function runState(mode: RunState["mode"]): RunState {
  return {
    agentId: "agent_test",
    mode,
    status: "idle",
    plan: [],
    modifiedFiles: new Set(),
    verifications: [],
    revision: 0,
  };
}
