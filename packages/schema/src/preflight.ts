import type { Scene, Storyboard } from './index';
import { timelineFor } from './timeline';

export type PreflightSeverity = 'error' | 'warning' | 'info';

export type PreflightCode =
  | 'missing_image' | 'missing_file' | 'missing_audio' | 'empty_narration'
  | 'caption_overflow' | 'caption_overtime' | 'scene_too_short'
  | 'duration_target_miss' | 'missing_bgm' | 'subtitles_off';

/** `fix` names the panel that can resolve the issue, so the UI can jump straight there. */
export type PreflightFix = 'upload_asset' | 'generate_audio' | 'open_captions' | 'open_render' | 'rewrite_narration';

export type PreflightIssue = {
  code: PreflightCode;
  severity: PreflightSeverity;
  sceneIndex?: number;
  sceneId?: string;
  message: string;
  fix: PreflightFix;
};

export type PreflightPreset = 'full' | 'draft';

export type PreflightOptions = { preset?: PreflightPreset; exists?: (path: string) => boolean };

export type PreflightResult = {
  issues: PreflightIssue[];
  blocking: number;
  warnings: number;
  estimatedSeconds: number;
  width: number;
  height: number;
  preset: PreflightPreset;
};

export const preflightSeverityLabels: Record<PreflightSeverity, string> = { error: '错误', warning: '警告', info: '提示' };
export const preflightCodeLabels: Record<PreflightCode, string> = {
  missing_image: '缺少图片',
  missing_file: '素材文件缺失',
  missing_audio: '缺少语音',
  empty_narration: '旁白为空',
  caption_overflow: '字幕过长',
  caption_overtime: '字幕超出时长',
  scene_too_short: '场景过短',
  duration_target_miss: '时长偏离目标',
  missing_bgm: '背景音乐缺失',
  subtitles_off: '字幕已关闭',
};
export const preflightFixLabels: Record<PreflightFix, string> = {
  upload_asset: '补充素材',
  generate_audio: '生成语音',
  open_captions: '打开字幕',
  open_render: '检查导出设置',
  rewrite_narration: '补充旁白',
};

const sceneLabel = (scene: Scene, index: number) => `场景 ${index + 1}${scene.title ? `「${scene.title}」` : ''}`;
const sceneAssetPath = /^projects\/[A-Za-z0-9_-]+\/assets\/[^/]+$/;
const displayWidth = (text: string) => (text.match(/[A-Za-z0-9]/g)?.length ?? 0) * 0.55 + [...text.replace(/[A-Za-z0-9]/g, '')].length;
const captionLimit = (portrait: boolean) => (portrait ? 24 : 38);

/** Longest run the automatic splitter cannot break: sentence enders and commas are its only stops. */
function longestUnbreakableRun(narration: string): number {
  return Math.max(0, ...narration.split(/[。！？!?；;\n]+/).flatMap(part => part.split(/[，,：:]/)).map(part => part.trim()).map(part => [...part].length));
}

function cueIssues(scene: Scene, index: number, portrait: boolean): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const limit = captionLimit(portrait);
  const target = sceneLabel(scene, index);
  const cues = scene.subtitleCues ?? [];
  if (cues.length) {
    const overflow = cues.filter(cue => displayWidth(cue.text) > limit || cue.text.split('\n').length > 2);
    if (overflow.length) {
      issues.push({ code: 'caption_overflow', severity: 'warning', sceneIndex: index, sceneId: scene.id, message: `${target}有 ${overflow.length} 条手动字幕超过 ${limit} 字或两行，导出后会被裁切。`, fix: 'open_captions' });
    }
    const window = scene.audioDuration ?? Math.max(3, scene.duration ?? 6);
    const late = cues.find(cue => cue.end > window + 0.01);
    if (late) {
      issues.push({ code: 'caption_overtime', severity: 'warning', sceneIndex: index, sceneId: scene.id, message: `${target}的手动字幕结束于 ${late.end.toFixed(2)} 秒，超出场景音频的 ${window.toFixed(2)} 秒。`, fix: 'open_captions' });
    }
  } else if (longestUnbreakableRun(scene.narration) > limit) {
    issues.push({ code: 'caption_overflow', severity: 'warning', sceneIndex: index, sceneId: scene.id, message: `${target}的旁白有一段连续 ${longestUnbreakableRun(scene.narration)} 字没有标点，自动字幕会挤在一屏。`, fix: 'open_captions' });
  }
  return issues;
}

/**
 * Delivery check shared by the panel and the render route. `exists` is only
 * supplied on the server, because the browser cannot check local files.
 */
export function preflight(storyboard: Storyboard, assets: { path: string; kind?: string }[], options: PreflightOptions = {}): PreflightResult {
  const preset = options.preset ?? 'full';
  const portrait = storyboard.aspectRatio === '9:16';
  const issues: PreflightIssue[] = [];
  const assetPaths = new Set(assets.map(asset => asset.path));
  // The browser has no filesystem, so `missing_file` only appears when the server supplies `exists`.
  const stale = (path: string) => (options.exists ? !options.exists(path) : false);

  storyboard.scenes.forEach((scene, index) => {
    const target = sceneLabel(scene, index);
    const narration = scene.narration.trim();
    const src = typeof scene.visual.src === 'string' ? scene.visual.src : '';
    if (scene.type === 'media') {
      if (!src) issues.push({ code: 'missing_image', severity: 'error', sceneIndex: index, sceneId: scene.id, message: `${target}是图片场景，但还没有选择图片。`, fix: 'upload_asset' });
      else if (!sceneAssetPath.test(src)) issues.push({ code: 'missing_image', severity: 'error', sceneIndex: index, sceneId: scene.id, message: `${target}引用的图片不在项目素材目录内：${src}`, fix: 'upload_asset' });
      else if (assetPaths.size > 0 && !assetPaths.has(src)) issues.push({ code: 'missing_image', severity: 'error', sceneIndex: index, sceneId: scene.id, message: `${target}引用的图片没有登记在项目素材中：${src}`, fix: 'upload_asset' });
      else if (stale(src)) issues.push({ code: 'missing_file', severity: 'error', sceneIndex: index, sceneId: scene.id, message: `${target}引用的图片文件已不存在：${src}`, fix: 'upload_asset' });
    }
    if (!narration) {
      issues.push({ code: 'empty_narration', severity: 'warning', sceneIndex: index, sceneId: scene.id, message: `${target}没有旁白，导出后会是静音画面。`, fix: 'rewrite_narration' });
    } else {
      const credit = typeof scene.visual.attribution === 'string' ? scene.visual.attribution.trim() : '';
      if (credit && credit === narration) {
        issues.push({ code: 'empty_narration', severity: 'warning', sceneIndex: index, sceneId: scene.id, message: `${target}的旁白只是素材署名，需要补充真正的讲解。`, fix: 'rewrite_narration' });
      }
      if (!scene.audioSrc && !(scene.audioDuration && scene.audioDuration > 0)) {
        issues.push({ code: 'missing_audio', severity: 'error', sceneIndex: index, sceneId: scene.id, message: `${target}还没有生成语音。`, fix: 'generate_audio' });
      } else if (scene.audioSrc && stale(scene.audioSrc)) {
        issues.push({ code: 'missing_file', severity: 'error', sceneIndex: index, sceneId: scene.id, message: `${target}的语音文件已不存在：${scene.audioSrc}`, fix: 'generate_audio' });
      }
    }
    // sceneSeconds floors every scene at 3 seconds, so the raw length is the honest signal.
    if (Math.max(scene.audioDuration ?? 0, scene.duration ?? 0) > 0 && Math.max(scene.audioDuration ?? 0, scene.duration ?? 0) < 3) {
      issues.push({ code: 'scene_too_short', severity: 'warning', sceneIndex: index, sceneId: scene.id, message: `${target}只有 ${Math.max(scene.audioDuration ?? 0, scene.duration ?? 0).toFixed(1)} 秒，画面会一闪而过。`, fix: 'open_captions' });
    }
    issues.push(...cueIssues(scene, index, portrait));
  });

  const estimatedSeconds = timelineFor(storyboard).totalSeconds;
  if (storyboard.durationTarget) {
    const drift = Math.abs(estimatedSeconds - storyboard.durationTarget) / storyboard.durationTarget;
    if (drift > 0.15) {
      issues.push({ code: 'duration_target_miss', severity: 'info', message: `预计时长 ${Math.round(estimatedSeconds)} 秒，与目标 ${Math.round(storyboard.durationTarget)} 秒相差 ${Math.round(drift * 100)}%。`, fix: 'open_render' });
    }
  }
  if (storyboard.bgmSrc && stale(storyboard.bgmSrc)) {
    issues.push({ code: 'missing_bgm', severity: 'error', message: `背景音乐文件已不存在：${storyboard.bgmSrc}`, fix: 'upload_asset' });
  }
  if (storyboard.subtitles?.enabled === false) {
    issues.push({ code: 'subtitles_off', severity: 'info', message: '字幕已关闭，导出视频不会带字幕文件。', fix: 'open_render' });
  }

  const full = portrait ? 1080 : 1920;
  return {
    issues,
    blocking: issues.filter(issue => issue.severity === 'error').length,
    warnings: issues.filter(issue => issue.severity === 'warning').length,
    estimatedSeconds: Math.round(estimatedSeconds * 10) / 10,
    width: preset === 'draft' ? full / 2 : full,
    height: preset === 'draft' ? (portrait ? 960 : 540) : portrait ? 1920 : 1080,
    preset,
  };
}
