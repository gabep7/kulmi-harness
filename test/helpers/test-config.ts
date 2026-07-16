import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TEST_MODEL = "test-model";
export const TEST_MODEL_PROFILE = "test";
export const TEST_API_KEY_ENV = "KULMI_TEST_API_KEY";

export async function writeTestModelConfig(root: string, options: {
  model?: string;
  profile?: string;
  apiKeyEnv?: string;
} = {}): Promise<void> {
  const model = options.model ?? TEST_MODEL;
  const profile = options.profile ?? TEST_MODEL_PROFILE;
  const apiKeyEnv = options.apiKeyEnv ?? TEST_API_KEY_ENV;
  await mkdir(join(root, ".kulmi"), { recursive: true });
  await writeFile(join(root, ".kulmi", "config.toml"), `# test config
default_model = "${profile}"

[models.${profile}]
model = "${model}"
base_url = "https://example.test/v1"
api_key_env = "${apiKeyEnv}"
thinking = false
context_window = 128000
max_output_tokens = 16384
`, "utf8");
}
