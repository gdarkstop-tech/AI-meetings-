import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

/**
 * Real audio processing with ffmpeg.
 *
 * Meeting media is normalized to mono 16 kHz before transcription: it is what
 * every ASR provider wants, it cuts upload size by an order of magnitude, and
 * it makes cost predictable. Nothing here estimates or fabricates a duration —
 * the value comes from ffmpeg's own probe of the real file.
 */
export class MediaError extends Error {
  constructor(message: string, readonly code: 'MEDIA_INVALID' | 'FFMPEG_MISSING' | 'TRANSCODE_FAILED') {
    super(message);
  }
}

function binary(): string {
  const bin = ffmpegPath as unknown as string | null;
  if (!bin) throw new MediaError('ffmpeg binary is unavailable in this environment.', 'FFMPEG_MISSING');
  return bin;
}

export interface FfmpegRun {
  code: number | null;
  stderr: string;
}

export function runFfmpeg(args: string[], timeoutMs = 30 * 60_000): Promise<FfmpegRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new MediaError('ffmpeg timed out.', 'TRANSCODE_FAILED'));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new MediaError(`ffmpeg failed to start: ${err.message}`, 'FFMPEG_MISSING'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{1,2})/;

export function parseDurationMs(stderr: string): number | null {
  const match = DURATION_RE.exec(stderr);
  if (!match) return null;
  const [, h, m, s, cs] = match;
  return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(cs.padEnd(2, '0')) * 10;
}

export interface ProbeResult {
  durationMs: number | null;
  hasAudio: boolean;
  format: string | null;
}

/** Probe with ffmpeg itself (no separate ffprobe binary required). */
export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', filePath, '-f', 'null', '-']);
  const durationMs = parseDurationMs(stderr);
  const hasAudio = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio:/.test(stderr);
  const formatMatch = /Input #0,\s*([^,]+),/.exec(stderr);
  return { durationMs, hasAudio, format: formatMatch?.[1] ?? null };
}

export interface NormalizedMedia {
  path: string;
  bytes: number;
  durationMs: number;
  mimeType: string;
  codec: 'opus' | 'mp3';
  checksum: string;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Transcode to mono 16 kHz. Opus first (smallest); if the ffmpeg build lacks
 * libopus we fall back to MP3 and say which codec was actually produced.
 */
export async function normalizeToSpeechAudio(sourcePath: string, workDir: string): Promise<NormalizedMedia> {
  const probe = await probeMedia(sourcePath);
  if (!probe.hasAudio) {
    throw new MediaError('The uploaded file contains no audio stream.', 'MEDIA_INVALID');
  }

  const attempts: Array<{ codec: 'opus' | 'mp3'; args: string[]; ext: string; mime: string }> = [
    {
      codec: 'opus',
      ext: 'ogg',
      mime: 'audio/ogg',
      args: ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k'],
    },
    {
      codec: 'mp3',
      ext: 'mp3',
      mime: 'audio/mpeg',
      args: ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-q:a', '6'],
    },
  ];

  let lastError = '';
  for (const attempt of attempts) {
    const target = path.join(workDir, `normalized.${attempt.ext}`);
    const { code, stderr } = await runFfmpeg([
      '-hide_banner',
      '-y',
      '-i',
      sourcePath,
      ...attempt.args,
      target,
    ]);
    if (code === 0) {
      const info = await stat(target);
      const durationMs = probe.durationMs ?? parseDurationMs(stderr) ?? 0;
      return {
        path: target,
        bytes: info.size,
        durationMs,
        mimeType: attempt.mime,
        codec: attempt.codec,
        checksum: await sha256File(target),
      };
    }
    lastError = stderr.slice(-800);
  }
  throw new MediaError(`Transcoding failed: ${lastError}`, 'TRANSCODE_FAILED');
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alia-media-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
