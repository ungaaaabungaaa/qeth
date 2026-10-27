# Contributing

Use Node.js 22.18 or newer. Run `npm ci`, then `npm run check` and `npm run smoke:package`.

For a bug report, include the Qeth and Node versions, the command, a small non-sensitive input, the expected result, and the actual result. Do not submit documents, traces, tokens, or personal data that you cannot share publicly.

Keep changes focused. Add behavior tests for fixes and new features. Use local fixture servers for network tests. Do not contact outside sites from the test suite. Update `docs/cli-contract.md` before changing report fields, input schemas, limits, or exit codes. Record user-visible changes in `CHANGELOG.md`.

Run the installed-package smoke check before proposing a release. It verifies the files end users receive, independently of source execution.
