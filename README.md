# devos-intelligence-mcp

An MCP server that answers AI agents (Claude Code, Codex) from the intelligence generations of the repository they work in: semantic graph, observations and context packs written by `devos-dotnet-intelligence` and `devos-angular-intelligence` in the shared [intelligence contract](../devos-intelligence-contract). The agent never receives a generation, only compact answers with `file:line` evidence and short redacted snippets.

**Status:** 14 tools over `index.sqlite` and context packs; generation resolved from local folders, the OCI cache or GHCR (`context-<repo>:<sha>-<engine>`, private packages through the environment, the Docker credential store or `gh`), nearest analyzed ancestor announced in every answer; the index is read by contract v1.2.0 `index.sql` (vendored, drift-checked), the optional evidence tables and `site` are used when present. Federation system generations answer across repositories (`who_calls`, `trace`, `messages`), each location labelled with its repository. Tested against the real public packages on ghcr.io for `devos-lab-web` (Angular) and `devos-lab-leasing` (.NET). Unit and integration tests pass locally (`scripts/verify.sh`), including the official MCP SDK client and a `registry:2` round trip in the release layout. Public at [AlbertoMitroi/devos-intelligence-mcp](https://github.com/AlbertoMitroi/devos-intelligence-mcp); CI runs the unit tests, the image and anonymous pulls from ghcr.io on amd64 and arm64.

## Use

```bash
docker build --target runtime -t devos-intelligence-mcp:local .
```

```bash
claude mcp add devos-intelligence --scope user -- ~/repos/devos/devos-intelligence-mcp/scripts/mcp-docker.sh
```

Codex, configuration and tool list: [docs/USAGE.md](docs/USAGE.md).

## Develop

Docker and git are needed; the tests read the sibling folders (`_generations`, `devos-lab-web`).

```bash
scripts/verify.sh
```

With Node.js 24.22 or later on the host, `npm ci` then `npm test` runs the unit tests.

## Documents

- Plan: [docs/PLAN.md](docs/PLAN.md)
- Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
- Usage: [docs/USAGE.md](docs/USAGE.md)
- Open questions: [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)
- Dependencies and licenses: [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)
- Reports: [docs/reports/](docs/reports/)

## License

MIT, see [LICENSE](LICENSE).
