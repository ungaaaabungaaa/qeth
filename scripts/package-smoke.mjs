import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { startFixture } from './fixture-server.mjs';
const execute = promisify(execFile);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run through npm run smoke:package.');
const npm = args => execute(process.execPath, [npmCli, ...args], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
const dir = await mkdtemp(join(tmpdir(), 'qeth-package-'));
let site;
try {
  await npm(['run', 'build']);
  const packed = JSON.parse((await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', dir])).stdout)[0];
  assert.ok(packed.files.some(file => file.path === 'dist/cli.js'));
  assert.ok(!packed.files.some(file => /(^src\/|^tests\/|\.env|style\.css|image-draft)/.test(file.path)));
  const prefix = join(dir, 'install');
  await npm(['install', '--global', '--prefix', prefix, '--cache', join(dir, 'cache'), '--ignore-scripts', '--no-audit', '--no-fund', join(dir, packed.filename)]);
  const modules = process.platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
  const cli = join(modules, 'qeth', 'dist', 'cli.js');
  await access(process.platform === 'win32' ? join(prefix, 'qeth.cmd') : join(prefix, 'bin', 'qeth'));
  const run = args => execute(process.execPath, [cli, ...args], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  assert.match((await run(['--help'])).stdout, /qeth mission plan/);
  assert.equal((await run(['--version'])).stdout.trim(), packed.version);
  site = await startFixture();
  const cases = [
    [['rag', 'scan', 'examples/chunks.json', '--json'], 'rag-scan'],
    [['trace', 'examples/trace.json', '--json'], 'trace'],
    [['crawl', site.url, '--allow-local', '--delay', '0', '--json'], 'crawl'],
    [['mission', 'plan', 'examples/survey-area.geojson', '--json'], 'mission-plan']
  ];
  for (const [args, kind] of cases) {
    const { stdout } = await run(args);
    assert.equal(JSON.parse(stdout).kind, kind);
  }
  const library = await import(pathToFileURL(join(modules, 'qeth', 'dist', 'index.js')).href);
  assert.equal(library.analyzeTrace({ events: [] }).eventCount, 0);
  process.stdout.write(`Installed qeth ${packed.version}: help, version, all four commands, and library import passed. Tarball: ${packed.size} bytes.\n`);
} finally { await site?.close(); await rm(dir, { recursive: true, force: true }); }
