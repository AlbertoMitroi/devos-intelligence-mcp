# Dependencies and licenses

## Runtime (the image)

| Dependency | Version | Use | License |
|---|---|---|---|
| Node.js | `node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c` (24.22.2) | runs the sources (type stripping), `node:sqlite` with FTS5, `fetch`, `zlib` | MIT |
| git | Debian 12 package `1:2.39.5-0+deb12u3` | reads HEAD, remote, ancestors, changed files of the workspace | GPL-2.0 |
| ca-certificates | Debian 12 package `20250419~deb12u2` | TLS to the registry | MPL-2.0 and others |

No npm package is installed in the runtime stage.

## Vendored

| File | Source | Use |
|---|---|---|
| `schema/index/v1/index.sql` | `devos-intelligence-contract` tag `v1.2.0` (`2828fd6`), SHA-256 in `schema/VENDOR.json` | normative index schema (MIT) |

## Development and tests

| Dependency | Version | Use | License |
|---|---|---|---|
| TypeScript | `6.0.3` | type check (`tsc --noEmit`) | Apache-2.0 |
| @types/node | `24.19.2` | Node types | MIT |
| @modelcontextprotocol/sdk | `1.32.2` | official MCP client in the interoperability test only (M3) | MIT |
| registry | `registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373` | local OCI registry in `scripts/verify.sh` | Apache-2.0 |
| ORAS | `ghcr.io/oras-project/oras:v1.3.6@sha256:9cfb578be975b762fd898b9d004243d8003aeb807a3e15b2ed212cdd1326c9eb` | pushes a generation in the release layout in `scripts/verify.sh` | Apache-2.0 |
