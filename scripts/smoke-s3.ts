/**
 * Live smoke test for S3-compatible object storage.
 *
 * Exercises the real S3StorageProvider — resolved through the production
 * provider registry, not a hand-built client — against whatever bucket the
 * current process environment points at (Supabase Storage, AWS S3, Cloudflare
 * R2, MinIO, Wasabi).
 *
 * Run it only against a bucket you are willing to have objects written to and
 * deleted from. Every object it creates lives under one unique prefix and is
 * removed again, including when a step fails.
 *
 * It requires no database, no Docker, no ffmpeg, no .env file and no running
 * application. Credentials come from the process environment only.
 *
 *   PowerShell:  npx tsx scripts/smoke-s3.ts
 *   bash:        npx tsx scripts/smoke-s3.ts
 *
 * Nothing in this file prints an environment variable's value. Provider error
 * messages are redacted before they are shown, because SDK errors can quote the
 * endpoint, the bucket or the access key id back at you.
 *
 * Exit codes: 0 all checks passed, 1 at least one check failed, 2 not configured.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createProviderRegistry, type StorageProvider } from '@alia/providers';

// ---------------------------------------------------------------- redaction

const SENSITIVE_VARS = [
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
] as const;

/** Longest first, so a value that contains another is replaced whole. */
const REDACTIONS: string[] = SENSITIVE_VARS.map((name) => process.env[name])
  .filter((v): v is string => typeof v === 'string' && v.trim().length >= 4)
  .map((v) => v.trim())
  .sort((a, b) => b.length - a.length);

function redact(text: string): string {
  let out = text;
  for (const value of REDACTIONS) out = out.split(value).join('[redacted]');
  return out;
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as {
      name?: string;
      message?: string;
      Code?: string;
      $metadata?: { httpStatusCode?: number };
    };
    const parts: string[] = [e.name ?? 'Error'];
    if (e.$metadata?.httpStatusCode) parts.push(`HTTP ${e.$metadata.httpStatusCode}`);
    if (e.Code) parts.push(`Code=${e.Code}`);
    if (e.message) parts.push(e.message);
    return redact(parts.join(' | '));
  }
  return redact(String(err));
}

// ---------------------------------------------------------------- harness

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function step(name: string, fn: () => Promise<string | void>, hint?: string): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    passed += 1;
    const ms = Date.now() - started;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}  (${ms} ms)`);
  } catch (err) {
    failed += 1;
    const ms = Date.now() - started;
    console.log(`FAIL  ${name}  (${ms} ms)`);
    console.log(`      ${describeError(err)}`);
    if (hint) for (const line of hint.split('\n')) console.log(`      hint: ${line}`);
  }
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- preflight

function preflight(): StorageProvider {
  const env: Record<string, string | undefined> = { ...process.env };

  // The registry needs a selection; default it rather than making the operator
  // export one more variable for a storage-only test. Anything else is refused,
  // because this script must never silently test the local filesystem instead.
  const selected = env.STORAGE_PROVIDER?.trim();
  if (!selected) {
    env.STORAGE_PROVIDER = 's3';
    console.log('note  STORAGE_PROVIDER was not set; using "s3" for this smoke test.');
  } else if (selected !== 's3') {
    console.error(`STORAGE_PROVIDER is "${selected}". This smoke test only applies to s3.`);
    process.exit(2);
  }

  const missing = (['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter(
    (name) => !env[name] || env[name]!.trim().length === 0,
  );
  if (missing.length > 0) {
    console.error('NOT CONFIGURED — these environment variables are empty or unset:');
    for (const name of missing) console.error(`  - ${name}`);
    console.error('No request was made. Set them in this shell and run again.');
    process.exit(2);
  }

  const registry = createProviderRegistry(env);
  const storage = registry.storage();

  console.log('configuration (values are never printed):');
  console.log(`  provider id            : ${storage.id}`);
  console.log(`  S3_BUCKET              : set`);
  console.log(`  S3_REGION              : set`);
  console.log(`  S3_ACCESS_KEY_ID       : set`);
  console.log(`  S3_SECRET_ACCESS_KEY   : set`);
  console.log(`  S3_ENDPOINT            : ${env.S3_ENDPOINT?.trim() ? 'set (path-style addressing on)' : 'not set (AWS S3 default)'}`);
  console.log('');
  return storage;
}

// ---------------------------------------------------------------- the test

async function main(): Promise<void> {
  const storage = preflight();

  const prefix = `alia-smoke-test/${new Date().toISOString().slice(0, 10)}-${randomUUID()}`;
  const created: string[] = [];
  const key = (name: string): string => {
    const full = `${prefix}/${name}`;
    created.push(full);
    return full;
  };

  console.log(`test prefix: ${prefix}`);
  console.log('');

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'alia-smoke-'));

  // Fixtures.
  const bufferBody = randomBytes(64 * 1024);
  const bufferKey = key('01-buffer.bin');

  const fileBody = randomBytes(96 * 1024);
  const filePath = path.join(tmpDir, 'upload.bin');
  const fileKey = key('02-from-file.bin');

  const streamChunks = [randomBytes(128 * 1024), randomBytes(128 * 1024), randomBytes(128 * 1024)];
  const streamBody = Buffer.concat(streamChunks);
  const streamKey = key('03-unknown-length-stream.bin');

  const listKeys = [key('list/a.txt'), key('list/b.txt'), key('list/c.txt')];
  const absentKey = `${prefix}/99-never-written.bin`;

  try {
    await step('PutObject — Buffer body, explicit ContentLength', async () => {
      const result = await storage.put({
        key: bufferKey,
        body: bufferBody,
        contentType: 'application/octet-stream',
        bytes: bufferBody.length,
      });
      assert(result.bytes === bufferBody.length, `put reported ${result.bytes} bytes, expected ${bufferBody.length}`);
      return `${result.bytes} bytes`;
    });

    await step('HeadObject — size matches what was written', async () => {
      const head = await storage.head(bufferKey);
      assert(head !== null, 'HeadObject returned null for an object that was just written');
      assert(head!.bytes === bufferBody.length, `head reported ${head!.bytes} bytes, expected ${bufferBody.length}`);
      return `${head!.bytes} bytes`;
    });

    await step('GetObject — full read, content identical', async () => {
      const got = await storage.getBuffer(bufferKey);
      assert(got.length === bufferBody.length, `read ${got.length} bytes, expected ${bufferBody.length}`);
      assert(sha256(got) === sha256(bufferBody), 'sha256 of the round-tripped object does not match what was uploaded');
      return `${got.length} bytes, sha256 match`;
    });

    await step('GetObject — ranged read, middle slice', async () => {
      const start = 1000;
      const end = 2999;
      const got = await collect(await storage.getStream(bufferKey, { start, end }));
      assert(got.length === end - start + 1, `range returned ${got.length} bytes, expected ${end - start + 1}`);
      assert(got.equals(bufferBody.subarray(start, end + 1)), 'ranged bytes do not match the same slice of the source');
      return `bytes ${start}-${end} (${got.length} bytes)`;
    });

    await step('GetObject — ranged read, final byte', async () => {
      const last = bufferBody.length - 1;
      const got = await collect(await storage.getStream(bufferKey, { start: last, end: last }));
      assert(got.length === 1, `range returned ${got.length} bytes, expected 1`);
      assert(got[0] === bufferBody[last], 'final byte does not match');
      return '1 byte';
    });

    await step('PutObject — putFromFile (worker transcode path)', async () => {
      await writeFile(filePath, fileBody);
      const result = await storage.putFromFile({ key: fileKey, path: filePath, contentType: 'application/octet-stream' });
      assert(result.bytes === fileBody.length, `put reported ${result.bytes} bytes, expected ${fileBody.length}`);
      return `${result.bytes} bytes`;
    });

    await step('GetObject — downloadToFile round trip', async () => {
      const dest = path.join(tmpDir, 'download.bin');
      const result = await storage.downloadToFile(fileKey, dest);
      const info = await stat(dest);
      assert(result.bytes === fileBody.length, `downloaded ${result.bytes} bytes, expected ${fileBody.length}`);
      assert(info.size === fileBody.length, `file on disk is ${info.size} bytes, expected ${fileBody.length}`);
      return `${result.bytes} bytes to a local file`;
    });

    // The shape apps/api/src/routes/meetings.ts uses to finalise a chunked
    // upload: an async generator yielding chunks as it fetches them, with the
    // total length announced up front. The SDK streams this with aws-chunked
    // framing and a trailing checksum, which not every S3 implementation accepts.
    await step(
      'PutObject — async-generator stream, known length (upload-finalise path)',
      async () => {
        const body = Readable.from(
          (async function* () {
            for (const chunk of streamChunks) yield chunk;
          })(),
        );
        const result = await storage.put({
          key: streamKey,
          body,
          contentType: 'application/octet-stream',
          bytes: streamBody.length,
        });
        assert(result.bytes === streamBody.length, `put reported ${result.bytes} bytes, expected ${streamBody.length}`);
        return `${result.bytes} bytes streamed in ${streamChunks.length} chunks`;
      },
      'The body is sent with aws-chunked framing and a trailing checksum rather\n' +
        'than as one buffer. If this fails while the buffer upload above passed,\n' +
        'the endpoint does not accept chunked/trailer uploads. That is a storage\n' +
        'incompatibility, not a defect in this application.',
    );

    await step('GetObject — streamed object reads back byte-identical', async () => {
      const got = await storage.getBuffer(streamKey);
      assert(got.length === streamBody.length, `read ${got.length} bytes, expected ${streamBody.length}`);
      assert(sha256(got) === sha256(streamBody), 'sha256 mismatch: the streamed upload was corrupted in transit');
      return `${got.length} bytes, sha256 match`;
    });

    await step('GetObject — ranged read across a stream chunk boundary', async () => {
      const start = 128 * 1024 - 512;
      const end = 128 * 1024 + 511;
      const got = await collect(await storage.getStream(streamKey, { start, end }));
      assert(got.length === end - start + 1, `range returned ${got.length} bytes, expected ${end - start + 1}`);
      assert(got.equals(streamBody.subarray(start, end + 1)), 'bytes across the chunk boundary do not match');
      return `bytes ${start}-${end} (${got.length} bytes)`;
    });

    await step('Contract — a stream body with no byte count is refused locally', async () => {
      const neverKey = `${prefix}/04-should-never-exist.bin`;
      let message = '';
      try {
        await storage.put({
          key: neverKey,
          body: Readable.from([Buffer.from('never sent', 'utf8')]),
          contentType: 'application/octet-stream',
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assert(/requires `bytes`/.test(message), `adapter did not refuse it; got: ${message || '(no error thrown)'}`);
      assert((await storage.head(neverKey)) === null, 'an object was created despite the refusal');
      return 'refused before any request was made';
    });

    await step('HeadObject — a key that was never written returns null', async () => {
      const head = await storage.head(absentKey);
      assert(head === null, 'HeadObject returned metadata for a key that was never written');
      return 'null as expected';
    });

    await step('ListObjectsV2 + DeleteObjects — deletePrefix over 3 objects', async () => {
      for (const listKey of listKeys) {
        await storage.put({
          key: listKey,
          body: Buffer.from(`smoke ${listKey}\n`, 'utf8'),
          contentType: 'text/plain',
        });
      }
      const deleted = await storage.deletePrefix(`${prefix}/list/`);
      assert(deleted === listKeys.length, `deletePrefix removed ${deleted} objects, expected ${listKeys.length}`);
      return `listed and deleted ${deleted} objects`;
    });

    await step('DeleteObject — single key, then HeadObject confirms removal', async () => {
      await storage.delete(bufferKey);
      const head = await storage.head(bufferKey);
      assert(head === null, 'HeadObject still returns metadata after DeleteObject');
      return 'deleted and confirmed gone';
    });
  } finally {
    console.log('');
    console.log('cleanup:');

    let removed = -1;
    try {
      removed = await storage.deletePrefix(`${prefix}/`);
      console.log(`  deletePrefix removed ${removed} remaining object(s)`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  cleanup deletePrefix — ${describeError(err)}`);
    }

    if (removed >= 0) {
      let stragglers = 0;
      for (const createdKey of created) {
        try {
          if ((await storage.head(createdKey)) !== null) stragglers += 1;
        } catch {
          stragglers += 1;
        }
      }
      if (stragglers === 0) {
        passed += 1;
        console.log(`  PASS  all ${created.length} test object(s) verified gone`);
      } else {
        failed += 1;
        console.log(`  FAIL  ${stragglers} test object(s) still present under the test prefix`);
        console.log(`        remove them manually: prefix ${prefix}/`);
      }

      try {
        const second = await storage.deletePrefix(`${prefix}/`);
        if (second === 0) {
          passed += 1;
          console.log('  PASS  re-listing the prefix returns nothing');
        } else {
          failed += 1;
          console.log(`  FAIL  re-listing the prefix still returns ${second} object(s)`);
        }
      } catch (err) {
        failed += 1;
        console.log(`  FAIL  cleanup verification — ${describeError(err)}`);
      }
    }

    await rm(tmpDir, { recursive: true, force: true });
    console.log('  local temporary files removed');
  }

  console.log('');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('S3 STORAGE: NOT VERIFIED');
    process.exitCode = 1;
  } else {
    console.log('S3 STORAGE: VERIFIED against the configured bucket');
  }
}

main().catch((err) => {
  console.error(`smoke test aborted: ${describeError(err)}`);
  process.exit(1);
});
