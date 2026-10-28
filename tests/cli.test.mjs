import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = promisify(execFile);
const run = (...args) => execute(process.execPath, ['--experimental-strip-types', 'src/cli.ts', ...args], { timeout: 15000 });

test('CLI exposes help, package version, and a measured JSON document report', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qeth-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'note.md');
  await writeFile(file, 'A local test document.');
  const help = await run('--help');
  assert.match(help.stdout, /qeth rag scan/);
  assert.match(help.stdout, /qeth mission plan/);
  const metadata = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal((await run('--version')).stdout.trim(), metadata.version);
  const { stdout, stderr } = await run('rag', 'scan', file, '--json');
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(report.kind, 'rag-scan');
  assert.equal(report.fileCount, 1);
  assert.equal(report.chunkCount, 1);
});

test('CLI human trace output shows measured baseline changes and unknown comparisons', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qeth-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'run.json'), baseline = join(dir, 'base.json');
  const event = { name: 'tool', startMs: 0, endMs: 1, status: 'ok', tokens: { input: 3, output: 1 } };
  await writeFile(file, JSON.stringify({ events: [event, event] }));
  await writeFile(baseline, JSON.stringify({ events: [event] }));
  assert.match((await run('trace', file, '--baseline', baseline)).stdout, /Baseline token change: \+4 \(\+100\.0%\)/);
  await writeFile(file, JSON.stringify({ events: [{ name: 'unknown', startMs: 0, endMs: 1, status: 'ok' }] }));
  assert.match((await run('trace', file, '--baseline', baseline)).stdout, /Baseline comparison: unavailable/);
});

test('CLI writes new JSON reports and refuses to overwrite existing files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qeth-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'trace.json'), output = join(dir, 'report.json');
  await writeFile(file, JSON.stringify({ events: [] }));
  const { stdout } = await run('trace', file, '--json', '--out', output);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), JSON.parse(stdout));
  await assert.rejects(run('trace', file, '--out', output), error => error.code === 2 && /already exists/.test(error.stderr));
  await writeFile(file, '{ bad JSON');
  await assert.rejects(run('trace', file), error => error.code === 2);
  await assert.rejects(run('trace', join(dir, 'missing.json')), error => error.code === 1);
  const geometry = join(dir, 'area.geojson');
  await writeFile(geometry, JSON.stringify({ type: 'Polygon', coordinates: [[[77.59,12.97],[77.591,12.97],[77.591,12.971],[77.59,12.971],[77.59,12.97]]] }));
  const mission = JSON.parse((await run('mission', 'plan', geometry, '--spacing', '30', '--json')).stdout);
  assert.equal(mission.kind, 'mission-plan');
  assert.ok(mission.distanceM > 0);
  await assert.rejects(run('mission', 'plan', geometry, '--spacing', 'NaN'), error => error.code === 2);
  await assert.rejects(run('mission', 'plan', geometry, '--optimize', 'unknown'), error => error.code === 2);
  assert.equal(JSON.parse((await run('doctor', '--json')).stdout).basicCommandsNeedAccount, false);
});

test('CLI rejects unknown commands even with help and rejects misplaced options', async () => {
  for (const args of [['typo', '--help'], ['trace', 'x.json', '--spacing', '4'], ['--unknown'], ['mission', 'plan']]) {
    await assert.rejects(run(...args), error => error.code === 2 && error.stdout === '' && !/^\s+at\s/m.test(error.stderr));
  }
});


test('CLI exports bounded trace timelines and rejects invalid or misplaced limits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qeth-timeline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'trace.json'), output = join(dir, 'timeline.json');
  await writeFile(file, JSON.stringify({ events: [
    { name: 'late', startMs: 10, endMs: 20, status: 'ok' },
    { name: 'early', startMs: 0, endMs: 15, status: 'error' }
  ] }));
  const { stdout, stderr } = await run('trace', file, '--timeline-limit', '1', '--json', '--out', output);
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(report.timeline.events[0].name, 'early');
  assert.equal(report.timeline.omittedEvents, 1);
  assert.equal(report.eventCount, 2);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report);
  assert.match((await run('trace', file, '--timeline-limit', '1')).stdout, /Timeline: 1 included; 1 omitted/);
  for (const value of ['0', '1.5', '1001', 'NaN']) {
    await assert.rejects(run('trace', file, '--timeline-limit', value), error => error.code === 2 && error.stdout === '');
  }
  await assert.rejects(run('doctor', '--timeline-limit', '1'), error => error.code === 2);
});
