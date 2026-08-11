# Evals

Regression bar for the harness. The point is not to celebrate a high score: it is
to make bloat and regressions visible. A change that adds a tool, prompt text, or
a new loop must not lower the pass rate.

## Running

```sh
pnpm build
KULMI_EVAL_MODEL=<profile> node evals/run.mjs           # whole suite
KULMI_EVAL_MODEL=<profile> node evals/run.mjs --task X  # one task
node evals/run.mjs --json                               # machine readable
```

`--keep` leaves the scratch worktree in place for inspection.

## Task anatomy

`evals/tasks/<name>/task.json`:

- `prompt`: what the agent is told.
- `verify`: the primary command, must exit 0 only when the task is solved.
- `fail_to_pass`: commands that must fail before the change and pass after.
- `pass_to_pass`: guards that must pass both before and after. These carry the
  real signal: they catch a fix that satisfies the visible test while breaking
  documented behavior, and they catch hardcoded or test-sniffing answers.
- `timeout_seconds`: per-command budget.
- `setup`, or `repo_url` plus `base_commit` for real-repo tasks instead of a
  local `fixture/` directory.

## Adding a task

A task only counts if it discriminates. Before committing one, confirm against a
scratch copy that:

1. `verify` and every `fail_to_pass` command fail on the untouched fixture.
2. Every `pass_to_pass` guard passes on the untouched fixture.
3. Every guard still passes under a genuinely correct fix.
4. At least one guard fails under the tempting-but-wrong fix.

Step 4 is what separates a real eval from a decorative one. For example
`hidden-regression` is solved by making `get` refresh recency, but a fix that
reinserts through `set` also resets the TTL clock, and a guard catches exactly
that.

## Baseline

Recorded with `deepseek-v4-flash:0731` via Ollama Cloud, autonomy `high`:

| task | result | seconds |
| --- | --- | --- |
| async-order | pass | 14.7 |
| edge-case-parser | pass | 15.1 |
| fix-failing-test | pass | 21.3 |
| hidden-regression | pass | 24.4 |
| implement-function | pass | 14.7 |
| multi-file-trace | pass | 43.4 |
| refactor-rename | pass | 42.0 |

7/7 in 176s total. A cheap fast model clearing the suite means these tasks are
the floor, not the ceiling: when it saturates, add harder tasks rather than
trusting the number.

## Cross-harness comparison

`evals/compare.mjs` runs the same tasks against several agent CLIs and reports
pass rate, wall-clock time, and patch size:

```sh
KULMI_COMPARE_MODEL=ds-flash PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-flash \
  node evals/compare.mjs --harness kulmi,pi
```

Each harness is a shim in `evals/harnesses/` that receives
`exec --auto high <prompt>` with the prompt as the last argument. Adapters exist
for kulmi, pi, opencode, and claude. Models are set per shim via
`KULMI_COMPARE_MODEL`, `PI_MODEL`, `OPENCODE_MODEL`, and `CLAUDE_MODEL`.

Comparisons are only meaningful when every harness runs the same underlying
model, otherwise the numbers measure the model rather than the harness. Use
`--runs N` to average over agent nondeterminism before trusting a gap.

### Result, deepseek-v4-flash, 7 tasks x 2 runs

| harness | pass | rate | total | median | patch lines |
| --- | --- | --- | --- | --- | --- |
| kulmi | 14/14 | 100% | 211.1s | 15.4s | 165 |
| pi | 14/14 | 100% | 198.4s | 10.2s | 157 |

Per-task medians, kulmi versus pi: async-order 15.1 / 9.5, edge-case-parser
13.7 / 9.1, fix-failing-test 14.6 / 7.4, hidden-regression 14.4 / 15.0,
implement-function 8.5 / 7.3, multi-file-trace 21.1 / 40.1, refactor-rename
18.1 / 10.8.

Equal correctness at comparable patch size. Total time is close (1.06x, from
1.33x), though the per-task median is still 1.5x because pi finishes small tasks
faster while kulmi wins the hardest one, `multi-file-trace`, by a wide margin.

Startup is not the lever: at ~165ms it is about 1% of a task. Wasted turns are.
Profiling runs with `-o stream-json` and counting tool errors found four
harness-caused stalls, each worth seconds per task:

- `read_file` rejected `offset: 0`, which models send constantly.
- `complete_task` required a plan that the prompt never asked for, costing two
  round trips.
- `cd` was blocked without the prompt saying so.
- Verification name matching did not recognize `smoke`, `sanity`, `validate`,
  `e2e`, `lint`, or the gradle/maven/dotnet runners. This one was the worst:
  because completion is gated on a *recorded* verification, an agent whose real
  `node smoke.mjs` check already passed was pushed into writing a throwaway
  `verify.mjs` wrapper purely to satisfy the gate. Fixing it took
  `refactor-rename` from 30.3s to 12.4s in isolation.

Beware two measurement traps. `pnpm build` deletes `dist/`, so building while
evals run makes every task "fail" in a fraction of a second; the runner now
aborts with a clear message instead. And provider stalls are real: one
`hidden-regression` run took 202s against a normal 12s, which is why retries are
surfaced as notices and why `--runs` matters before believing any delta.

