import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedRenderFfmpegThreads } from '../src/render-ffmpeg';

test('the Remotion stitcher caps H.264 threads before its output target', () => {
  const args = ['-i', 'frames.mp4', '-c:v', 'libx264', '-crf', '16', 'out.mp4'];
  assert.deepEqual(boundedRenderFfmpegThreads({ type: 'stitcher', args }), [
    '-i', 'frames.mp4', '-c:v', 'libx264', '-crf', '16', '-threads:v', '2', 'out.mp4',
  ]);
});

test('the worker does not rewrite Remotion pre-stitcher arguments', () => {
  const args = ['-i', 'frames.mp4', '-f', 'image2pipe'];
  assert.equal(boundedRenderFfmpegThreads({ type: 'pre-stitcher', args }), args);
});
