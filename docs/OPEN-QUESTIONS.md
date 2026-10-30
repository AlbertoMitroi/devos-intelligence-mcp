# Open questions

| # | Question | For | State |
|---|---|---|---|
| Q1 | The shared `index.sqlite` schema (Angular tables plus the .NET additions) is accepted by the coordinator; should it also become a contract document with a drift check in both engines and here? | coordinator, contract owner | accepted as convention; contract text not written |
| Q2 | System generations (federation): the reader loads several generations already; it still needs `inputs.ndjson` to label inputs and cross-repository links so that `who_calls` answers across repositories. | federation session | waits for the first system generation |
| Q3 | The `context-*` packages are created private. Public packages let the server pull without a token; private ones need a token with `read:packages` (environment, `docker login ghcr.io` or `gh` with that scope) on every machine. | owner | open |
| Q4 | Publishing this repository (GitHub, image, CI). | owner | open (M1) |
