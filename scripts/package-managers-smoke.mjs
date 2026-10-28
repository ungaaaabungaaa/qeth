// Explicit release check: registry downloads happen only when this script is requested.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFixture } from './fixture-server.mjs';
const execute = promisify(execFile);
const clients = {
  npm: null,
  pnpm: { package: 'pnpm@12.15.0', entry: 'pnpm/bin/pnpm.mjs' },
  'yarn-classic': { package: 'yarn@1.22.22', entry: 'yarn/bin/yarn.js' },
  'yarn-pnp': { package: '@yarnpkg/cli-dist@4.18.1', entry: '@yarnpkg/cli-dist/bin/yarn.js' }
};
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('Usage: npm run smoke:clients -- [npm|pnpm|yarn-classic|yarn-pnp]\nNo argument checks all four sequentially. Downloads tools and installs one tarball in temporary folders; never installs globally. Bun remains a separate manual check.\n');
} else if (args.length > 1 || (args.length === 1 && !Object.hasOwn(clients, args[0]))) {
  process.stderr.write('Unknown package manager. Use npm, pnpm, yarn-classic, or yarn-pnp.\n');
  process.exitCode = 2;
} else {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run through npm run smoke:clients.');
  const root = await mkdtemp(join(tmpdir(), 'qeth-clients-'));
  let site;
  try {
    const env = { ...process.env, npm_config_cache: join(root, 'npm-cache'), npm_config_update_notifier: 'false', PNPM_HOME: join(root, 'pnpm-home'), XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_DATA_HOME: join(root, 'xdg-data') };
    const run = (entry, command, cwd, timeout = 180000) => execute(process.execPath, [entry, ...command],
      { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
    await run(npmCli, ['run', 'build'], process.cwd());
    const packed = JSON.parse((await run(npmCli, ['pack', '--json', '--ignore-scripts', '--pack-destination', root], process.cwd())).stdout)[0];
    const tarball = join(root, packed.filename);
    site = await startFixture();
    for (const name of args.length ? args : Object.keys(clients)) {
      const project = join(root, name), bootstrap = join(root, `${name}-tool`);
      await mkdir(project);
      await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'qeth-client-check', version: '1.0.0', private: true, scripts: { qeth: 'qeth' } }));
      let entry = npmCli;
      if (clients[name]) {
        await run(npmCli, ['install', '--prefix', bootstrap, '--ignore-scripts', '--no-audit', '--no-fund', clients[name].package], project);
        entry = join(bootstrap, 'node_modules', clients[name].entry);
      }
      if (name === 'yarn-pnp') await writeFile(join(project, '.yarnrc.yml'),
        'nodeLinker: pnp\nenableGlobalCache: false\nenableTelemetry: false\nenableScripts: false\nnpmRegistryServer: "https://registry.npmjs.org"\n');
      const install = name === 'npm' ? ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball] :
        name === 'pnpm' ? ['add', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store'), tarball] :
        name === 'yarn-classic' ? ['add', '--ignore-scripts', '--non-interactive', '--no-progress', '--cache-folder', join(root, 'yarn-cache'), '--registry', 'https://registry.npmjs.org', tarball] :
        ['add', `${packed.name}@file:${tarball}`];
      await run(entry, install, project);
      const prefix = name === 'npm' ? ['run', '--silent', 'qeth', '--'] :
        name === 'yarn-pnp' ? ['exec', 'qeth'] : ['--silent', 'run', 'qeth'];
      const cli = command => run(entry, [...prefix, ...command], project, 15000);
      assert.match((await cli(['--help'])).stdout, /qeth mission plan/);
      assert.equal((await cli(['--version'])).stdout.trim(), packed.version);
      const cases = [
        [['rag', 'scan', resolve('examples/chunks.json'), '--json'], 'rag-scan'],
        [['trace', resolve('examples/trace.json'), '--timeline-limit', '1', '--json'], 'trace'],
        [['crawl', site.url, '--allow-local', '--delay', '0', '--json'], 'crawl'],
        [['mission', 'plan', resolve('examples/survey-area.geojson'), '--json'], 'mission-plan']
      ];
      for (const [command, kind] of cases) {
        const report = JSON.parse((await cli(command)).stdout);
        assert.equal(report.kind, kind);
        if (kind === 'trace') assert.equal(report.timeline.events.length, 1);
      }
      const checkImport = `import {analyzeTrace} from ${JSON.stringify(packed.name)}; if(analyzeTrace({events:[]}).eventCount!==0) process.exit(1);`;
      if (name === 'yarn-pnp') await run(entry, ['node', '--input-type=module', '-e', checkImport], project, 15000);
      else await execute(process.execPath, ['--input-type=module', '-e', checkImport], { cwd: project, env, timeout: 15000 });
      process.stdout.write(`${name}: help, version, four commands and library import passed from ${packed.filename}.\n`);
    }
    process.stdout.write(`One exact ${packed.size}-byte tarball checked. Temporary installs and caches removed on exit.\n`);
  } finally {
    await site?.close();
    await rm(root, { recursive: true, force: true });
  }
}
