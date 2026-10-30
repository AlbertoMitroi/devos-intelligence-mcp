# Open questions

| # | Question | For | State |
|---|---|---|---|
| Q1 | The shared `index.sqlite` schema as a contract document with a drift check. | coordinator, contract owner | resolved: `schema/index/v1/index.sql` in contract v1.2.0, vendored here with a drift test |
| Q2 | System generations (federation): the reader loads several generations already; it still needs `inputs.ndjson` to label inputs and cross-repository links so that `who_calls` answers across repositories. | federation session | waits for the first system generation |
| Q3 | The `context-*` packages are created private. | owner | resolved: the lab packages are public (anonymous pull tested 2026-10-30); private ones keep working with a token |
| Q4 | Publishing this repository (GitHub, image, CI). | owner | open (M1) |
