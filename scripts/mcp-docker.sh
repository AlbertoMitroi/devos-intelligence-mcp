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

# Private context-* packages: the container has no credential store, so look the GHCR token up here (Docker
# credential helper, then gh) when none is set, and hand it over by variable name only (never on a command line).
# Skipped when DEVOS_MCP_OCI=off or the reference is not on ghcr.io.
registry_host() { printf '%s' "${DEVOS_MCP_OCI_REFERENCE:-ghcr.io/x}" | sed -e 's#^[a-z]*://##' -e 's#/.*##'; }
if [ "${DEVOS_MCP_OCI:-on}" != off ] && [ -z "${DEVOS_MCP_REGISTRY_TOKEN:-}${GHCR_TOKEN:-}" ] && [ "$(registry_host)" = ghcr.io ]; then
  config="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  store=""
  if [ -f "$config" ]; then
    store="$(tr -d '\n' < "$config" | sed -n 's/.*"ghcr.io"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    [ -n "$store" ] || store="$(tr -d '\n' < "$config" | sed -n 's/.*"credsStore"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  fi
  if [ -n "$store" ] && command -v "docker-credential-$store" > /dev/null 2>&1; then
    found="$(printf 'ghcr.io' | "docker-credential-$store" get 2> /dev/null || true)"
    secret="$(printf '%s' "$found" | sed -n 's/.*"Secret":"\([^"]*\)".*/\1/p')"
    if [ -n "$secret" ]; then
      DEVOS_MCP_REGISTRY_TOKEN="$secret"
      DEVOS_MCP_REGISTRY_USER="$(printf '%s' "$found" | sed -n 's/.*"Username":"\([^"]*\)".*/\1/p')"
      export DEVOS_MCP_REGISTRY_TOKEN DEVOS_MCP_REGISTRY_USER
    fi
  fi
  if [ -z "${DEVOS_MCP_REGISTRY_TOKEN:-}" ] && command -v gh > /dev/null 2>&1; then
    DEVOS_MCP_REGISTRY_TOKEN="$(gh auth token --hostname github.com 2> /dev/null || true)"
    [ -n "$DEVOS_MCP_REGISTRY_TOKEN" ] && export DEVOS_MCP_REGISTRY_TOKEN || unset DEVOS_MCP_REGISTRY_TOKEN
  fi
fi

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
