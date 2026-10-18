import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AudioProbeEntry } from '@m2v/video/qc';
import { resolvePublicPath } from '@/lib/public-paths';

const run = promisify(execFile);
const TIMEOUT = 20_000;
const CACHE_LIMIT = 200;
const CONCURRENCY = 4;

/** Measured values are cached by path plus mtime/size so a re-check is instant. */
const cache = new Map<string, { stamp: string; entry: AudioProbeEntry }>();
let toolsReady: Promise<boolean> | undefined;

export const ffmpegPath = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = () => process.env.FFPROBE_PATH || 'ffprobe';

export function audioToolsReady(): Promise<boolean> {
  toolsReady ??= (async () => {
    try {
      await run(ffmpegPath(), ['-version'], { timeout: 5_000, windowsHide: true });
      await run(ffprobePath(), ['-version'], { timeout: 5_000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  })();
  return toolsReady;
}

type FfprobeResult = { streams?: { codec_type?: string; duration?: string }[]; format?: { duration?: string } };

const parseDb = (text: string, field: string) => {
  const match = text.match(new RegExp(`${field}:\\s*(-?[\\d.]+|-inf)\\s*dB`));
  if (!match) return undefined;
  return match[1] === '-inf' ? -Infinity : Number(match[1]);
};

async function measureOne(src: string | undefined, refresh: boolean): Promise<AudioProbeEntry> {
  if (!src) return 'missing';
  const file = resolvePublicPath(src);
  if (!file) return 'unreadable';
  let stamp: string;
  try {
    const info = await stat(file);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'missing';
  }
  if (!refresh) {
    const hit = cache.get(file);
    if (hit?.stamp === stamp) return hit.entry;
  }

  let entry: AudioProbeEntry;
  try {
    const { stdout } = await run(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const parsed = JSON.parse(stdout) as FfprobeResult;
    const stream = parsed.streams?.find(item => item.codec_type === 'audio');
    const duration = Number(parsed.format?.duration ?? stream?.duration ?? NaN);
    if (!stream) {
      entry = { duration: Number.isFinite(duration) ? duration : 0, meanVolume: -Infinity, peakVolume: -Infinity, hasAudio: false };
    } else {
      let meanVolume = -Infinity;
      let peakVolume = -Infinity;
      try {
        const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        meanVolume = parseDb(stderr, 'mean_volume') ?? -Infinity;
        peakVolume = parseDb(stderr, 'max_volume') ?? -Infinity;
      } catch {
        // The stream is still readable; only the loudness numbers are missing.
      }
      entry = { duration: Number.isFinite(duration) ? duration : 0, meanVolume, peakVolume, hasAudio: true };
    }
  } catch {
    entry = 'unreadable';
  }

  cache.delete(file);
  cache.set(file, { stamp, entry });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return entry;
}

export async function measureSceneAudio(scenes: { id: string; audioSrc?: string }[], refresh = false): Promise<Map<string, AudioProbeEntry>> {
  const results = new Map<string, AudioProbeEntry>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < scenes.length) {
      const scene = scenes[cursor++];
      results.set(scene.id, await measureOne(scene.audioSrc, refresh));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scenes.length) }, worker));
  return results;
}
