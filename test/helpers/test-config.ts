import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TEST_MODEL = "test-model";
export const TEST_MODEL_PROFILE = "test";
export const TEST_API_KEY_ENV = "KULMI_TEST_API_KEY";

// Remote model profiles are a user-config concern. Project config may only add
// loopback base_url models, so tests that need a normal remote profile write
// under $HOME/.config/kulmi instead of the workspace .kulmi directory.
export async function writeTestModelConfig(_root: string, options: {
  model?: string;
  profile?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
} = {}): Promise<void> {
  const home = process.env.HOME;
  if (!home) throw new Error("writeTestModelConfig requires process.env.HOME");
  const model = options.model ?? TEST_MODEL;
  const profile = options.profile ?? TEST_MODEL_PROFILE;
  const apiKeyEnv = options.apiKeyEnv ?? TEST_API_KEY_ENV;
  const baseUrl = options.baseUrl ?? "https://example.test/v1";
  const configDir = join(home, ".config", "kulmi");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.toml"), `# test config
default_model = "${profile}"

[models.${profile}]
model = "${model}"
base_url = "${baseUrl}"
api_key_env = "${apiKeyEnv}"
thinking = false
context_window = 128000
max_output_tokens = 16384
`, "utf8");
}
