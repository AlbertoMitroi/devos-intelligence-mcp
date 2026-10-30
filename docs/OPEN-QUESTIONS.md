# Open questions

| # | Question | For | State |
|---|---|---|---|
| Q1 | Should the `index.sqlite` schema (tables, columns, FTS5 `search` table) become part of the contract, so the .NET engine, the Angular engine and this reader share one definition and a drift check? Today it is defined by the Angular engine's `src/artifacts/sqlite.ts` and copied by convention. | coordinator, contract owner | proposed; not edited in `devos-intelligence-contract` |
| Q2 | System generations (federation): the reader loads several generations already; it still needs `inputs.ndjson` to label inputs and cross-repository links so that `who_calls` answers across repositories. | federation session | waits for the first system generation |
| Q3 | The `context-*` packages are created private. Public packages let the server pull without a token; private ones need `DEVOS_MCP_REGISTRY_TOKEN` on every machine. | owner | open |
| Q4 | Publishing this repository (GitHub, image, CI). | owner | open (M1) |
