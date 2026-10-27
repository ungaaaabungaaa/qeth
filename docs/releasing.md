# Release process

1. Update `package.json`, its lockfile, and `CHANGELOG.md`. Package metadata is the version source used by the executable and crawler user agent.
2. Run `npm ci`, `npm run check`, `npm run test:coverage`, and `npm run smoke:package`. Review CI on supported operating systems and Node versions. For package-manager compatibility changes, install the same tarball with pnpm, Bun, and Yarn, then run help, version, and all four commands against local fixtures. Include Yarn's default Plug'n'Play mode; see [the package manager guide](package-managers.md).
3. Review `npm pack --dry-run`. The package allowlist includes compiled code, examples, the command contract, and license/readme files. It excludes credentials, source tests, image drafts, and repository history.
4. Commit and push. Verify the remote commit and green CI before tagging a release.
5. For the first public release, sign in with the intended npm account and verify it with `npm whoami`. Recheck that the approved package name can be claimed. Follow npm's current authentication challenge; never place a token in source or chat.
6. Publish the verified package with `npm publish --access public`. Read back the registry version and test fresh registry installs with npm, pnpm, Bun, and Yarn. One npm publication serves all four package managers. Update the README and changelog only after publication is confirmed.
7. Tag the verified release with `vVERSION` and add release notes. For later releases, configure npm trusted publishing for this repository's `release.yml` workflow and `npm` environment, then use the manual release workflow. The workflow has no stored npm token. Configuration needs an npm maintainer with the required account access.

The release workflow does not create an npm account, reserve a package name, or configure trusted publishing. An unconfigured publisher fails closed. Keep GitHub release status distinct from npm publication status.

Primary references: [npm public packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/), [trusted publishing](https://docs.npmjs.com/trusted-publishers/), and [publishing authentication](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).
