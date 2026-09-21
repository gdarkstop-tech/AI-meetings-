import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MediaError, normalizeToSpeechAudio, parseDurationMs, probeMedia, runFfmpeg, withTempDir } from './media.js';
import { writeFile } from 'node:fs/promises';

/** These tests run real ffmpeg on real audio files. Nothing is simulated. */
describe('media pipeline (real ffmpeg)', () => {
  it('probes a generated file and reports its true duration', async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, 'tone.wav');
      const generated = await runFfmpeg([
        '-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-ar', '44100', '-ac', '2', src,
      ]);
      expect(generated.code).toBe(0);

      const probe = await probeMedia(src);
      expect(probe.hasAudio).toBe(true);
      expect(probe.durationMs).toBe(4000);
    });
  }, 120_000);

  it('normalizes to mono 16 kHz speech audio and shrinks the file', async () => {
    await withTempDir(async (dir) => {
      const src = path.join(dir, 'tone.wav');
      await runFfmpeg([
        '-hide_banner', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=5',
        '-ar', '44100', '-ac', '2', src,
      ]);

      const normalized = await normalizeToSpeechAudio(src, dir);
      expect(normalized.durationMs).toBe(5000);
      expect(normalized.bytes).toBeGreaterThan(0);
      expect(['opus', 'mp3']).toContain(normalized.codec);
      expect(normalized.checksum).toMatch(/^[0-9a-f]{64}$/);

      const reprobe = await probeMedia(normalized.path);
      expect(reprobe.hasAudio).toBe(true);
      // Opus carries encoder delay/padding, so the re-probed length differs by
      // a few milliseconds. Anything larger would mean we lost audio.
      expect(Math.abs((reprobe.durationMs ?? 0) - 5000)).toBeLessThanOrEqual(50);
    });
  }, 120_000);

  it('rejects a file with no audio stream instead of producing an empty transcript', async () => {
    await withTempDir(async (dir) => {
      const bogus = path.join(dir, 'not-media.txt');
      await writeFile(bogus, 'this is not audio');
      await expect(normalizeToSpeechAudio(bogus, dir)).rejects.toThrow(MediaError);
    });
  }, 120_000);

  it('parses ffmpeg duration output', () => {
    expect(parseDurationMs('Duration: 01:02:03.45, start: 0.000000')).toBe(3_723_450);
    expect(parseDurationMs('no duration here')).toBeNull();
  });
});
