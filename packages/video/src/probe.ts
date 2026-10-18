import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ProbeSummary } from '@m2v/schema';

const run = promisify(execFile);

const ffprobePath = () => process.env.FFPROBE_PATH || 'ffprobe';

type FfprobeStream = { codec_type?: string; codec_name?: string; width?: number; height?: number };

/** Returns the parsed summary plus the on-disk size, or `null` when FFprobe cannot read the file. */
export async function probeVideoFile(file: string): Promise<{ probe: ProbeSummary; bytes: number } | null> {
  let bytes = 0;
  try {
    bytes = (await stat(file)).size;
  } catch {
    return null;
  }
  try {
    const { stdout } = await run(
      ffprobePath(),
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: { duration?: string } };
    const streams = parsed.streams ?? [];
    const video = streams.find(stream => stream.codec_type === 'video');
    const audio = streams.find(stream => stream.codec_type === 'audio');
    const duration = Number(parsed.format?.duration ?? NaN);
    const probe: ProbeSummary = {
      width: video?.width,
      height: video?.height,
      duration: Number.isFinite(duration) ? duration : undefined,
      videoCodec: video?.codec_name,
      audioCodec: audio?.codec_name,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
    };
    return { probe, bytes };
  } catch {
    return null;
  }
}
