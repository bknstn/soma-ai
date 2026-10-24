#!/bin/sh
# Authentication stays in the operator's local SSH configuration and agent.
set -eu
exec ssh "${ASSISTANT_VPS_SSH_HOST:-hermes-vps}" "$@"
