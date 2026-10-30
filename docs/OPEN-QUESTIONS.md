# Open questions

| # | Question | For | State |
|---|---|---|---|
| Q1 | The shared `index.sqlite` schema as a contract document with a drift check. | coordinator, contract owner | resolved: `schema/index/v1/index.sql` in contract v1.2.0, vendored here with a drift test |
| Q2 | System generations (federation). | federation session | resolved: decision M9, tested on `lab-system` and `eshoponabp-system` |
| Q3 | The `context-*` packages are created private. | owner | resolved: the lab packages are public (anonymous pull tested 2026-10-30); private ones keep working with a token |
| Q4 | Publishing this repository (GitHub, image, CI). | owner | resolved: public repository and CI (M1); image release open |
| Q5 | Publishing system generations as OCI artifacts (today they are read from local folders only). | coordinator, federation | open |
