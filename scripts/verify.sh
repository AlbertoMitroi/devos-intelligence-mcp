#!/usr/bin/env bash
# The single local verify command. Needs Docker and git; the inputs are the sibling folders of ~/repos/devos.
# 1. builds the test stage (type check and unit tests run inside it) and the runtime image,
# 2. checks the runtime image (version, tools, non-root, no npm dependencies),
# 3. starts a registry:2 container and pushes lab-web-angular with ORAS in the layout the release session publishes
#    (`<sha>-angular` and `main-angular`, same artifact type, layer media type and annotations),
# 4. runs the integration tests in the test image: real generations, the official MCP SDK client, the registry,
# 5. drives the runtime image through scripts/mcp-docker.sh like a client would, against a clone of lab-web.
# MCP_VERIFY_TRANSCRIPT=path writes the SDK client session as Markdown; MCP_VERIFY_GHCR=1 also pulls the lab
# generations from the real ghcr.io (network, public packages).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
devos="${DEVOS_ROOT:-$(cd "$root/.." && pwd)}"
[ -d "$devos/_generations" ] || devos="$HOME/repos/devos"
generations="$devos/_generations"
lab_web="$devos/devos-lab-web"
lab_leasing="$devos/devos-lab-leasing"
contract="$devos/devos-intelligence-contract"
eshop="$generations/src/eshoponabp"
tag="${MCP_VERIFY_TAG:-devos-intelligence-mcp}"
work="$root/.verify"
net="devos-mcp-verify-$$"
registry_image="registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
oras_image="ghcr.io/oras-project/oras:v1.3.6@sha256:9cfb578be975b762fd898b9d004243d8003aeb807a3e15b2ed212cdd1326c9eb"
lab_commit="$(sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p' "$generations/lab-web-angular/manifest.json")"
[ -n "$lab_commit" ]

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
[ "$(docker run --rm --network none "$tag:local" tools | wc -l | tr -d ' ')" = "14" ]
[ "$(docker run --rm --entrypoint id "$tag:local" -u)" != "0" ]
[ "$(docker run --rm --entrypoint sh "$tag:local" -c 'ls /opt/devos-intelligence-mcp')" = "$(printf 'package.json\nschema\nsrc')" ]

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

if [ -f "$generations/lab-system/manifest.json" ]; then
  step "local registry with lab-system (context-systems layout, decision M11)"
  mkdir -p "$work/system"
  docker run --rm --user "$(id -u):$(id -g)" -v "$generations/lab-system:/g:ro" -v "$work/system:/w" --entrypoint sh "$tag:test" -c '
    set -e
    tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C /g -cf - . | gzip -n > /w/generation.tar.gz
    node -e "
      const fs = require(\"fs\");
      const m = JSON.parse(fs.readFileSync(\"/g/manifest.json\", \"utf8\"));
      const inputs = fs.readFileSync(\"/g/inputs.ndjson\", \"utf8\").split(\"\\n\").filter(Boolean).map((l) => JSON.parse(l)).filter((i) => i.included);
      const repo = (u) => u.replace(/\\.git$/, \"\").split(\"/\").pop().toLowerCase();
      const tags = [m.system + \"-\" + m.commit.slice(7), m.system + \"-main\", ...inputs.map((i) => m.system + \".\" + repo(i.repository.remoteUrl) + \".\" + i.commit)];
      fs.writeFileSync(\"/w/tags\", tags.join(\",\"));
      const sha = require(\"crypto\").createHash(\"sha256\").update(fs.readFileSync(\"/g/manifest.json\")).digest(\"hex\");
      fs.writeFileSync(\"/w/annotations.json\", JSON.stringify({ \"\$manifest\": { \"org.opencontainers.image.source\": \"https://github.com/AlbertoMitroi/devos-lab\", \"dev.devos.intelligence.engine\": \"intelligence-federation\", \"dev.devos.intelligence.generation-type\": \"system\", \"dev.devos.intelligence.system\": m.system }, \"generation.tar.gz\": { \"dev.devos.intelligence.manifest-sha256\": sha } }));
    "'
  docker run --rm --network "$net" -v "$work/system:/work" -w /work "$oras_image" \
    push --plain-http "registry:5000/albertomitroi/context-systems:$(cat "$work/system/tags")" \
    --artifact-type application/vnd.devos.intelligence.generation.v1 --annotation-file annotations.json \
    generation.tar.gz:application/vnd.devos.intelligence.generation.v1.tar+gzip
fi

step "integration tests (real generations, SDK client, registry)"
docker run --rm --network "$net" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$generations:/generations:ro" -v "$lab_web:/repos/devos-lab-web:ro" -v "$eshop:/repos/eshoponabp:ro" -v "$lab_leasing:/repos/devos-lab-leasing:ro" -v "$contract:/repos/devos-intelligence-contract:ro" -v "$work/out:/out" \
  -e DEVOS_IT_GENERATIONS=/generations -e DEVOS_IT_LAB_WEB=/repos/devos-lab-web -e DEVOS_IT_ESHOP=/repos/eshoponabp \
  -e DEVOS_IT_LAB_LEASING=/repos/devos-lab-leasing -e DEVOS_IT_CONTRACT=/repos/devos-intelligence-contract -e DEVOS_IT_GHCR="${MCP_VERIFY_GHCR:-0}" \
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
