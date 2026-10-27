import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDocuments } from '../src/rag.ts';

test('RAG scan measures duplicate content and missing metadata independently', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qeth-rag-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'chunks.json'), JSON.stringify([
    { id: 'a', text: 'one two', metadata: { source: 'a' }, embedding: [1, 2] },
    { id: 'b', text: 'one  two', embedding: [1, 2, 3] },
    { id: 'a', text: 'different', metadata: {} }
  ]));
  const report = await scanDocuments(dir);
  assert.equal(report.fileCount, 1);
  assert.equal(report.chunkCount, 3);
  assert.deepEqual(report.duplicateGroups[0].chunks.map(c => c.id), ['a', 'b']);
  assert.equal(report.duplicateIds[0].id, 'a');
  assert.equal(report.missingMetadata.length, 2);
  assert.equal(report.embedding.provided, 2);
  assert.equal(report.embedding.missing, 1);
  assert.equal(report.embedding.dimensionMismatches.length, 1);
});

test('RAG scan bounds record/report expansion for compact JSON and JSONL inputs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qeth-rag-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const json = join(dir, 'many.json'), jsonl = join(dir, 'many.jsonl');
  await writeFile(json, JSON.stringify(Array(10001).fill(0)));
  await assert.rejects(scanDocuments(json), error => error.exitCode === 2 && /10000.*record/i.test(error.message));
  await writeFile(jsonl, '0\n'.repeat(10001));
  await assert.rejects(scanDocuments(jsonl), error => error.exitCode === 2 && /10000.*record/i.test(error.message));
});

test('RAG scan excludes explicit hidden and vendor targets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qeth-rag-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, '.hidden.txt'), 'private');
  await mkdir(join(dir, 'node_modules'));
  await writeFile(join(dir, 'node_modules', 'data.txt'), 'dependency');
  await assert.rejects(scanDocuments(join(dir, '.hidden.txt')), /excluded/);
  await assert.rejects(scanDocuments(join(dir, 'node_modules')), /excluded/);
  const report = await scanDocuments(dir);
  assert.equal(report.fileCount, 0);
  assert.equal(report.warnings.length, 1);
});

test('RAG scan rejects invalid UTF-8 as input data', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qeth-rag-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'invalid.txt');
  await writeFile(file, Buffer.from([0xff, 0xfe, 0xff]));
  await assert.rejects(scanDocuments(file), error => error.exitCode === 2 && /UTF-8/.test(error.message));
});
