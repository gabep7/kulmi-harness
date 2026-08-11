#!/bin/sh
# pi adapter: non-interactive, tools enabled, ephemeral session.
set -e
prompt=""
for arg in "$@"; do prompt="$arg"; done
exec pi --print --no-session ${PI_PROVIDER:+--provider "$PI_PROVIDER"} ${PI_MODEL:+--model "$PI_MODEL"} "$prompt"
