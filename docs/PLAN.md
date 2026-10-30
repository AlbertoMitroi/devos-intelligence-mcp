# devos-intelligence-mcp: plan

## Purpose

Deliver generations of the intelligence engines (`devos-dotnet-intelligence`, `devos-angular-intelligence`, later system generations of `devos-intelligence-federation`) to AI agents (Claude Code, Codex) as MCP tools. The agent never receives a generation, only compact answers to tool calls, each with `file:line` evidence and short redacted snippets.

The engines know nothing about this server; it reads the contract ([`devos-intelligence-contract`](../../devos-intelligence-contract), v1.0 and v1.1) and the engine-written `index.sqlite`.

## Decisions (details in [DECISIONS.md](DECISIONS.md))

| # | Decision |
|---|---|
| M1 | Local repository `~/repos/devos/devos-intelligence-mcp`; GitHub publishing is the owner's call |
| M2 | TypeScript on Node.js 24 with type stripping and `node:sqlite`, same base image digest as `devos-angular-intelligence`; **no runtime npm dependencies** |
| M3 | Hand-written MCP stdio transport (newline-delimited JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`, `roots/list` towards the client); interoperability proven against the official `@modelcontextprotocol/sdk` client in tests (dev dependency only) |
| M4 | Docker-first: the image runs the server; a launcher script mounts the workspace (and the Git common directory of worktrees) read-only at the same path. Running the sources with a host Node 24 is the documented alternative |
| M5 | Resolution order: configured local folders, OCI cache, OCI registry; nearest analyzed commit wins, local wins ties; an ancestor result is announced in every answer |
| M6 | OCI read through the registry HTTP API v2 (`fetch`, Bearer challenge, anonymous for public packages), own tar reader with path checks; layout agreed with the release session: tags `<sha>-<engine>` and `main-<engine>`, artifact type `application/vnd.devos.intelligence.generation.v1` |
| M7 | Engine-neutral reader: only the `index.sqlite` tables and the contract kinds; several generations at once (one per engine for the same commit, later the inputs of a system generation) |
| M8 | Every answer is bounded: `limit` (default 20, max 100), opaque `cursor`, snippets one line of at most 160 characters, re-redacted defensively; context pack cards paged at 6000 characters |

## Resolution rules

1. **Workspace**: `DEVOS_MCP_WORKSPACE`, else the first `file://` root the client reports (`roots/list`), else the process working directory. `git rev-parse --show-toplevel`, `HEAD`, `remote.origin.url`; re-checked on every call, so a checkout or commit during the session switches the generation.
2. **Identity**: a generation matches when its `manifest.commit` equals the commit and its normalized `repository.remoteUrl` equals the workspace remote (host, owner and name in lower case, `.git`, scheme and SSH form removed). A side without a remote matches on commit only.
3. **Candidates**: `HEAD` followed by its first-parent ancestors, at most `DEVOS_MCP_MAX_ANCESTORS` (default 50).
4. **Sources**, each queried for the whole candidate list:
   - local folders from `DEVOS_MCP_GENERATIONS` (colon-separated; each is a generation or a folder of generations), default `~/repos/devos/_generations` when it exists;
   - the OCI cache (`DEVOS_MCP_CACHE`, default `~/.cache/devos-intelligence-mcp`);
   - the registry: one tag listing of `ghcr.io/<owner>/context-<repo>` (template `DEVOS_MCP_OCI_REFERENCE`, default `ghcr.io/{owner}/context-{repo}`); tags `<sha>-<engine>` (or a bare `<sha>`) are matched against the candidates. Disabled with `DEVOS_MCP_OCI=off`.
5. **Choice**: the candidate with the smallest distance from `HEAD`; at equal distance local, then cache, then registry. All generations of that commit are loaded (a repository can carry a .NET and an Angular generation of the same commit).
6. **Fallback**: no candidate within the limit: the `main-<engine>` tags (or `main`) whose commit is a known ancestor of `HEAD` (`git merge-base --is-ancestor`), the nearest one; otherwise no generation, and every tool says why (sources tried, errors).
7. **Announcement**: every answer starts with one header line. Exact match: generation, engine, commit. Ancestor: `WARNING` with the generation commit, the distance and the number of files changed since (committed diff plus working tree); evidence in those files is marked `[changed]`. A dirty working tree on an exact match is announced too.
8. **Verification before use**: `schemaVersion` major 1, `requiredCapabilities` empty (no capability is known yet), every file listed in the manifest present with its size and SHA-256, `status` reported (`partial` is announced). OCI adds: layer digest and size, tar entries (regular files and folders only, no absolute paths, no `..`), manifest SHA-256 annotation, commit equal to the requested one. A generation that fails is skipped with its reason, never half-used.
9. **No `index.sqlite`**: the generation loads; `generation_info` and `context` work, the query tools say the index is missing.

## Tools

All take optional `generation` (label filter when several are loaded), and the list tools take `limit` and `cursor`. A symbol is an entity id, an exact name, or a qualified tail (`LeasesService.search`); ambiguity lists at most 10 candidates with ids and picks none.

| Tool | Arguments | Answer |
|---|---|---|
| `generation_info` | | workspace, `HEAD`, resolution (source, commit, distance, changed files), engine, contract version, status, coverage, counts, verification, packs, sources tried |
| `search` | `query`, `kind` (`entity`, `snippet`) | FTS5 matches: kind, name or path, one-line text |
| `symbol` | `symbol` | kind, signature, container, declarations `file:line`, counts of references, callers, callees, implementations |
| `refs` | `symbol`, `usage` | references `file:line usage from` with snippet |
| `callers` / `callees` | `symbol`, `depth` (1 to 3) | `calls_declared_target` edges with `file:line`, indented by depth |
| `implementations` | `symbol` | `implements`, `inherits`, `overrides` towards the symbol |
| `di` | `service` (optional) | registrations (lifetime, implementation) and consumers (consumer, via), with `file:line`; without a service: registrations |
| `routes` | `prefix` | UI routes (`ui.route`) and HTTP endpoints (`http.endpoint`) with target and `file:line` |
| `http` | `route` prefix, `method` | outgoing HTTP calls (`http.call`): method, canonical route, resolution, base address source, caller, `file:line` |
| `who_calls` | `route`, `method` | the HTTP calls whose canonical route matches (parameters normalized to `{}`), their caller methods and the callers of those, plus `configured_route` links to endpoints when present |
| `messages` | `contract` | publishers and subscribers (contract, transport, destination) with `file:line` and their links (added with the .NET index additions) |
| `context` | `project` (optional) | without a project: the list of context packs; with one: that card, paged |

## Layout

| Path | Content |
|---|---|
| `src/cli.ts` | `serve` (default), `resolve`, `call <tool> [json]`, `verify <generation>` |
| `src/mcp/` | stdio transport, server, tool definitions |
| `src/resolve/` | workspace Git facts, sources (local, cache, OCI), tar reader, resolver |
| `src/generation/` | manifest verification, index reader, context packs |
| `src/format.ts`, `src/redact.ts` | bounded answers, defensive redaction |
| `tests/unit/` | synthetic generations built in the test, no external data |
| `tests/integration/` | real generations from `_generations`, the lab repositories, MCP clients, local registry |
| `scripts/verify.sh` | Docker build, unit tests, integration tests with mounts, OCI test with a local registry |
| `scripts/mcp-docker.sh` | client launcher (Claude Code, Codex) |

## Test plan

1. **Unit** (in the image test stage): remote URL normalization; route canonicalization; redaction; tar reader (good archive, `..`, absolute path, symlink rejected); manifest verification (good, tampered byte, missing file, unknown capability, major 2); resolver choice on fake sources (exact, ancestor, tie local over registry, nothing); stdio transport framing and errors; every tool on a synthetic generation (pagination, ambiguity, missing index).
2. **Integration, local folders**: `lab-web-angular` against `devos-lab-web` at `e21eef1` (exact match), `eshoponabp-angular` against `_generations/src/eShopOnAbp` at `7bfed7a` (two generations of one commit: Angular with index, .NET without until Step 4 lands); expected answers taken from `devos-lab-web/ground-truth.yml` (routes, HTTP calls).
3. **Ancestor fallback**: a clone of `devos-lab-web` with one extra commit changing a service file: the answer carries the warning, distance 1, and `[changed]` on that file's evidence.
4. **OCI**: a `registry:2` container and ORAS push of `lab-web-angular` in the release layout; the server with local sources off pulls, verifies, caches, answers; a second run answers from the cache with the registry unreachable; `main-angular` is used beyond the window. A corrupted layer, a wrong `revision` and a wrong `manifest-sha256` annotation are refused (unit tests, in-process registry with a Bearer challenge).
5. **MCP clients**: the official SDK client (`StdioClientTransport`) lists the tools and calls each against `lab-web-angular`; a scripted session transcript goes into `docs/reports/`.
6. **.NET**: the same integration tests on the lab .NET generations once they carry `index.sqlite` (Step 4 session).

## Not in scope now

- Publishing the repository, the image, CI: the owner decides (M1).
- Changing the owner's Claude Code or Codex configuration: setup is documented in [USAGE.md](USAGE.md) only.
- System generations: the reader already takes several generations; loading `inputs.ndjson` and cross-repository links waits for the federation output.
