# Kulmi

Kulmi is a general-purpose autonomous coding harness with a fast full-screen terminal interface and a headless TypeScript kernel. It works with any OpenAI-compatible API provider and with the Anthropic Messages API. Configure model profiles in `config.toml` to point at your provider, set the API key, and go.

The default provider adapter talks to any OpenAI-compatible `/v1/chat/completions` endpoint. It preserves streamed `reasoning_content`, fully replays reasoning on assistant tool-call turns, uses `max_completion_tokens`, records prompt cache and reasoning usage, and handles web citations and search billing telemetry. Setting `protocol = "anthropic"` on a model profile switches that profile to a native Messages API adapter with `cache_control` breakpoints, thinking blocks with round-tripped signatures, merged tool results, and the same streaming and retry envelope.

## Requirements

- macOS or Linux
- Node.js 22+
- npm
- Git
- Linux only: `bubblewrap`, providing a working `bwrap` command with permission to create unprivileged user and network namespaces
- An API key for your model provider. The first-run terminal setup can store it in the system keychain.

## Install

From a public release:

```sh
curl -fsSL https://raw.githubusercontent.com/gabep7/kulmi-harness/master/install.sh | KULMI_INSTALL_REMOTE=1 sh
```

From this checkout, install Kulmi into `~/.local/lib/kulmi` with a `kulmi` command in `~/.local/bin`:

```sh
./install.sh
```

The default local-checkout install is a development link. It reuses the checkout's dependencies, rebuilds only when a source file is newer than `dist/cli.js`, and atomically links `~/.local/bin/kulmi`. With an up-to-date build it normally finishes almost immediately. Executable files live under `~/.local/lib/kulmi`; sessions and user data remain separately under `~/.local/share/kulmi`. It also adds `~/.local/bin` to the appropriate shell profile when necessary and never uses `sudo` or npm's global prefix.

For a clean, independent production-style copy instead:

```sh
./install.sh --copy
```

Copy mode installs from the lockfile, builds in a temporary directory, prunes development dependencies, and atomically replaces the previous installation. It is intentionally slower. Use it for a durable release installation rather than the edit-build-run loop.

To install a different local checkout explicitly:

```sh
KULMI_INSTALL_SOURCE="$PWD" ./install.sh
```

For a private fork or private repository, an authenticated GitHub CLI can fetch the installer:

```sh
gh api --hostname github.com repos/gabep7/kulmi-harness/contents/install.sh \
  -H "Accept: application/vnd.github.raw+json" \
  | KULMI_INSTALL_REMOTE=1 sh
```

Kulmi is not published to npm yet, so `./install.sh` uses the local checkout when invoked from a source tree. Tagged releases include a prebuilt `kulmi-node.tar.gz` containing `dist` and production dependencies, plus `kulmi-node.tar.gz.sha256`. Remote installs verify the checksum before extraction and fail closed if it is missing, malformed, or mismatched. They use plain `curl` for public repositories and an authenticated `gh` session for private ones, and fall back to a source archive only when the prebuilt asset is unavailable. Select releases through `KULMI_REPOSITORY` and `KULMI_INSTALL_VERSION`. Custom mirrors use `KULMI_RELEASE_URL`; its checksum defaults to the same URL plus `.sha256` and can be overridden with `KULMI_RELEASE_CHECKSUM_URL`.

Then start Kulmi:

```sh
kulmi
```

On first run you need a model profile. Create one with:

```sh
kulmi init
```

Then edit `~/.config/kulmi/config.toml` or `.kulmi/config.toml` and define a profile:

```toml
default_model = "my-model"

[models.my-model]
model = "your-model-id"
base_url = "https://api.example.com/v1"
api_key_env = "MY_PROVIDER_API_KEY"
thinking = false
context_window = 128000
max_output_tokens = 16384
```

Set the env var named by `api_key_env`, or store a key with `kulmi auth`.

```sh
export MY_PROVIDER_API_KEY=...
kulmi
```

## Develop from source

```sh
npm install
npm run build
export MY_PROVIDER_API_KEY=...
npm run dev
```

Run `./install.sh` when you want the current checkout available globally as `kulmi` without relying on npm's global prefix.

```sh
kulmi init
kulmi exec --auto medium "fix the failing tests and verify the result"
kulmi exec --web-search off "work without web access"
kulmi exec --web-search free "research the current API before editing"
kulmi doctor
```

Project or user configuration can control the command sandbox and undo transcript behavior:

```toml
[sandbox]
mode = "required" # required or off
network = false

default_autonomy = "trusted"
# Shift+Tab cycles the active autonomy level in the TUI.

[undo]
message_history = "truncate" # truncate or keep
```

The safe defaults require an available OS sandbox, deny command network access, and remove the undone turn from the active model and UI transcript. `keep` preserves the undone messages and appends an explicit marker telling the model that their file changes were reverted. `off` runs project commands without OS containment and should only be used deliberately.

On Ubuntu systems that restrict unprivileged user namespaces through AppArmor, `bwrap` can be installed but unusable. `kulmi doctor` performs a real namespace probe and reports this state. Configure an administrator-approved AppArmor exception for `bwrap`; do not disable Kulmi's sandbox merely to bypass the check.

Running `kulmi` opens the responsive TUI. Running `kulmi exec` keeps the stable headless interface for scripts and CI.

Chat starts with only the task-promotion schema, so greetings and direct questions do not pay for the full coding-tool catalog. A normal request that needs files, commands, edits, or research promotes itself and receives the full tools on the next model turn. `/goal` performs the same promotion explicitly.

## Terminal interface

The interface deliberately keeps the transcript dominant. Tool activity is compressed into one-line status rows; reasoning is collapsed unless requested; plan and worker state appear in a right rail on wider terminals and disappear cleanly on narrow terminals. Model deltas are coalesced at roughly 30 FPS to avoid a render for every streamed token.

Controls:

- `Esc` stops the active run.
- `Ctrl+O` expands or collapses the current thinking stream.
- `Ctrl+C` stops an active run, or exits while idle.
- `Shift+Tab` cycles autonomy: `read`, `low`, `medium`, `high`, then `trusted`.
- `?` opens the compact command and shortcut guide.
- `/sessions` opens a keyboard picker for durable sessions in the current workspace.
- `/fork` creates an independent continuation.
- `/undo` restores the workspace, run state, and transcript boundary from before the previous completed turn.
- `/workers` shows child agents.
- `/steer`, `/cancel`, `/retry`, and `/integrate` control workers without leaving the TUI.
- `/status` shows the model, autonomy, session, and workspace.
- `/model` lists model profiles; `/model <name>` switches the session's model in place.
- Typing while a run is active and pressing Enter steers the root agent mid-run; the message is injected at the next step boundary.
- Custom slash commands are discovered from `.kulmi/commands/*.md` and `~/.config/kulmi/commands/*.md`; the file body is a prompt template and `$ARGUMENTS` expands to whatever follows the command name. Built-in commands take precedence.

Resume directly into the TUI with:

```sh
kulmi --session-id session_0123456789abcdef
```

The footer shows autonomy, free-search state, cumulative tokens, and cache-hit rate. While a run is active, a status line above the composer rotates a shuffled spinner through messages such as `selling your data`, `barking up the wrong tree`, `opening a can of worms`, and `mining bitcoin briefly`. Risky commands replace the composer with an explicit allow-once, allow-always, or deny prompt. Pressing Enter without choosing defaults to denial. Allow-always persists a per-workspace command-prefix entry to a user-level allowlist and auto-approves future matches; high-risk requests are never auto-approved and never offered the option.

Headless sessions can be undone with `kulmi undo <session-id>`. JSON-RPC clients use `session.undo` and receive the restored messages and run state in the response.

Search modes:

- `off` exposes no network search or fetch tools.
- `free` exposes `web_search` and the SSRF-protected `fetch_url` tool. It uses a self-hosted SearXNG instance when configured, otherwise it falls back to Bing's keyless personal-use RSS results.

## Runtime architecture

```text
TUI / CLI / JSON-RPC
          |
  SessionController
          |
 Agent loop + durable state
    /          |          \
Provider    Tool gate    Subagent scheduler
adapter                  + isolated worktrees
```

The runtime is headless. The TUI and CLI only send commands and render events. They do not own sessions, permissions, tools, prompts, worker state, or provider credentials.

Explore and review subagents are read-only and may share the checkout. Implement subagents receive isolated Git worktrees. Built-in worker presets are `tester`, `reviewer`, `security`, `performance`, and `release`; they are compact routing hints over the same three execution modes, not always-on extra agents. Worker state and child transcripts are durable. Integration is explicit and rejects overlapping changes.

Running workers can be redirected with `steer_agent`. Failed or interrupted workers can be retried as new durable jobs. Local skills are discovered from `.kulmi/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`, and `~/.config/kulmi/skills/*/SKILL.md`; their compact inventory stays in the stable prompt and full instructions are loaded only when needed.

## Persistent processes

`start_process` runs a named long-lived command, such as a dev server or test watcher, outside the one-shot sandbox so it can bind ports and keep state across turns. It always requires interactive approval when a permission channel exists, applies the same shell policy blocklist, and uses the safe child environment with process-group control. `process_logs` reads the bounded output ring buffer with optional regex filtering, `send_process_input` writes stdin or sends signals, `stop_process` terminates gracefully then hard-kills, and `list_processes` shows what is running. All processes die with the session.

## MCP servers

Kulmi is an MCP client. Declare stdio servers in `config.toml`:

```toml
[mcp.servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

Each server's tools appear to the agent as `mcp_<server>_<tool>` with the server's own input schema preserved. A server that fails to start is reported as a notice without blocking the session, and read-only workers only receive tools the server annotates as read-only.

## Memory

Kulmi discovers memory files from `.kulmi/memory/*.md`, `.agents/memory/*.md`, and `~/.config/kulmi/memory/*.md`. Each file is a durable fact, decision, or preference the agent should remember across sessions. When names collide, `.kulmi` overrides `.agents`, which overrides the user directory. The memory inventory appears in the system prompt as a compact, size-capped list sorted by importance; full content loads on demand via the `read_memory` tool, and `list_memory` filters by tag. The agent stores new durable facts itself with `save_memory`, which writes `.kulmi/memory/<name>.md` and participates in undo like any other file write. Unreadable or oversized files are skipped rather than failing discovery. Use memory for project decisions, user preferences, architectural context, and recurring patterns. Memory is distinct from skills (workflow instructions) and rules (enforced constraints).

Memory files support optional YAML frontmatter:

```markdown
---
name: architecture
tags: stack, api
importance: high
preview: Core stack and service boundaries.
---
The project uses Postgres and Redis.
```

`name` must start alphanumeric and use only letters, digits, dots, dashes, and underscores; without frontmatter, the first heading or the filename is used and slugified. `tags` are comma-separated and matched case-insensitively. `importance` is `low`, `normal`, or `high` and controls inventory ordering. `preview` overrides the auto-extracted first paragraph shown in inventories.

## Git workflow

Git workflow tools list, read, and resolve merge conflicts, then stage the resolved file. `commit_changes` creates local commits from inside the harness and never pushes. `create_pull_request` pushes the current branch to origin and opens a PR through the `gh` CLI; it always requires explicit approval, refuses detached HEADs and branches with nothing to publish, and never force-pushes. Browser QA can open a URL in headless Chromium and store screenshots as session attachments when Chrome/Chromium is available. Prompts can attach images with `@image path/to/image.png`.

`kulmi fork <session-id>` creates an independent continuation without mutating the source session. Interactive shell commands include `/help`, `/status`, `/sessions`, and `/loop <task>`.

## Cache contract

Prompt caching is automatic and prefix-based on supported providers. Kulmi optimizes it by keeping the system message byte-stable, sorting tools canonically, canonicalizing every JSON schema, preserving message and tool-result order, and appending volatile state only at the conversation tail. Chat and task mode use separate cache scopes so the one deliberate tool-catalog expansion cannot invalidate either stable prefix. Compaction happens only near the context boundary and only at a complete message boundary. Large tool output is stored as a retrievable artifact with a bounded preview, and state-changing tools return compact acknowledgements instead of duplicating state into the next fresh prompt tail.

Configured `tool_pre` hooks run before tool execution and can block a tool by exiting nonzero. `tool_post` hooks run after tool execution; failures are reported as runtime errors without replacing the original tool result. Hooks are plain project commands with safe environment, timeout, and bounded output, not a plugin system.

Providers that report cache reads through `usage.prompt_tokens_details.cached_tokens` are fully supported. Kulmi reports cached and fresh tokens independently for every request.

## Safety and persistence

Autonomy levels are `read`, `low`, `medium`, `high`, and `trusted`. The shell policy blocks deletion, privilege escalation, remote publication, unsafe redirects, nested shells, dynamic interpreters, and credential exposure. Model-controlled processes receive a minimal environment, isolated home and temporary directory, closed stdin, timeout, bounded output, process-group cancellation, and secret redaction.

OS containment is required by default. On macOS, Kulmi uses the built-in Seatbelt runner through `sandbox-exec` with a deny-by-default profile. On Linux, it uses Bubblewrap with an empty mount namespace and user, IPC, PID, UTS, cgroup, and network namespaces. Both expose system and selected toolchain paths read-only, expose the workspace and private sandbox temporary directory as writable, deny writes to `.git`, and deny network access unless `sandbox.network=true`. Kulmi fails closed when the required backend is unavailable. Apple marks `sandbox-exec` as deprecated, but it remains the only built-in process-level profile runner on supported macOS releases; `kulmi doctor` reports backend availability.

Sessions persist versioned, validated messages, events, run state, checkpoints, artifacts, worker jobs, model profile, and completion evidence. Existing unversioned sessions migrate on open. Interrupted assistant tool-call turns are repaired with an explicit uncertain result instead of replaying a potentially non-idempotent action. Task completion requires an evidence-backed plan and, for modified work, an explicit successful current-revision verification command covering the changed files.

Every root turn records its pre-turn run state and before-and-after file snapshots. Undo validates that no file changed externally after the turn, restores contents and permissions atomically per file, removes files created by the turn, restores plan and verification state, and advances the cache epoch if the active transcript changes. A durable undo journal lets an interrupted undo resume safely. Undo is blocked while child-agent work remains pending.

File edits, replacements, and deletions require a current read hash. `edit_files` preflights multiple exact replacements across already-read files, then applies them as one revision and rolls back completed writes if a later write fails. When exact text matching fails, a single whitespace-tolerant fallback applies only on an unambiguous unique match and the result is labeled so the model knows the match was not verbatim. Successful edits to source files append compact LSP error diagnostics to the tool result within a bounded time budget, so the model sees the type errors it just introduced without a build round trip. File edits, writes, deletions, and shell-created changes emit bounded redacted unified diffs to clients. Shell tracking also records permission-only changes. No-op writes do not advance the workspace revision or invalidate accepted completion evidence.

## Development

```sh
npm run check
```

With a real key, `npm run test:live` performs a low-output two-request smoke test covering thinking, tool-call reasoning replay, tool-result pairing, streaming, and cache telemetry. It is not part of `npm run check` because it incurs provider usage.

`npm run eval` runs the SWE-style eval suite under `evals/`: each task copies a fixture repo to a temporary directory, runs `kulmi exec` against a prompt, and judges the result solely by the task's verify command. Use it to regression-test harness changes; `KULMI_EVAL_BIN` swaps the executable under test and `KULMI_EVAL_MODEL` selects the model profile.

The release gate and tag procedure is in [docs/releasing.md](docs/releasing.md).

## Design references

- [Bubblewrap](https://github.com/containers/bubblewrap)
- [macOS sandbox-exec manual](https://keith.github.io/xcode-manual-pages/sandbox-exec.1.html)
- [Pi](https://github.com/badlogic/pi-mono)
- [Oh My Pi](https://github.com/can1357/oh-my-pi)
- [OpenCode](https://github.com/anomalyco/opencode)