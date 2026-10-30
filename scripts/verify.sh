#!/usr/bin/env bash
# The single local verify command. Needs Docker and git; the inputs are the sibling folders of ~/repos/devos.
# 1. builds the test stage (type check and unit tests run inside it) and the runtime image,
# 2. checks the runtime image (version, tools, non-root, no npm dependencies),
# 3. starts a registry:2 container and pushes lab-web-angular with ORAS in the layout the release session publishes
#    (`<sha>-angular` and `main-angular`, same artifact type, layer media type and annotations),
# 4. runs the integration tests in the test image: real generations, the official MCP SDK client, the registry,
# 5. drives the runtime image through scripts/mcp-docker.sh like a client would, against a clone of lab-web.
# MCP_VERIFY_TRANSCRIPT=path writes the SDK client session as Markdown.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
devos="${DEVOS_ROOT:-$(cd "$root/.." && pwd)}"
[ -d "$devos/_generations" ] || devos="$HOME/repos/devos"
generations="$devos/_generations"
lab_web="$devos/devos-lab-web"
eshop="$generations/src/eshoponabp"
tag="${MCP_VERIFY_TAG:-devos-intelligence-mcp}"
work="$root/.verify"
net="devos-mcp-verify-$$"
registry_image="registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
oras_image="ghcr.io/oras-project/oras:v1.3.6@sha256:9cfb578be975b762fd898b9d004243d8003aeb807a3e15b2ed212cdd1326c9eb"
lab_commit="e21eef1712b25463d61687efc2f547d9dc0949f1"

step() { printf '\n== %s\n' "$*"; }
cleanup() {
  docker rm -f "$net-registry" > /dev/null 2>&1 || true
  docker network rm "$net" > /dev/null 2>&1 || true
}
trap cleanup EXIT

rm -rf "$work"
mkdir -p "$work/layer" "$work/out"

step "test stage (type check, unit tests)"
docker build --target test -t "$tag:test" "$root"

step "runtime image"
docker build --target runtime -t "$tag:local" "$root"

step "runtime self-check"
docker run --rm --network none "$tag:local" --version
[ "$(docker run --rm --network none "$tag:local" tools | wc -l | tr -d ' ')" = "12" ]
[ "$(docker run --rm --entrypoint id "$tag:local" -u)" != "0" ]
[ "$(docker run --rm --entrypoint sh "$tag:local" -c 'ls /opt/devos-intelligence-mcp')" = "$(printf 'package.json\nsrc')" ]

step "local registry with lab-web-angular (release layout)"
docker network create "$net" > /dev/null
docker run -d --rm --name "$net-registry" --network "$net" --network-alias registry "$registry_image" > /dev/null
docker run --rm --user "$(id -u):$(id -g)" -v "$generations/lab-web-angular:/g:ro" -v "$work/layer:/w" --entrypoint sh "$tag:test" -c '
  set -e
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C /g -cf - . | gzip -n > /w/generation.tar.gz
  manifest=$(sha256sum /g/manifest.json | cut -d " " -f 1)
  cat > /w/annotations.json <<JSON
{"\$manifest": {"org.opencontainers.image.source": "https://github.com/AlbertoMitroi/devos-lab-web",
                "org.opencontainers.image.revision": "'"$lab_commit"'",
                "org.opencontainers.image.ref.name": "refs/heads/main",
                "dev.devos.intelligence.engine": "angular-intelligence"},
 "generation.tar.gz": {"dev.devos.intelligence.manifest-sha256": "$manifest"}}
JSON'
docker run --rm --network "$net" -v "$work/layer:/work" -w /work "$oras_image" \
  push --plain-http "registry:5000/albertomitroi/context-devos-lab-web:$lab_commit-angular,main-angular" \
  --artifact-type application/vnd.devos.intelligence.generation.v1 --annotation-file annotations.json \
  generation.tar.gz:application/vnd.devos.intelligence.generation.v1.tar+gzip

step "integration tests (real generations, SDK client, registry)"
docker run --rm --network "$net" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$generations:/generations:ro" -v "$lab_web:/repos/devos-lab-web:ro" -v "$eshop:/repos/eshoponabp:ro" -v "$work/out:/out" \
  -e DEVOS_IT_GENERATIONS=/generations -e DEVOS_IT_LAB_WEB=/repos/devos-lab-web -e DEVOS_IT_ESHOP=/repos/eshoponabp \
  -e DEVOS_IT_REGISTRY=http://registry:5000 -e DEVOS_IT_TRANSCRIPT=/out/transcript.md \
  --entrypoint node "$tag:test" --test --test-reporter=spec --test-concurrency=1 "tests/integration/*.test.ts"
if [ -n "${MCP_VERIFY_TRANSCRIPT:-}" ]; then cp "$work/out/transcript.md" "$MCP_VERIFY_TRANSCRIPT"; fi

step "runtime image through scripts/mcp-docker.sh"
git clone -q --no-checkout "$lab_web" "$work/lab-web"
git -C "$work/lab-web" checkout -q "$lab_commit"
git -C "$work/lab-web" remote set-url origin https://github.com/AlbertoMitroi/devos-lab-web.git
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"who_calls","arguments":{"route":"POST /v1/leases/{id}/sign"}}}'
} | DEVOS_MCP_IMAGE="$tag:local" DEVOS_MCP_WORKSPACE="$work/lab-web" DEVOS_MCP_GENERATIONS="$generations" DEVOS_MCP_OCI=off \
    DEVOS_MCP_CACHE="$work/cache" "$root/scripts/mcp-docker.sh" > "$work/out/launcher.ndjson"
cat "$work/out/launcher.ndjson"
grep -q '"protocolVersion":"2025-06-18"' "$work/out/launcher.ndjson"
grep -q 'exact match for HEAD' "$work/out/launcher.ndjson"
grep -q 'caller LeasesService.sign' "$work/out/launcher.ndjson"

step "ok"
