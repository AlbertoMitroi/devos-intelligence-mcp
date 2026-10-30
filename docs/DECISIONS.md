# Decisions

Format per entry: context, options, choice, reason, how to revisit. Status `accepted` means it is in force; `proposed` waits for the owner or the coordinator. Numbers are prefixed `M` so they do not collide with the contract (`C*`, `D*`) or the engines (`A*`).

## M1: Repository home

- **Context:** the server is a consumer of the generations; publishing it is the owner's decision.
- **Choice:** local repository `~/repos/devos/devos-intelligence-mcp` (same conventions as the other `devos-*` repositories); no GitHub repository, no image release, no CI until the owner decides. The planned public name is `AlbertoMitroi/devos-intelligence-mcp`.
- **Revisit:** when the owner publishes it (add CI like the engines: the test stage and `scripts/verify.sh`).
- **Status:** accepted.

## M2: Runtime

- **Context:** the engines run TypeScript on Node.js 24 with type stripping and read SQLite with `node:sqlite`.
- **Options:** the same; Python; .NET.
- **Choice:** Node.js 24 LTS, the base image digest of `devos-angular-intelligence` (`node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`), `git` pinned to the Debian 12 package; `node:sqlite` with FTS5 reads `index.sqlite`. The runtime stage has **no npm dependencies**: MCP transport, OCI client and tar reader are part of the sources.
- **Reason:** one runtime across the TypeScript projects; the same SQLite build the Angular engine writes with; nothing to audit in `node_modules` for a process that reads code of private repositories.
- **Revisit:** when Node 26 becomes LTS.
- **Status:** accepted.

## M3: MCP transport written here, interoperability tested with the official SDK

- **Context:** the server needs `initialize`, `ping`, `tools/list`, `tools/call` over stdio, and asks the client for `roots/list`. The official `@modelcontextprotocol/sdk` 1.32.2 brings 17 direct dependencies (Express, Hono, CORS, rate limiting) for HTTP transports this server does not use.
- **Options:** the SDK at runtime; a small transport in the sources.
- **Choice:** newline-delimited JSON-RPC 2.0 in `src/mcp/server.ts` (about 150 lines), protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (the client's version when known, else the newest). The SDK is a dev dependency: `tests/integration/sdk-client.test.ts` drives the server with the SDK `Client` and `StdioClientTransport`.
- **Reason:** no runtime dependencies (M2); the SDK client proves the server speaks what real clients speak.
- **Revisit:** if the server needs resources, prompts, sampling or an HTTP transport: switch to the SDK server then.
- **Status:** accepted.

## M4: Docker-first, with a launcher; Node on the host as the alternative

- **Context:** an MCP stdio server is a child process of the client; in Docker it needs the working repository inside the container. Git worktrees keep their Git directory outside the working tree (`devos-*.worktrees/` point into `devos-*/.git/worktrees/`).
- **Options:** native only; a plain `docker run -i`; a launcher script.
- **Choice:** `scripts/mcp-docker.sh` runs `docker run -i --rm --init` with the working tree mounted read-only at the same absolute path, the common Git directory too when it lives outside, each generation folder read-only at its path, the cache read-write, the host user id, and registry credentials passed by name. File paths in answers and client roots therefore match the host. `node src/cli.ts serve` with a host Node 24 is documented as the alternative.
- **Reason:** same paths inside and outside; read-only mounts; worktrees work.
- **Revisit:** if a client gains a container-native MCP launcher with the same guarantees.
- **Status:** accepted.

## M5: Resolution order and fallback

- **Context:** the agent works on some commit; a generation exists for that commit, for an ancestor, or not at all; sources are local folders, the cache, a registry.
- **Choice:** candidates are HEAD and its first-parent ancestors (50 by default). Every source answers for the whole list in one pass (one tag listing for the registry). The nearest commit wins; at equal distance local, then cache, then registry. All valid generations of that commit are loaded together (one per engine). Beyond the window, the `main-<engine>` tags are used when their commit is an ancestor of HEAD. Every answer starts with a header naming the generation; an ancestor is a `WARNING` with the distance and the files changed since, and evidence in changed files is marked `[changed]`. Repository identity is the normalized `origin` URL; a side without a remote matches on commit only. A resolution is reused while HEAD is unchanged; a miss is retried after a minute.
- **Reason:** the nearest generation is the most accurate; an exact local generation avoids network; announcing the distance in every answer keeps a stale answer from passing as current.
- **Revisit:** if merge commits make first-parent ancestry miss a closer generation on a side branch.
- **Status:** accepted.

## M6: OCI client and artifact layout

- **Context:** the release session publishes generations to GHCR with ORAS. Layout agreed through the coordinator (notes folder, `release-and-lab-publishing.md`): `ghcr.io/<owner>/context-<repo>:<full sha>-<engine>` and `:main-<engine>`, artifact type `application/vnd.devos.intelligence.generation.v1`, one layer `generation.tar.gz` of media type `application/vnd.devos.intelligence.generation.v1.tar+gzip`, manifest annotations `org.opencontainers.image.source`, `.revision`, `.ref.name`, `dev.devos.intelligence.engine`, layer annotation `dev.devos.intelligence.manifest-sha256`.
- **Options:** shell out to ORAS; a registry client library; the distribution API over `fetch`.
- **Choice:** the distribution API v2 over `fetch` (`src/resolve/oci.ts`): Bearer challenge, anonymous first; when the anonymous token is refused (401, 403), credentials from the environment, the Docker configuration (`auths`, `credHelpers`, `credsStore` helpers) and `gh auth token` (ghcr.io only) are tried once each (`src/resolve/credentials.ts`), the accepted source is reported and the value never is; tag listing with `Link` pagination, manifest and blob digests checked, size limit (1 GiB). Layers are extracted by `src/resolve/tar.ts` (files and folders only; links, devices, absolute paths and `..` refused) into a temporary folder, verified (generation checks, requested commit, `revision` and `manifest-sha256` annotations), then renamed into the cache. Bare `<sha>` and `main` tags and `application/gzip` layers (the older example workflow) are read too.
- **Reason:** no dependency (M2); every check is in one place and tested against an in-process registry (unit) and `registry:2` with ORAS pushes (integration).
- **Revisit:** if GHCR changes its token flow or artifacts move to OCI referrers.
- **Status:** accepted (layout agreed with the release session).

## M7: Engine-neutral reader, several generations at once

- **Context:** the Angular engine writes `index.sqlite` today (`devos-angular-intelligence/src/artifacts/sqlite.ts`); the .NET engine adds it in Step 4 with the same schema; federation will produce system generations.
- **Choice:** `src/generation/index-reader.ts` requires only the Angular tables (`meta`, `entities`, `declarations`, `evidence`, `relations`, `observations`, `links`, optional `search`) and the contract kinds; observation details come from the canonical JSON column. The .NET additions accepted by the coordinator (notes folder, `dotnet-step4-index-query-proposal.md`) are optional: `relation_evidence` gives `refs` one row per usage, `possible_runtime_target` edges show in `callers` and `callees` as candidates, search kind `observation` is searchable, `meta.indexSchema` is reported, `messages` lists `messaging.publish` and `messaging.subscribe` with their links. A partial generation adds a note to every empty answer. A missing table refuses the index with the reason; a missing `index.sqlite` keeps `generation_info` and `context` working. Every tool runs over a list of loaded generations and tags items with the generation label when there are several.
- **Reason:** the reader does not need to know the engine; a repository with two engines (eShopOnAbp) and later the inputs of a system generation fit the same model.
- **Revisit:** when the schema moves into the contract (Q1); the .NET-only `trace` verb could become a tool once its rows are stable.
- **Status:** accepted.

## M8: Bounded answers and defensive redaction

- **Context:** the agent should never receive a generation, only answers; snippets are already redacted by the engines.
- **Choice:** list tools page with `limit` (default 20, max 100) and an opaque `cursor` and print the total; snippets are one line of at most 160 characters; context cards are paged at 6000 characters; candidate lists stop at 10. Snippet text passes a second redaction (`src/redact.ts`: secret-named assignments, URL credentials, JWTs, bearer tokens, long hex and mixed base64 runs; Git object ids kept). Answers are plain text, `file:line` first.
- **Reason:** predictable context cost for the agent; a missed secret in an engine does not reach the agent through this server.
- **Revisit:** if clients start using `structuredContent`: add it next to the text.
- **Status:** accepted.
