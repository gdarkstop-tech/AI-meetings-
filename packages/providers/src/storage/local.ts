import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, readdir, stat, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { ByteRange, StorageObject, StorageProvider } from '../types.js';

/**
 * Filesystem storage. A real implementation, not a mock: bytes are written to
 * and read from disk, checksums and sizes are genuine.
 *
 * Suitable for single-node deployments with a mounted volume and for local
 * development. Multi-instance production should use the S3 adapter, which is
 * selected by configuration alone.
 */
async function countFiles(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) total += await countFiles(path.join(dir, entry.name));
    else total += 1;
  }
  return total;
}

export class LocalStorageProvider implements StorageProvider {
  readonly id = 'local';

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const clean = key.replace(/^\/+/, '');
    if (clean.includes('..') || path.isAbsolute(clean)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path.join(this.root, clean);
  }

  async put(input: { key: string; body: Buffer | Readable; contentType: string }): Promise<StorageObject> {
    const target = this.resolve(input.key);
    await mkdir(path.dirname(target), { recursive: true });
    if (Buffer.isBuffer(input.body)) {
      await writeFile(target, input.body);
    } else {
      await pipeline(input.body, createWriteStream(target));
    }
    const info = await stat(target);
    return { key: input.key, bytes: info.size, contentType: input.contentType };
  }

  async putFromFile(input: { key: string; path: string; contentType: string }): Promise<StorageObject> {
    const target = this.resolve(input.key);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(input.path, target);
    const info = await stat(target);
    return { key: input.key, bytes: info.size, contentType: input.contentType };
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    return range
      ? createReadStream(this.resolve(key), { start: range.start, end: range.end })
      : createReadStream(this.resolve(key));
  }

  async getBuffer(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async downloadToFile(key: string, destPath: string): Promise<{ path: string; bytes: number }> {
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(this.resolve(key), destPath);
    const info = await stat(destPath);
    return { path: destPath, bytes: info.size };
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    try {
      const info = await stat(this.resolve(key));
      return { bytes: info.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const dir = this.resolve(prefix);
    const count = await countFiles(dir);
    await rm(dir, { recursive: true, force: true });
    return count;
  }
}
