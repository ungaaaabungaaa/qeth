import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDocuments } from '../src/rag.ts';
import { readJsonInput } from '../src/io.ts';

test('bounded JSON readers work with virtual file handles that require an explicit read length', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'qeth-file-readers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'chunks.json');
  const input = { chunks: [{ id: 'large', text: 'Measured local input. '.repeat(7000), metadata: { source: 'fixture' } }] };
  await fs.writeFile(file, JSON.stringify(input));
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    // Yarn 4 PnP's FileHandle treats an omitted length as a zero-byte read.
    handle.read = (buffer, offset = 0, length = 0, position = null) => read(buffer, offset, length, position);
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(await readJsonInput(file), input);
  const report = await scanDocuments(file);
  assert.equal(report.fileCount, 1);
  assert.equal(report.chunkCount, 1);
  assert.equal(report.invalidRecords.length, 0);
});
