import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

test('client smoke help explains the isolated network check without installing', async () => {
  const { stdout, stderr } = await execute(process.execPath, ['scripts/package-managers-smoke.mjs', '--help'], { timeout: 5000 });
  assert.equal(stderr, '');
  for (const name of ['npm', 'pnpm', 'yarn-classic', 'yarn-pnp']) assert.ok(stdout.includes(name));
  assert.match(stdout, /temporary/);
});

test('client smoke rejects unknown managers before running installers', async () => {
  await assert.rejects(execute(process.execPath, ['scripts/package-managers-smoke.mjs', 'unknown'], { timeout: 5000 }),
    error => error.code === 2 && /Unknown package manager/.test(error.stderr) && error.stdout === '');
});
