# Feature queue

Delivered 28 October 2026: bounded trace timeline export through the CLI and library. Full aggregates remain independent of the timeline limit. Existing report shape is unchanged without the option.

Final round, 28 October 2026: automated isolated exact-tarball checks for npm, pnpm, Yarn Classic and Yarn PnP, plus four Linux CI jobs. Registry downloads occur only in this explicit check. Bun remains manual.

Remaining work (daily feature automation stopped):
- Automate Bun installation checks and expand client OS coverage where needed.
- Add small report-schema examples for consumers.

Package publication and publisher verification are separate from source changes.
