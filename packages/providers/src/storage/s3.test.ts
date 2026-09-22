import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3StorageProvider } from './s3.js';
import { createProviderRegistry } from '../registry.js';

/**
 * These tests exercise the real AWS SDK client in S3StorageProvider against a
 * local server that speaks the S3 wire protocol.
 *
 * They prove our adapter issues the right operations and handles ranges,
 * misses and cleanup correctly. They are NOT a verification of AWS S3,
 * Cloudflare R2 or MinIO: live object storage requires credentials and remains
 * NOT CONFIGURED. Nothing here reports a successful production upload.
 */

/** Decodes `aws-chunked` transfer framing when the SDK streams a body. */
function decodeAwsChunked(buffer: Buffer): Buffer {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) break;
    const header = buffer.subarray(offset, lineEnd).toString('utf8');
    const size = Number.parseInt(header.split(';')[0], 16);
    if (Number.isNaN(size)) break;
    offset = lineEnd + 2;
    if (size === 0) break;
    out.push(buffer.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(out);
}

interface StoredObject {
  body: Buffer;
  contentType: string;
}

/** Minimal S3-compatible server: PUT, GET (with Range), HEAD, DELETE, list, bulk delete. */
function startS3Server(objects: Map<string, StoredObject>): Promise<{ server: Server; url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Path style: /<bucket>/<key...>
    const [, , ...keyParts] = url.pathname.split('/');
    const key = decodeURIComponent(keyParts.join('/'));
    requests.push(`${req.method} ${url.pathname}${url.search}`);

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk as Buffer)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);

      if (req.method === 'POST' && url.searchParams.has('delete')) {
        const xml = raw.toString('utf8');
        const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
        for (const k of keys) objects.delete(k);
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>');
        return;
      }

      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const matching = [...objects.keys()].filter((k) => k.startsWith(prefix));
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${matching
            .map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.body.length}</Size></Contents>`)
            .join('')}</ListBucketResult>`,
        );
        return;
      }

      if (req.method === 'PUT') {
        const encoding = String(req.headers['content-encoding'] ?? '');
        const sha = String(req.headers['x-amz-content-sha256'] ?? '');
        const body = encoding.includes('aws-chunked') || sha.startsWith('STREAMING') ? decodeAwsChunked(raw) : raw;
        objects.set(key, { body, contentType: String(req.headers['content-type'] ?? 'application/octet-stream') });
        res.writeHead(200, { ETag: '"test-etag"' });
        res.end();
        return;
      }

      const existing = objects.get(key);

      if (req.method === 'HEAD') {
        if (!existing) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-length': String(existing.body.length),
          'content-type': existing.contentType,
        });
        res.end();
        return;
      }

      if (req.method === 'GET') {
        if (!existing) {
          res.writeHead(404, { 'content-type': 'application/xml' });
          res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>');
          return;
        }
        const rangeHeader = req.headers.range;
        const match = typeof rangeHeader === 'string' ? /bytes=(\d+)-(\d*)/.exec(rangeHeader) : null;
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Number(match[2]) : existing.body.length - 1;
          const slice = existing.body.subarray(start, end + 1);
          res.writeHead(206, {
            'content-length': String(slice.length),
            'content-range': `bytes ${start}-${end}/${existing.body.length}`,
            'content-type': existing.contentType,
          });
          res.end(slice);
          return;
        }
        res.writeHead(200, {
          'content-length': String(existing.body.length),
          'content-type': existing.contentType,
        });
        res.end(existing.body);
        return;
      }

      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(405);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

describe('S3 storage adapter (against a local S3-protocol server, not live S3)', () => {
  const objects = new Map<string, StoredObject>();
  let server: Server;
  let storage: S3StorageProvider;
  let requests: string[];
  let tmpDir: string;

  beforeAll(async () => {
    const started = await startS3Server(objects);
    server = started.server;
    requests = started.requests;
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'alia-s3-'));
    storage = new S3StorageProvider({
      bucket: 'test-bucket',
      region: 'us-east-1',
      endpoint: started.url,
      accessKeyId: 'test-access-key-id',
      secretAccessKey: 'test-secret-access-key',
      forcePathStyle: true,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('uploads a buffer and reads back the exact bytes', async () => {
    const payload = Buffer.from('اجتماع الموقع — meeting audio bytes');
    const written = await storage.put({
      key: 'ws/meetings/m1/original',
      body: payload,
      contentType: 'audio/ogg',
    });
    expect(written.key).toBe('ws/meetings/m1/original');
    expect(written.bytes).toBe(payload.length);
    expect(await storage.getBuffer('ws/meetings/m1/original')).toEqual(payload);
  });

  it('uploads a stream (the assembled-upload path) without corrupting it', async () => {
    const payload = Buffer.concat([Buffer.alloc(2048, 7), Buffer.alloc(1024, 9)]);
    await storage.put({
      key: 'ws/meetings/m1/streamed',
      body: Readable.from([payload.subarray(0, 2048), payload.subarray(2048)]),
      contentType: 'application/octet-stream',
      bytes: payload.length,
    });
    expect(await storage.getBuffer('ws/meetings/m1/streamed')).toEqual(payload);
  });

  it('serves byte ranges, which is what makes the player seekable', async () => {
    const stream = await storage.getStream('ws/meetings/m1/streamed', { start: 0, end: 99 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    const body = Buffer.concat(chunks);
    expect(body.length).toBe(100);
    expect(body.every((byte) => byte === 7)).toBe(true);
    expect(requests.some((r) => r.startsWith('GET /test-bucket/ws/meetings/m1/streamed'))).toBe(true);
  });

  it('reports object size on head and null for a missing key', async () => {
    expect(await storage.head('ws/meetings/m1/streamed')).toEqual({ bytes: 3072 });
    expect(await storage.head('ws/meetings/m1/does-not-exist')).toBeNull();
  });

  it('downloads to a local file so ffmpeg can work on it', async () => {
    const target = path.join(tmpDir, 'downloaded.bin');
    const result = await storage.downloadToFile('ws/meetings/m1/original', target);
    expect(result.bytes).toBeGreaterThan(0);
    expect((await readFile(target)).toString()).toContain('meeting audio bytes');
  });

  it('uploads from a local file (the normalized-media path)', async () => {
    const source = path.join(tmpDir, 'normalized.ogg');
    await writeFile(source, Buffer.alloc(4096, 3));
    const written = await storage.putFromFile({
      key: 'ws/meetings/m1/normalized.ogg',
      path: source,
      contentType: 'audio/ogg',
    });
    expect(written.bytes).toBe(4096);
    expect((await storage.getBuffer('ws/meetings/m1/normalized.ogg')).length).toBe(4096);
  });

  it('deletes a single object', async () => {
    await storage.delete('ws/meetings/m1/normalized.ogg');
    expect(await storage.head('ws/meetings/m1/normalized.ogg')).toBeNull();
  });

  it('deletes everything under a prefix, which is what erasure depends on', async () => {
    await storage.put({ key: 'ws/meetings/m2/a', body: Buffer.from('a'), contentType: 'text/plain' });
    await storage.put({ key: 'ws/meetings/m2/b', body: Buffer.from('b'), contentType: 'text/plain' });
    const deleted = await storage.deletePrefix('ws/meetings/m2');
    expect(deleted).toBe(2);
    expect(await storage.head('ws/meetings/m2/a')).toBeNull();
    expect(await storage.head('ws/meetings/m2/b')).toBeNull();
    // Objects outside the prefix are untouched.
    expect(await storage.head('ws/meetings/m1/original')).not.toBeNull();
  });
});

describe('S3 configuration resolution', () => {
  it('names every missing S3 variable instead of half-starting', () => {
    const status = createProviderRegistry({ STORAGE_PROVIDER: 's3' }).statuses().find((s) => s.kind === 'storage');
    expect(status?.configured).toBe(false);
    expect(status?.requires).toEqual(['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
  });

  it('builds the adapter once the four required variables are present; endpoint stays optional', () => {
    const registry = createProviderRegistry({
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: 'configured-by-env',
      S3_REGION: 'configured-by-env',
      S3_ACCESS_KEY_ID: 'configured-by-env',
      S3_SECRET_ACCESS_KEY: 'configured-by-env',
    });
    expect(registry.isConfigured('storage')).toBe(true);
    expect(registry.storage().id).toBe('s3');
  });

  it('treats an empty S3_ENDPOINT as unset, which is what compose emits for AWS', () => {
    const registry = createProviderRegistry({
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: 'configured-by-env',
      S3_REGION: 'configured-by-env',
      S3_ACCESS_KEY_ID: 'configured-by-env',
      S3_SECRET_ACCESS_KEY: 'configured-by-env',
      S3_ENDPOINT: '',
    });
    expect(registry.isConfigured('storage')).toBe(true);
    expect(registry.storage().id).toBe('s3');
  });

  it('keeps local filesystem storage available for development and tests', () => {
    const registry = createProviderRegistry({ STORAGE_PROVIDER: 'local', STORAGE_LOCAL_DIR: '/tmp/alia-local-dev' });
    expect(registry.storage().id).toBe('local');
  });

  it('refuses an unknown provider rather than guessing', () => {
    const status = createProviderRegistry({ STORAGE_PROVIDER: 'dropbox' }).statuses().find((s) => s.kind === 'storage');
    expect(status?.configured).toBe(false);
    expect(status?.reason).toMatch(/Unknown storage provider/i);
  });
});
