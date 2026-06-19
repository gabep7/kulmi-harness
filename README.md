# Kulmi

Kulmi is a MiMo V2.5-native autonomous coding harness with a fast full-screen terminal interface and a headless TypeScript kernel. `mimo-v2.5-pro` is the primary model. `mimo-v2.5`, pay-as-you-go, and MiMo Token Plan profiles are supported.

The provider adapter talks directly to MiMo. It preserves streamed `reasoning_content`, fully replays reasoning on assistant tool-call turns, uses `max_completion_tokens`, records prompt cache and reasoning usage, and handles MiMo web citations and search billing telemetry.

## Requirements

- Node.js 22+
- A pay-as-you-go MiMo key beginning with `sk-`, or a Token Plan key beginning with `tp-`. The first-run terminal setup can store it in the system keychain.

## Install

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

The repository is not published at the package URL yet, so the installer intentionally uses the checkout when invoked as `./install.sh`. Tagged releases will include a prebuilt `kulmi-node.tar.gz` containing `dist` and production dependencies. Remote installs download and extract that bundle without npm installation or local compilation, then fall back to a source build only when a prebuilt release is unavailable. Select releases through `KULMI_REPOSITORY` and `KULMI_INSTALL_VERSION`.

Then start Kulmi:

```sh
kulmi
```

On first run, Kulmi asks you to choose `API` or `Token Plan`, then accepts a masked key paste. The key is stored in the system keychain and never written into the repository or Kulmi configuration. Run `kulmi auth` later to replace it.

Environment variables remain supported for CI, headless machines, and users who manage secrets through their shell:

```sh
export MIMO_API_KEY=sk-...
# or
export MIMO_TOKEN_PLAN_API_KEY=tp-...
```

## Develop from source

```sh
npm install
npm run build
export MIMO_API_KEY=sk-...
npm run dev
```

Run `./install.sh` when you want the current checkout available globally as `kulmi` without relying on npm's global prefix.

For Token Plan:

```sh
export MIMO_TOKEN_PLAN_API_KEY=tp-...
kulmi exec -m mimo-v2.5-pro-token-plan "inspect this repository"
```

The built-in Token Plan profiles use the Europe cluster. Change `base_url` to the Singapore or China endpoint in `.kulmi/config.toml` when needed.

```sh
kulmi init
kulmi exec --auto medium "fix the failing tests and verify the result"
kulmi exec --web-search off "work without web access"
kulmi exec --web-search free "research the current API before editing"
kulmi doctor
```

Running `kulmi` opens the responsive TUI. Running `kulmi exec` keeps the stable headless interface for scripts and CI.

Chat starts with only the task-promotion schema, so greetings and direct questions do not pay for the full coding-tool catalog. A normal request that needs files, commands, edits, or research promotes itself and receives the full tools on the next model turn. `/goal` performs the same promotion explicitly.

## Terminal interface

The interface deliberately keeps the transcript dominant. Tool activity is compressed into one-line status rows; reasoning is collapsed unless requested; plan and worker state appear in a right rail on wider terminals and disappear cleanly on narrow terminals. Model deltas are coalesced at roughly 30 FPS to avoid a render for every streamed token.

Controls:

- `Esc` stops the active run.
- `Ctrl+O` expands or collapses the current thinking stream.
- `Ctrl+C` stops an active run, or exits while idle.
- `?` opens the compact command and shortcut guide.
- `/sessions` opens a keyboard picker for durable sessions in the current workspace.
- `/fork` creates an independent continuation.
- `/workers` shows child agents.
- `/steer`, `/cancel`, `/retry`, and `/integrate` control workers without leaving the TUI.
- `/status` shows the model, autonomy, session, and workspace.

Resume directly into the TUI with:

```sh
kulmi --session-id session_0123456789abcdef
```

The footer shows autonomy, free-search state, cumulative tokens, and MiMo cache-hit rate. Risky commands replace the composer with an explicit allow-once or deny prompt. Pressing Enter without choosing defaults to denial.

Search modes:

- `off` exposes no network search or fetch tools.
- `free` exposes `web_search` and the SSRF-protected `fetch_url` tool. It uses a self-hosted SearXNG instance when configured, otherwise it falls back to Bing's keyless personal-use RSS results.

Kulmi has no paid search provider, no search API key setting, and does not expose MiMo's billable native search plugin.

## Runtime architecture

```text
TUI / headless CLI
 |
 |
 +-------------+
               |
        SessionController
               |
     Agent loop and durable state
       /          |           \
 MiMo adapter   Tool gate   Subagent scheduler
                             and worktrees
```

The runtime is headless. The TUI and CLI only send commands and render events. They do not own sessions, permissions, tools, prompts, worker state, or provider credentials.

Explore and review subagents are read-only and may share the checkout. Implement subagents receive isolated Git worktrees. Worker state and child transcripts are durable. Integration is explicit and rejects overlapping changes.

Running workers can be redirected with `steer_agent`. Failed or interrupted workers can be retried as new durable jobs. Local skills are discovered from `.kulmi/skills/*/SKILL.md`, `.agents/skills/*/SKILL.md`, and `~/.config/kulmi/skills/*/SKILL.md`; their compact inventory stays in the stable prompt and full instructions are loaded only when needed.

`kulmi fork <session-id>` creates an independent continuation without mutating the source session. Interactive shell commands include `/help`, `/status`, `/sessions`, and `/loop <task>`.

## Cache contract

MiMo prompt caching is automatic and prefix-based. Kulmi optimizes it by keeping the system message byte-stable, sorting tools canonically, canonicalizing every JSON schema, preserving message and tool-result order, and appending volatile state only at the conversation tail. Chat and task mode use separate cache scopes so the one deliberate tool-catalog expansion cannot invalidate either stable prefix. Compaction happens only near the 1M context boundary and only at a complete message boundary.

MiMo reports cache reads through `usage.prompt_tokens_details.cached_tokens`. Kulmi reports cached and fresh tokens independently for every request. Cache writes are currently free according to MiMo's pricing documentation, while cache-hit input for `mimo-v2.5-pro` is priced far below uncached input.

## Safety and persistence

Autonomy levels are `read`, `low`, `medium`, and `high`. The shell policy blocks deletion, privilege escalation, remote publication, unsafe redirects, nested shells, dynamic interpreters, and credential exposure. Model-controlled processes receive a minimal environment, isolated home, closed stdin, timeout, bounded output, process-group cancellation, and secret redaction.

Sessions persist versioned, validated messages, events, run state, checkpoints, artifacts, worker jobs, model profile, and completion evidence. Existing unversioned sessions migrate on open. Interrupted assistant tool-call turns are repaired with an explicit uncertain result instead of replaying a potentially non-idempotent action. Task completion requires an evidence-backed plan and, for modified work, an explicit successful current-revision verification command covering the changed files.

## Development

```sh
npm run check
```

With a real key, `npm run test:live:mimo` performs a low-output two-request smoke test covering thinking, tool-call reasoning replay, tool-result pairing, streaming, and cache telemetry. It is not part of `npm run check` because it incurs provider usage.

The detailed MiMo documentation inventory and implementation mapping is in [docs/mimo-doc-audit.md](docs/mimo-doc-audit.md).

## Design references

- [MiMo documentation](https://mimo.mi.com/docs/en-US/)
- [MiMo OpenAI-compatible API](https://mimo.mi.com/docs/en-US/api/chat/openai-api)
- [MiMo deep thinking](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking)
- [MiMo web search](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/tool-calling/web-search)
- [MiMo Token Plan quick access](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access)
- [Reasonix](https://github.com/esengine/deepseek-reasonix)
- [Pi](https://github.com/badlogic/pi-mono)
- [Oh My Pi](https://github.com/can1357/oh-my-pi)
- [OpenCode](https://github.com/anomalyco/opencode)
