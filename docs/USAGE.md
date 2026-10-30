# Usage

The server speaks MCP over stdio. A client (Claude Code, Codex) starts it in the repository the agent works in; the server finds the generation for that repository and commit and answers tool calls from it.

## Build the image

```bash
docker build --target runtime -t devos-intelligence-mcp:local .
```

`scripts/verify.sh` builds it too, after the tests.

## Claude Code

The launcher `scripts/mcp-docker.sh` runs the image with the working tree mounted read-only at the same path (see [DECISIONS.md](DECISIONS.md), M4). Claude Code starts stdio servers in the project folder, which becomes the workspace.

User scope (every project; repositories without a generation get an explanation instead of answers):

```bash
claude mcp add devos-intelligence --scope user -- ~/repos/devos/devos-intelligence-mcp/scripts/mcp-docker.sh
```

Project scope (writes `.mcp.json` in that repository, shared with its contributors):

```bash
claude mcp add devos-intelligence --scope project -- ~/repos/devos/devos-intelligence-mcp/scripts/mcp-docker.sh
```

Without Docker, with Node.js 24.22 or later on the host:

```bash
claude mcp add devos-intelligence --scope user -- node --disable-warning=ExperimentalWarning ~/repos/devos/devos-intelligence-mcp/src/cli.ts serve
```

Check with `claude mcp list`; inside a session, `/mcp` shows the server and its 14 tools.

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.devos-intelligence]
command = "/Users/<you>/repos/devos/devos-intelligence-mcp/scripts/mcp-docker.sh"
startup_timeout_sec = 30
```

Or, without Docker:

```toml
[mcp_servers.devos-intelligence]
command = "node"
args = ["--disable-warning=ExperimentalWarning", "/Users/<you>/repos/devos/devos-intelligence-mcp/src/cli.ts", "serve"]
```

Codex starts the server in its own working directory. When that is not the repository the agent works in, add `env = { DEVOS_MCP_WORKSPACE = "/path/to/repo" }`.

## Configuration

All optional; the defaults work on the owner's machine.

| Variable | Default | Meaning |
|---|---|---|
| `DEVOS_MCP_WORKSPACE` | client root, else the working directory | repository the answers are for |
| `DEVOS_MCP_GENERATIONS` | `~/repos/devos/_generations` when it exists | colon-separated folders: a generation, or a folder of generations (one level) |
| `DEVOS_MCP_CACHE` | `~/.cache/devos-intelligence-mcp` | pulled generations, `generations/<reference>/<commit>/<label>/` |
| `DEVOS_MCP_SYSTEM` | `auto` | system generations: `auto` (any whose inputs include this repository), `off`, or one folder |
| `DEVOS_MCP_MAX_ANCESTORS` | `50` | first-parent ancestors of HEAD to try before the `main-<engine>` tags |
| `DEVOS_MCP_OCI` | `on` | `off` disables the registry (cache and local folders still work) |
| `DEVOS_MCP_OCI_REFERENCE` | `ghcr.io/{owner}/context-{repo}` | repository of the artifacts; `{owner}` and `{repo}` come from the `origin` remote; an `http://` prefix means a plain-HTTP registry |
| `DEVOS_MCP_REGISTRY_USER`, `DEVOS_MCP_REGISTRY_TOKEN` (or `GHCR_TOKEN`) | see below | credentials for private packages (a token with `read:packages`); never printed |
| `DEVOS_MCP_GH_TOKEN` | `0` | `1` allows `gh auth token` as the last credential source for ghcr.io |
| `DEVOS_MCP_IMAGE` | `devos-intelligence-mcp:local` | image the launcher runs |
| `DEVOS_MCP_DOCKER_NETWORK` | Docker default | network for the launcher's container |

## Private packages

The `context-*` packages start private. The server first asks for an anonymous token; when the registry refuses it, it tries, in order and once each:

1. `DEVOS_MCP_REGISTRY_TOKEN` (or `GHCR_TOKEN`), with `DEVOS_MCP_REGISTRY_USER` (default `token`);
2. the Docker configuration (`$DOCKER_CONFIG/config.json` or `~/.docker/config.json`): inline `auths`, `credHelpers` for the host, then `credsStore`, through `docker-credential-<helper> get` (what `docker login ghcr.io` stores);
3. `gh auth token`, for `ghcr.io` only, and only with `DEVOS_MCP_GH_TOKEN=1`: a `gh` token usually carries `repo` and `workflow` scopes, far more than a pull needs, so it is never used unless asked for (it also needs `read:packages`: `gh auth refresh -s read:packages`).

`generation_info` names the source that worked (`credentials from env`, `docker-credential-desktop`, `gh`), never the value. In Docker the container has no credential store, so `scripts/mcp-docker.sh` does step 2 (the `ghcr.io` entry only) and, with `DEVOS_MCP_GH_TOKEN=1`, step 3 on the host when no token is set, and passes the result by variable name only. The lab packages are public: nothing is needed, and pulls are anonymous.

## Command line

The same binary answers outside a client, which helps when a tool answer looks wrong:

```bash
node src/cli.ts resolve ~/repos/devos/devos-lab-web
```

```bash
node src/cli.ts call who_calls '{"route":"POST /v1/leases/{id}/sign"}' --dir ~/repos/devos/devos-lab-web
```

```bash
node src/cli.ts verify ~/repos/devos/_generations/lab-web-angular
```

## Tools

| Tool | Arguments | Answer |
|---|---|---|
| `generation_info` | | source, commit, distance from HEAD, engine, contract, coverage, counts, verification, packs, sources tried |
| `search` | `query`, `kind` | entities and snippets matching the words |
| `symbol` | `symbol` | kind, signature, container, declarations, members, counts |
| `refs` | `symbol`, `usage` | references with usage, referencing entity, snippet |
| `callers`, `callees` | `symbol`, `depth` | call edges, depth 1 to 3 |
| `implementations` | `symbol` | implements, inherits, overrides |
| `di` | `service` | registrations and consumers, unresolved ones with the reason |
| `routes` | `prefix` | UI routes and HTTP endpoints |
| `http` | `route`, `method` | outgoing HTTP calls with base address source and caller |
| `who_calls` | `route`, `method`, `depth` | calls matching the route, their callers, links to the endpoint |
| `messages` | `contract` | publishers and subscribers with transport, destination and links |
| `trace` | `from`, `to`, `depth` | shortest path across calls, observations and links (dispatch, messaging, routes), weakest link named; without `to`, every reachable endpoint, handler or subscriber |
| `context` | `project`, `cursor` | context pack cards |

Every tool takes `generation` to pick one of several loaded generations; list tools take `limit` (default 20, max 100) and `cursor`. A symbol is an entity id, a name, or a qualified tail (`LeasesService.search`); an ambiguous one lists candidate ids.

## Reading an answer

The first line says which generation answered:

- `generation lab-web-angular (...) at e21eef1712b2, exact match for HEAD`: the generation is for HEAD.
- `WARNING generation ... is for e21eef1712b2, the nearest analyzed ancestor of HEAD 24e450a1d700 (2 commit(s) behind); 1 file(s) changed since, evidence in them is marked [changed]`: an older commit answered; lines in changed files may have moved.
- `..., exact match for HEAD; WARNING working tree has 3 uncommitted change(s)`: uncommitted edits, marked the same way.
- `generation system:lab (...; inputs core, intake, leasing, pricing, web; this repository is input web, the others at their analyzed commits) ...`: a federation system generation answers. Every location says its repository, `[leasing] src/Leasing.Host/...:33`. `who_calls`, `trace` and `messages` cross repositories; `search`, `routes`, `http` and `di` stay on this repository unless called with `scope: "system"`.
- `...; cross-repository answers (who_calls, trace, messages) from system:lab (...) at 66264d596794, 2 commit(s) behind HEAD`: a newer per-repository generation answers; the system answers the cross-repository tools.
