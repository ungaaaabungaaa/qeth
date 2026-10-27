# Package managers

Qeth is one npm package. npm, pnpm, Bun, and Yarn can install that same package. Qeth's CLI requires Node.js 22.18 or newer on `PATH`. Bun respects the CLI's `node` shebang; these instructions do not switch execution to Bun's runtime.

The first public release is pending. The registry commands below become available after publication.

## Global and one-time use

| Client | Global install | One-time command |
| --- | --- | --- |
| npm | `npm install -g qeth` | `npx qeth --help` |
| pnpm | `pnpm add -g qeth` | `pnpm dlx qeth --help` |
| Bun | `bun add -g qeth` | `bunx qeth --help` |
| Yarn 2+ | Use `yarn dlx` | `yarn dlx qeth --help` |
| Yarn Classic 1.x | `yarn global add qeth` | `yarn qeth --help` after a local install |

Choose one global install method. Each global method adds the same `qeth` command. Its package manager's global binary directory must be on `PATH`. If pnpm reports that this directory is missing, follow pnpm's setup instructions before retrying. Modern Yarn uses `dlx` for temporary CLI execution and does not provide Classic's global command.

To select a release, append its version to the package name. For example, after version 0.1.0 is published:

```sh
pnpm dlx qeth@0.1.0 --version
bunx qeth@0.1.0 --version
yarn dlx qeth@0.1.0 --version
```

## Add to a project

Use your project's existing package manager and lockfile:

```sh
npm install --save-dev qeth
# or
pnpm add -D qeth
# or
bun add -d qeth
# or
yarn add -D qeth
```

Then add a script to your project's `package.json`:

```json
{
  "scripts": {
    "inspect:docs": "qeth rag scan ./docs"
  }
}
```

Run it with `npm run inspect:docs`, `pnpm run inspect:docs`, `bun run inspect:docs`, or `yarn run inspect:docs`. The script uses the project's installed Qeth version.

## Compatibility checks

On 27 October 2026, the same pre-release tarball was checked on macOS arm64 with Node.js 24.18.0:

| Client | Mode checked | Result |
| --- | --- | --- |
| npm 11.16.0 | Isolated global install | Help, version, four commands, library import |
| pnpm 12.15.0 | Isolated global install | Help, version, four commands, library import |
| Bun 1.4.4 | Isolated global install, Node execution | Help, version, four commands, library import |
| Yarn Classic 1.22.22 | Isolated global install | Help, version, four commands, library import |
| Yarn 4.18.1 | `dlx`, default Plug'n'Play | Help, version, four commands |

The crawl check used a local HTTP fixture. RAG, trace, and mission checks used the repository's example files. These checks verify installation from a tarball; registry name resolution still needs verification after publication. Package-manager checks on other operating systems have not been run. The core npm CI matrix separately checks Node.js 22 and 24 on Linux, macOS, and Windows.

Qeth passes an explicit buffer offset, length, and file position to bounded file reads. This also works with Yarn's virtual file handles, which can treat an omitted length as a zero-byte read. A regression test covers JSON inputs larger than one read buffer through that adapter behavior.

For a release check, build once and install the resulting `npm pack` tarball into disposable package-manager folders. Run `--help`, `--version`, `rag scan`, `trace`, `crawl`, and `mission plan` through each installed executable. Use the same example inputs and local crawl fixture as `npm run smoke:package`. Use fresh caches when checking a changed tarball. Remove those temporary installs and caches after the checks.

Primary references: [Bun global installs](https://bun.sh/docs/pm/cli/add), [Bun executable behavior](https://bun.sh/docs/pm/bunx), [pnpm add](https://pnpm.io/cli/add), [pnpm dlx](https://pnpm.io/cli/dlx), and [Yarn dlx](https://yarnpkg.com/cli/dlx).
