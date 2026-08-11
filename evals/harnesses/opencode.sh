#!/bin/sh
# opencode adapter: headless run in the current directory.
set -e
prompt=""
for arg in "$@"; do prompt="$arg"; done
exec opencode run ${OPENCODE_MODEL:+--model "$OPENCODE_MODEL"} "$prompt"
