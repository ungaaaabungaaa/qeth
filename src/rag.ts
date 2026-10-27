import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, opendir, open } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { QethError } from './errors.ts';

export interface ChunkRef { file: string; record: number; id: string | null }
interface Issue { location: string; reason: string }
export interface RagOptions { chunkSize?: number }
export interface RagReport {
  schemaVersion: 1; kind: 'rag-scan'; fileCount: number; chunkCount: number;
  duplicateGroups: { hash: string; chunks: ChunkRef[] }[];
  duplicateIds: { id: string; chunks: ChunkRef[] }[];
  missingMetadata: ChunkRef[]; invalidRecords: Issue[];
  embedding: { provided: number; missing: number; dimensions: number[]; invalid: Issue[]; dimensionMismatches: Issue[] };
  warnings: string[];
}
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;
const MAX_RECORDS = 10000;
const supported = new Set(['.txt', '.md', '.mdx', '.json', '.jsonl']);
const ignored = new Set(['node_modules', 'vendor', 'dist', 'build']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function discover(target: string): Promise<string[]> {
  const files: string[] = [];
  let visited = 0;
  async function visit(path: string, depth: number, explicit = false): Promise<void> {
    if (++visited > 10000 || depth > 32) throw new QethError('Directory traversal exceeds the scan limit.');
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      if (explicit) throw new QethError('The scan target must not be a symbolic link.');
      return;
    }
    if (basename(path).startsWith('.') || ignored.has(basename(path))) {
      if (explicit) throw new QethError('The scan target is excluded by the hidden/vendor directory rules.');
      return;
    }
    if (info.isDirectory()) {
      const entries: string[] = [];
      for await (const entry of await opendir(path)) {
        if (entries.length + visited >= 10000) throw new QethError('Directory traversal exceeds the scan limit.');
        entries.push(entry.name);
      }
      for (const name of entries.sort()) await visit(join(path, name), depth + 1);
    } else if (info.isFile() && supported.has(extname(path).toLowerCase())) {
      files.push(path);
      if (files.length > 1000) throw new QethError('A scan can include at most 1000 files.');
    } else if (explicit) throw new QethError('Use a directory or a supported text, Markdown, JSON, or JSONL file.');
  }
  await visit(target, 0, true);
  return files;
}

async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE) throw new QethError(`File exceeds 5 MiB or is not a regular file: ${basename(path)}`);
    const parts: Buffer[] = [];
    let count = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, MAX_FILE + 1 - count));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > MAX_FILE) throw new QethError(`File exceeds 5 MiB: ${basename(path)}`);
      parts.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(parts);
  } finally { await handle.close(); }
}

function* recordsFromJson(text: string, file: string, jsonl: boolean, remaining: number): Generator<unknown> {
  try {
    if (jsonl) {
      let count = 0;
      for (const match of text.matchAll(/[^\r\n]+/g)) {
        if (!match[0].trim()) continue;
        if (++count > remaining) throw new QethError('A scan can process at most 10000 records, including invalid records.');
        yield JSON.parse(match[0]) as unknown;
      }
      return;
    }
    const value: unknown = JSON.parse(text);
    let records: unknown[];
    if (Array.isArray(value)) records = value;
    else if (object(value) && 'chunks' in value) {
      if (!Array.isArray(value.chunks)) throw new Error('chunks must be an array');
      records = value.chunks;
    } else records = [value];
    if (records.length > remaining) throw new QethError('A scan can process at most 10000 records, including invalid records.');
    yield* records;
  } catch (error) { if (error instanceof QethError) throw error; throw new QethError(`Invalid JSON or chunk container: ${file}`); }
}

function newReport(): RagReport {
  return { schemaVersion: 1, kind: 'rag-scan', fileCount: 0, chunkCount: 0, duplicateGroups: [], duplicateIds: [],
    missingMetadata: [], invalidRecords: [], embedding: { provided: 0, missing: 0, dimensions: [], invalid: [], dimensionMismatches: [] }, warnings: [] };
}

export async function scanDocuments(path: string, options: RagOptions = {}): Promise<RagReport> {
  const chunkSize = options.chunkSize ?? 1000;
  if (!Number.isInteger(chunkSize) || chunkSize < 100 || chunkSize > 100000) throw new QethError('chunk-size must be an integer from 100 to 100000.');
  const report = newReport();
  const hashes = new Map<string, ChunkRef[]>();
  const ids = new Map<string, ChunkRef[]>();
  const dimensions = new Set<number>();
  let firstDimension: number | undefined;
  let totalBytes = 0;
  let processedRecords = 0;
  function add(value: unknown, file: string, index: number): void {
    if (++processedRecords > MAX_RECORDS) throw new QethError('A scan can process at most 10000 records, including invalid records.');
    const location = `${file}:${index}`;
    if (!object(value) || typeof value.text !== 'string' || !value.text.trim()) {
      report.invalidRecords.push({ location, reason: 'Record must have nonempty text.' });
      return;
    }
    const id = typeof value.id === 'string' && value.id.trim() ? value.id : null;
    const ref: ChunkRef = { file, record: index, id };
    report.chunkCount++;
    if (id === null) report.invalidRecords.push({ location, reason: 'Record must have a nonempty string id.' });
    else { const group = ids.get(id) ?? []; group.push(ref); ids.set(id, group); }
    if (!object(value.metadata) || !Object.keys(value.metadata).length) report.missingMetadata.push(ref);
    const hash = createHash('sha256').update(value.text.trim().replace(/\s+/g, ' ')).digest('hex');
    const group = hashes.get(hash) ?? []; group.push(ref); hashes.set(hash, group);
    if (value.embedding === undefined) { report.embedding.missing++; return; }
    report.embedding.provided++;
    if (!Array.isArray(value.embedding) || !value.embedding.length || !value.embedding.every(n => typeof n === 'number' && Number.isFinite(n))) {
      report.embedding.invalid.push({ location, reason: 'Embedding must be a nonempty finite numeric array.' });
      return;
    }
    const dimension = value.embedding.length;
    dimensions.add(dimension);
    firstDimension ??= dimension;
    if (dimension !== firstDimension) report.embedding.dimensionMismatches.push({ location, reason: `Expected ${firstDimension} dimensions; found ${dimension}.` });
  }
  try {
    const target = resolve(path);
    const root = (await lstat(target)).isDirectory() ? target : resolve(target, '..');
    const files = await discover(target);
    for (const file of files) {
      const buffer = await readBounded(file);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_TOTAL) throw new QethError('Scan inputs exceed the 25 MiB total limit.');
      const label = relative(root, file).split('\\').join('/');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, ''); }
      catch { throw new QethError(`Input is not valid UTF-8: ${label}`); }
      report.fileCount++;
      const ext = extname(file).toLowerCase();
      if (ext === '.json' || ext === '.jsonl') {
        let index = 0;
        for (const value of recordsFromJson(text, label, ext === '.jsonl', MAX_RECORDS - processedRecords)) add(value, label, ++index);
      }
      else {
        for (let offset = 0, i = 1; offset < text.length; offset += chunkSize, i++) {
          const content = text.slice(offset, offset + chunkSize);
          if (content.trim()) add({ id: `${label}:${i}`, text: content, metadata: { source: label } }, label, i);
        }
      }
    }
  } catch (error) {
    if (error instanceof QethError) throw error;
    throw new QethError(`Cannot scan input: ${error instanceof Error ? error.message : 'read failed'}`, 1);
  }
  report.duplicateGroups = [...hashes].filter(([, refs]) => refs.length > 1).map(([hash, chunks]) => ({ hash, chunks }));
  report.duplicateIds = [...ids].filter(([, refs]) => refs.length > 1).map(([id, chunks]) => ({ id, chunks }));
  report.embedding.dimensions = [...dimensions].sort((a, b) => a - b);
  if (!report.fileCount) report.warnings.push('No supported files found.');
  return report;
}
