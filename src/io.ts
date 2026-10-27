import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { QethError } from './errors.ts';

export async function readJsonInput(path: string): Promise<unknown> {
  const limit = 10 * 1024 * 1024;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new QethError('JSON input must be a regular file no larger than 10 MiB.');
    const chunks: Buffer[] = [];
    let count = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - count));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > limit) throw new QethError('JSON input exceeds the 10 MiB limit.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/^\uFEFF/, '')) as unknown; }
    catch { throw new QethError('Input must contain valid UTF-8 JSON.'); }
  } catch (error) {
    if (error instanceof QethError) throw error;
    throw new QethError(`Cannot read JSON input: ${error instanceof Error ? error.message : 'read failed'}`, 1);
  } finally { await handle?.close(); }
}

export async function writeNewJson(path: string, text: string): Promise<void> {
  let created = false;
  let handle;
  try {
    handle = await open(path, 'wx');
    created = true;
    await handle.writeFile(text, 'utf8');
  } catch (error) {
    if (created) { await handle?.close(); handle = undefined; await unlink(path).catch(() => {}); }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new QethError('Output already exists; choose a new path.');
    throw new QethError(`Cannot write output: ${error instanceof Error ? error.message : 'write failed'}`, 1);
  } finally { await handle?.close(); }
}
