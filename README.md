# Kulmi

Kulmi is a general-purpose autonomous coding harness with a fast full-screen terminal interface and a headless TypeScript kernel. It works with any OpenAI-compatible API provider and with the Anthropic Messages API. Configure model profiles in `config.toml` to point at your provider, set the API key, and go.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Configuration](#configuration)
- [Terminal interface](#terminal-interface)
- [Headless use](#headless-use)
- [Providers](#providers)
- [Autonomy and search](#autonomy-and-search)
- [Architecture](#architecture)
- [Subagents](#subagents)
- [Memory](#memory)
- [Skills](#skills)
- [Persistent processes](#persistent-processes)
- [MCP servers](#mcp-servers)
- [Git workflow](#git-workflow)
- [Hooks](#hooks)
- [Sandboxing and shell policy](#sandboxing-and-shell-policy)
- [Persistence and undo](#persistence-and-undo)
- [File editing](#file-editing)
- [Prompt caching](#prompt-caching)
- [Development](#development)
- [Design references](#design-references)

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
curl -fsSL https://raw.githubusercontent.com/gabep7/kulmi-harness/main/install.sh | KULMI_INSTALL_REMOTE=1 sh
```

From this checkout, installing into `~/.local/lib/kulmi` with a `kulmi` command in `~/.local/bin`:

```sh
./install.sh
```

Executables live under `~/.local/lib/kulmi`. Sessions and user data live separately under `~/.local/share/kulmi`. The installer adds `~/.local/bin` to the appropriate shell profile when necessary, and never uses `sudo` or npm's global prefix.

### Install modes

The default local-checkout install is a development link. It reuses the checkout's dependencies, rebuilds only when a source file is newer than `dist/cli.js`, and atomically links `~/.local/bin/kulmi`. With an up-to-date build it normally finishes almost immediately.

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

### Release artifacts

Kulmi is not published to npm yet, so `./install.sh` uses the local checkout when invoked from a source tree.

Tagged releases include a prebuilt `kulmi-node.tar.gz` containing `dist` and production dependencies, plus `kulmi-node.tar.gz.sha256`. Remote installs verify the checksum before extraction and fail closed if it is missing, malformed, or mismatched. They use plain `curl` for public repositories and an authenticated `gh` session for private ones, and fall back to a source archive only when the prebuilt asset is unavailable.

| Variable | Purpose |
| --- | --- |
| `KULMI_REPOSITORY` | Select the source repository |
| `KULMI_INSTALL_VERSION` | Select the release version |
| `KULMI_RELEASE_URL` | Custom mirror for the release archive |
| `KULMI_RELEASE_CHECKSUM_URL` | Override the checksum URL, which otherwise defaults to `KULMI_RELEASE_URL` plus `.sha256` |

## First run

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
reasoning_style = "none" # openai-o, reasoning_content, anthropic-thinking, or none
context_window = 128000
max_output_tokens = 16384
```

Set the env var named by `api_key_env`, or store a key with `kulmi auth`:

```sh
export MY_PROVIDER_API_KEY=...
kulmi
```

## Configuration

Kulmi reads two configuration files, in order: `~/.config/kulmi/config.toml` (user) then `<workspace>/.kulmi/config.toml` (project).

### Privileged settings are user-level only

Settings that change containment, autonomy, credentials, or the code-execution surface can only be set in user configuration. A project `.kulmi/config.toml` cannot set them, because a cloned repository must not be able to weaken the sandbox or exfiltrate API keys and transcripts. Those keys are ignored with a warning naming them.

| Key | Where it may be set |
| --- | --- |
| `sandbox.mode`, `sandbox.network` | User only |
| `default_autonomy` | User only |
| `hooks.tool_pre`, `hooks.tool_post` | User only |
| `mcp.servers.*` | User only |
| `search.provider`, `search.searxng_url` | User only |
| remote `models.*.base_url` and `models.*.api_key_env` | User only |
| loopback-only project model profiles (`localhost`, `127.0.0.1`, `::1`) | User or project |
| `search.mode`, `search.result_limit`, `undo.*`, `max_steps`, `max_subagents`, `command_timeout_seconds`, `max_output_bytes` | User or project |

Project config also cannot override an existing user model profile by name, and cannot change `default_model` when the user already chose one. Remote model endpoints stay in user config.

### Sandbox and undo

```toml
# ~/.config/kulmi/config.toml
[sandbox]
mode = "required" # required or off
network = false

default_autonomy = "trusted"

[undo]
message_history = "truncate" # truncate or keep
```

The safe defaults require an available OS sandbox, deny command network access, and remove the undone turn from the active model and UI transcript.

- `undo.message_history = "keep"` preserves the undone messages and appends an explicit marker telling the model that their file changes were reverted.
- `sandbox.mode = "off"` runs project commands without OS containment. Use it deliberately, and only in user configuration.

On Ubuntu systems that restrict unprivileged user namespaces through AppArmor, `bwrap` can be installed but unusable. `kulmi doctor` performs a real namespace probe and reports this state. Configure an administrator-approved AppArmor exception for `bwrap`. Do not disable Kulmi's sandbox merely to bypass the check.

### Defaults

The built-in defaults are `max_steps = 200`, `max_subagents = 3`, `command_timeout_seconds = 120`, and `max_output_bytes = 524288` (512 KB). The default autonomy for `kulmi` and `kulmi exec` is `medium`, so a headless run can run tests and project scripts without an extra flag. Override any of these in user or project configuration, except for the privileged keys listed above.

## Terminal interface

Running `kulmi` opens the responsive TUI.

The interface deliberately keeps the transcript dominant. Tool activity is compressed into one-line status rows, reasoning is collapsed unless requested, and plan and worker state appear in a right rail on wider terminals and disappear cleanly on narrow terminals. Model deltas are coalesced at roughly 30 FPS to avoid a render for every streamed token.

Each status row states both the attempt and the outcome: a label, what the call targeted, and a short result summary derived from the tool's own output.

```text
Search code   handleEvent in src        12 matches in 5 files
Edit files    src/a.ts  +2 more         2 files, +34 -2
Run command   npm test                  exit 1
```

The same formatter drives the headless renderer, so neither surface prints raw tool input or raw tool output, and the two cannot drift apart.

### Controls

| Key | Action |
| --- | --- |
| `Esc` | Stop the active run |
| `Ctrl+O` | Expand or collapse the current thinking stream |
| `Ctrl+C` | Stop an active run, or exit while idle |
| `Shift+Tab` | Cycle autonomy: `read`, `low`, `medium`, `high`, `trusted` |
| `?` | Open the compact command and shortcut guide |
| Enter during a run | Steer the root agent; the message is injected at the next step boundary |

### Commands

| Command | Action |
| --- | --- |
| `/sessions` | Keyboard picker for durable sessions in the current workspace |
| `/fork` | Create an independent continuation |
| `/undo` | Restore workspace, run state, and transcript boundary from before the previous completed turn |
| `/workers` | Show child agents |
| `/steer`, `/cancel`, `/retry`, `/integrate` | Control workers without leaving the TUI |
| `/status` | Show model, autonomy, session, and workspace |
| `/model` | List model profiles; `/model <name>` switches the session's model in place |
| `/goal` | Promote chat to task mode explicitly |
| `/auth` | Explain how to change credentials safely |
| `/help` | Show commands and keys |

Custom slash commands are discovered from `.kulmi/commands/*.md` and `~/.config/kulmi/commands/*.md`. The file body is a prompt template, and `$ARGUMENTS` expands to whatever follows the command name. Built-in commands take precedence.

Resume directly into the TUI:

```sh
kulmi --session-id session_0123456789abcdef
```

### Footer and approvals

The footer shows autonomy, free-search state, cumulative tokens, and cache-hit rate, plus a context fill bar that tracks how close the active transcript is to the model's context window. While a run is active, a status line above the composer rotates a shuffled spinner through messages such as `selling your data`, `barking up the wrong tree`, `opening a can of worms`, and `mining bitcoin briefly`.

Risky commands replace the composer with an explicit allow-once, allow-always, or deny prompt. Pressing Enter without choosing defaults to denial. Allow-always persists a per-workspace command-prefix entry to a user-level allowlist and auto-approves future matches. High-risk requests are never auto-approved and are never offered the option.

### Chat and task mode

Chat starts with only the task-promotion schema, so greetings and direct questions do not pay for the full coding-tool catalog. A request that needs files, commands, edits, or research promotes itself and receives the full tools on the next model turn. `/goal` performs the same promotion explicitly.

## Headless use

Running `kulmi exec` keeps the stable headless interface for scripts and CI.

```sh
kulmi init
kulmi exec --auto medium "fix the failing tests and verify the result"
kulmi exec --web-search off "work without web access"
kulmi exec --web-search free "research the current API before editing"
kulmi doctor
```

Headless sessions can be undone with `kulmi undo <session-id>`. JSON-RPC clients use `session.undo` and receive the restored messages and run state in the response. `kulmi fork <session-id>` creates an independent continuation without mutating the source session.

## Providers

The default provider adapter talks to any OpenAI-compatible `/v1/chat/completions` endpoint. It preserves streamed `reasoning_content`, fully replays reasoning on assistant tool-call turns, uses `max_completion_tokens`, records prompt cache and reasoning usage, and handles web citations and search billing telemetry.

Setting `protocol = "anthropic"` on a model profile switches that profile to a native Messages API adapter with `cache_control` breakpoints, thinking blocks with round-tripped signatures, merged tool results, and the same streaming and retry envelope.

Setting `protocol = "openai-responses"` uses the OpenAI Responses streaming API at `/v1/responses`, including Responses-native function calls and reasoning effort settings.

## Autonomy and search

Autonomy levels gate what the agent may run. `Shift+Tab` cycles the active level in the TUI.

| Level | Adds |
| --- | --- |
| `read` | Read-only inspection. Mutating tools are not even exposed. |
| `low` | Small local writes such as `cp`, `mkdir`, `mv`, `touch`, and write redirects |
| `medium` | Test runners, installs, and project scripts |
| `high` | Riskier project commands |
| `trusted` | Local git mutations such as `add`, `commit`, `mv` |

Destructive and publishing commands stay blocked at every level, including `trusted`: deletion, privilege escalation, remote publication, nested shells, dynamic interpreters, and credential exposure.

Search modes:

| Mode | Behavior |
| --- | --- |
| `off` | No network search or fetch tools are exposed |
| `free` | Exposes `web_search` and `fetch_url`. Uses a self-hosted SearXNG instance when configured, otherwise falls back to Bing's keyless personal-use RSS results. |

`fetch_url` blocks URL credentials, nonstandard ports, loopback and `.local` hosts, and any hostname that resolves to a private address. It follows redirects manually and revalidates every hop. One residual risk is documented in the source: validation resolves the hostname, then `fetch` resolves it again, so a DNS-rebinding attacker controlling a low-TTL record could return a public address to the check and a private one to the fetch. Closing that fully requires pinning the validated IP in a custom dispatcher.

## Architecture

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

## Subagents

Explore and review subagents are read-only and may share the checkout. Implement subagents receive isolated Git worktrees. Worker state and child transcripts are durable. Integration is explicit and rejects overlapping changes.

Built-in worker presets are `tester`, `reviewer`, `security`, `performance`, and `release`. They are compact routing hints over the same three execution modes, not always-on extra agents.

Running workers can be redirected with `steer_agent`. Failed or interrupted workers can be retried as new durable jobs.

## Memory

Each memory file is a durable fact, decision, or preference the agent should remember across sessions. Use memory for project decisions, user preferences, architectural context, and recurring patterns. Memory is distinct from skills, which are workflow instructions, and rules, which are enforced constraints.

Files are discovered from `.kulmi/memory/*.md`, `.agents/memory/*.md`, and `~/.config/kulmi/memory/*.md`. When names collide, `.kulmi` overrides `.agents`, which overrides the user directory. Unreadable or oversized files are skipped rather than failing discovery.

The inventory appears in the system prompt as a compact, size-capped list sorted by importance. Full content loads on demand through `read_memory`, and `list_memory` filters by tag. The agent stores new durable facts itself with `save_memory`, which writes `.kulmi/memory/<name>.md` and participates in undo like any other file write.

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

| Field | Meaning |
| --- | --- |
| `name` | Must start alphanumeric and use only letters, digits, dots, dashes, and underscores. Without frontmatter, the first heading or the filename is used and slugified. |
| `tags` | Comma-separated, matched case-insensitively |
| `importance` | `low`, `normal`, or `high`. Controls inventory ordering. |
| `preview` | Overrides the auto-extracted first paragraph shown in inventories |

## Skills

Local skills are discovered from `.kulmi/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`, and `~/.config/kulmi/skills/*/SKILL.md`. Their compact inventory stays in the stable prompt, and full instructions are loaded only when needed.

## Persistent processes

`start_process` runs a named long-lived command, such as a dev server or test watcher, outside the one-shot sandbox so it can bind ports and keep state across turns. It always requires interactive approval when a permission channel exists, applies the same shell policy blocklist, and uses the safe child environment with process-group control.

| Tool | Purpose |
| --- | --- |
| `process_logs` | Read the bounded output ring buffer, with optional regex filtering |
| `send_process_input` | Write stdin or send signals |
| `stop_process` | Terminate gracefully, then hard-kill |
| `list_processes` | Show what is running |

All processes die with the session.

## MCP servers

Kulmi is an MCP client. Declare stdio servers in user configuration:

```toml
[mcp.servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

Each server's tools appear to the agent as `mcp_<server>_<tool>` with the server's own input schema preserved. A server that fails to start is reported as a notice without blocking the session. Read-only workers receive only the tools a server annotates as read-only, and a tool with no annotation is treated as not read-only.

## Git workflow

Git workflow tools list, read, and resolve merge conflicts, then stage the resolved file. `git_log` shows recent commit history with an optional path filter, and `git_diff` shows uncommitted changes, the staged index, or a diff against a ref.

- `commit_changes` creates local commits from inside the harness and never pushes.
- `create_pull_request` pushes the current branch to origin and opens a PR through the `gh` CLI. It always requires explicit approval, refuses detached HEADs and branches with nothing to publish, and never force-pushes.

`ast_grep` runs structural code search by AST pattern, matching syntax shape rather than text, and `ast_grep_replace` applies a rewrite template to those matches in place for codemods where a text replace would be unsafe.

Browser QA can open a URL in headless Chromium and store screenshots as session attachments when Chrome or Chromium is available. Prompts can attach images with `@image path/to/image.png`.

## Hooks

Hooks are plain project commands with a safe environment, a timeout, and bounded output. They are not a plugin system, and they can only be configured in user configuration.

- `tool_pre` runs before tool execution and can block a tool by exiting nonzero.
- `tool_post` runs after tool execution. Failures are reported as runtime errors without replacing the original tool result.

```toml
# ~/.config/kulmi/config.toml
[hooks]
tool_pre = ["npm run lint:changed"]
tool_post = [{ command = "npm run verify:changed", timeout_seconds = 30 }]
```

## Sandboxing and shell policy

OS containment is required by default, and Kulmi fails closed when the required backend is unavailable.

| Platform | Backend |
| --- | --- |
| macOS | Built-in Seatbelt runner through `sandbox-exec`, with a deny-by-default profile |
| Linux | Bubblewrap with an empty mount namespace and user, IPC, PID, UTS, cgroup, and network namespaces |

Both expose system and selected toolchain paths read-only, expose the workspace and a private sandbox temporary directory as writable, deny writes to `.git`, and deny network access unless `sandbox.network = true`.

Apple marks `sandbox-exec` as deprecated, but it remains the only built-in process-level profile runner on supported macOS releases. `kulmi doctor` reports backend availability.

Beyond the sandbox, the shell policy parses each command and classifies it. It hard-blocks deletion, privilege escalation, remote publication, nested shells, dynamic interpreters, and credential exposure. A command is split on every separator a real shell would honor, including newlines, so a second command cannot hide behind the first. A write redirect raises the command's risk tier rather than being rejected outright, and a path outside the workspace is refused.

Model-controlled processes receive a minimal environment, an isolated home and temporary directory, closed stdin, a timeout, bounded output, process-group cancellation, and secret redaction.

## Persistence and undo

Sessions persist versioned, validated messages, events, run state, checkpoints, artifacts, worker jobs, model profile, and completion evidence. Existing unversioned sessions migrate on open. Session files are written to a temporary file and renamed, so a crash cannot leave a half-written session.

Interrupted assistant tool-call turns are repaired with an explicit uncertain result instead of replaying a potentially non-idempotent action.

Task completion requires an evidence-backed plan and, for modified work, an explicit successful current-revision verification command covering the changed files.

Every root turn records its pre-turn run state and before-and-after file snapshots. Undo then:

- validates that no file changed externally after the turn
- restores contents and permissions atomically per file
- removes files created by the turn
- restores plan and verification state
- advances the cache epoch if the active transcript changes

A durable undo journal lets an interrupted undo resume safely. Undo is blocked while child-agent work remains pending.

## File editing

File edits, replacements, and deletions require a current read hash, so the model cannot write over a file it has not seen in its present state.

`edit_files` preflights multiple exact replacements across already-read files, then applies them as one revision and rolls back completed writes if a later write fails. When exact text matching fails, a single whitespace-tolerant fallback applies only on an unambiguous unique match, and the result is labeled so the model knows the match was not verbatim.

Successful edits to recognized source files append compact LSP error diagnostics to the tool result within a bounded time budget of a few seconds, so the model sees the type errors it just introduced without a build round trip. The `lsp` tool exposes definition, references, hover, and workspace symbol queries, auto-detecting TypeScript and Python, with `pyright-langserver` required in PATH for Python.

`grep` searches text with ripgrep and supports `case_insensitive` matching and a `context` line count around each hit, in addition to fixed-string mode. File edits, writes, deletions, and shell-created changes emit bounded redacted unified diffs to clients. Shell tracking also records permission-only changes. No-op writes do not advance the workspace revision or invalidate accepted completion evidence.

## Prompt caching

Prompt caching is automatic and prefix-based on supported providers. Kulmi optimizes it by keeping the system message byte-stable, sorting tools canonically, canonicalizing every JSON schema, preserving message and tool-result order, and appending volatile state only at the conversation tail.

Chat and task mode use separate cache scopes, so the one deliberate tool-catalog expansion cannot invalidate either stable prefix. Compaction happens only near the context boundary, and only at a complete message boundary.

Large tool output is archived to an ArtifactStore with a recoverable artifact ID and a bounded preview in the transcript, instead of being silently truncated. State-changing tools return compact acknowledgements instead of duplicating state into the next fresh prompt tail. A soft step limit fires at 90% of `max_steps`, injecting a budget notice that tells the agent to finalize, verify, and report, before the hard `max_steps` limit blocks the run.

### Image compaction

When a model profile has `vision = true`, compaction renders the full discarded conversation history onto PNG frames and attaches them as image content parts alongside the text summary. The model can read the old conversation from the images, preserving far more context than a text-only summary. This is useful for long-horizon tasks where the agent needs to recall earlier reproduction output, file reads, and decisions. The frames use a compact 6x8 bitmap font at 1568px width, capped at 40 frames. The text summary and file-operation index are still included as plain text. If the model does not support vision, compaction falls back to the text-only summary.

Providers that report cache reads through `usage.prompt_tokens_details.cached_tokens` are fully supported. Kulmi reports cached and fresh tokens independently for every request.

## Development

```sh
npm install
npm run build
export MY_PROVIDER_API_KEY=...
npm run dev
```

Run `./install.sh` when you want the current checkout available globally as `kulmi` without relying on npm's global prefix.

The full gate is:

```sh
npm run check
```

That runs the version check, typecheck, the vitest suite, and a build.

CI runs the full gate on both `ubuntu-latest` and `macos-latest`, across Node 22 and 24, so a change must pass on both platforms before it merges.

Two suites stay outside `npm run check`:

- `npm run test:live` performs a low-output two-request smoke test covering thinking, tool-call reasoning replay, tool-result pairing, streaming, and cache telemetry. It needs a real key and incurs provider usage.
- `npm run eval` runs the SWE-style eval suite under `evals/`. Each task copies a fixture repo to a temporary directory, runs `kulmi exec` against a prompt, and judges the result solely by the task's verify command. Use it to regression-test harness changes. `KULMI_EVAL_BIN` swaps the executable under test and `KULMI_EVAL_MODEL` selects the model profile. Pass `--json` for machine-readable results, `--task <name>` to run a single task, and `--keep` to retain the temporary working directory. A task may define `repo_url` and `base_commit` to run against a real upstream repository instead of a fixture, and `fail_to_pass` plus `pass_to_pass` test lists to record per-test outcomes alongside the verify command. The runner also extracts the model's patch, changed files, and best-effort usage lines for each result.

The release gate and tag procedure is in [docs/releasing.md](docs/releasing.md).

## Design references

- [Bubblewrap](https://github.com/containers/bubblewrap)
- [macOS sandbox-exec manual](https://keith.github.io/xcode-manual-pages/sandbox-exec.1.html)
- [Pi](https://github.com/badlogic/pi-mono)
- [Oh My Pi](https://github.com/can1357/oh-my-pi)
- [OpenCode](https://github.com/anomalyco/opencode)
