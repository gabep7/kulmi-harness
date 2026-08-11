#!/bin/sh
# Adapter so evals/compare.mjs can drive kulmi through the same contract as
# other harnesses. Invoked as: <shim> exec --auto high [--model M] "<prompt>"
# The prompt is always the last argument.
set -e
prompt=""
for arg in "$@"; do prompt="$arg"; done
exec node "$KULMI_COMPARE_CLI" exec --auto high ${KULMI_COMPARE_MODEL:+--model "$KULMI_COMPARE_MODEL"} "$prompt"
