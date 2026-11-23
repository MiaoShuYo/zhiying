import type { FfmpegOverrideFn } from '@remotion/renderer';

/**
 * Keep software H.264 encoding within a small, predictable memory budget.
 * x264 otherwise derives its thread count from the host CPU count, which can
 * allocate more frame buffers than a desktop Worker can spare at 1080x1920.
 */
export const boundedRenderFfmpegThreads: FfmpegOverrideFn = ({ type, args }) => {
  if (type !== 'stitcher' || args.length === 0) return args;
  const result = [...args];
  const outputIndex = result.length - 1;
  result.splice(outputIndex, 0, '-threads:v', '2');
  return result;
};
