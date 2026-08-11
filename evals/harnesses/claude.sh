#!/bin/sh
# claude adapter: -p is non-interactive print mode. Edits need permission
# bypass, which is why comparison runs must stay in a scratch worktree.
set -e
prompt=""
for arg in "$@"; do prompt="$arg"; done
exec claude -p --permission-mode bypassPermissions ${CLAUDE_MODEL:+--model "$CLAUDE_MODEL"} "$prompt"
