#!/bin/sh
# Launcher for MCP clients (Claude Code, Codex): runs the server image over stdio with the workspace mounted
# read-only at the same path, so file:line evidence and client roots keep their host paths (decision M4).
# Mounts: the Git working tree, its common Git directory when it lives elsewhere (worktrees), each generation folder
# (read-only) and the OCI cache (read-write). Registry credentials pass by name only, never on the command line.
set -eu

image="${DEVOS_MCP_IMAGE:-devos-intelligence-mcp:local}"
workspace="${DEVOS_MCP_WORKSPACE:-$PWD}"
root="$(git -C "$workspace" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$workspace")"
common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
generations="${DEVOS_MCP_GENERATIONS-}"
if [ -z "${DEVOS_MCP_GENERATIONS+x}" ] && [ -d "$HOME/repos/devos/_generations" ]; then
  generations="$HOME/repos/devos/_generations"
fi
cache="${DEVOS_MCP_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/devos-intelligence-mcp}"
mkdir -p "$cache"

set -- -i --rm --init --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$root:$root:ro" -w "$workspace" \
  -v "$cache:/cache" -e DEVOS_MCP_CACHE=/cache \
  -e DEVOS_MCP_WORKSPACE="$workspace" -e DEVOS_MCP_GENERATIONS="$generations" \
  -e DEVOS_MCP_OCI -e DEVOS_MCP_OCI_REFERENCE -e DEVOS_MCP_MAX_ANCESTORS \
  -e DEVOS_MCP_REGISTRY_USER -e DEVOS_MCP_REGISTRY_TOKEN -e GHCR_TOKEN
case "$common" in
  ""|"$root"/*) ;;
  *) set -- "$@" -v "$common:$common:ro" ;;
esac
old_ifs="$IFS"
IFS=:
for g in $generations; do
  [ -d "$g" ] && set -- "$@" -v "$g:$g:ro"
done
IFS="$old_ifs"
[ -n "${DEVOS_MCP_DOCKER_NETWORK:-}" ] && set -- "$@" --network "$DEVOS_MCP_DOCKER_NETWORK"

exec docker run "$@" "$image" serve
