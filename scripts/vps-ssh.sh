#!/bin/sh
# Authentication stays in the operator's local SSH configuration and agent.
set -eu
if [ -z "${SOMA_VPS_SSH_HOST:-}" ]; then
  printf '%s\n' 'Set SOMA_VPS_SSH_HOST to a host or alias configured in your SSH client.' >&2
  exit 2
fi
exec ssh "$SOMA_VPS_SSH_HOST" "$@"
