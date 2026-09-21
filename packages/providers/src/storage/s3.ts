import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { StorageObject, StorageProvider } from '../types.js';

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, Wasabi).
 * Selected with STORAGE_PROVIDER=s3; the rest of the application is unchanged.
 */
export class S3StorageProvider implements StorageProvider {
  readonly id = 's3';
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async put(input: { key: string; body: Buffer | Readable; contentType: string; bytes?: number }): Promise<StorageObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.bytes,
      }),
    );
    const head = await this.head(input.key);
    return { key: input.key, bytes: head?.bytes ?? input.bytes ?? 0, contentType: input.contentType };
  }

  async putFromFile(input: { key: string; path: string; contentType: string }): Promise<StorageObject> {
    const info = await stat(input.path);
    return this.put({
      key: input.key,
      body: createReadStream(input.path),
      contentType: input.contentType,
      bytes: info.size,
    });
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    if (!res.Body) throw new Error(`Object not found: ${key}`);
    return res.Body as Readable;
  }

  async getBuffer(key: string): Promise<Buffer> {
    const stream = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  async downloadToFile(key: string, destPath: string): Promise<{ path: string; bytes: number }> {
    await mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(await this.getStream(key), createWriteStream(destPath));
    const info = await stat(destPath);
    return { path: destPath, bytes: info.size };
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return { bytes: res.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const objects = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.config.bucket, Delete: { Objects: objects } }),
        );
        deleted += objects.length;
      }
      token = listed.NextContinuationToken;
    } while (token);
    return deleted;
  }
}
