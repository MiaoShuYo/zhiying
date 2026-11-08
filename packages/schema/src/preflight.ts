import type { Scene, Storyboard } from './index';
import { timelineFor } from './timeline';
import { captionDuration, resolveCaptionCues } from './captions';
import { CAPTION_RESERVED_LINES, brandLogoPlacement, captionSafeArea, designCanvas, rendererScale } from './brand-layout';
import { SubtitleSchema } from './delivery';

export type PreflightSeverity = 'error' | 'warning' | 'info';

export type PreflightCode =
  | 'missing_image' | 'missing_file' | 'missing_audio' | 'empty_narration' | 'narration_too_long'
  | 'caption_overflow' | 'caption_overtime' | 'scene_too_short'
  | 'duration_target_miss' | 'missing_bgm' | 'subtitles_off'
  | 'brand_logo_caption_conflict' | 'brand_logo_too_large';

/** `fix` names the panel that can resolve the issue, so the UI can jump straight there. */
export type PreflightFix = 'upload_asset' | 'open_assets' | 'generate_audio' | 'open_captions' | 'open_render' | 'rewrite_narration' | 'open_brand_settings';

export type PreflightIssue = {
  code: PreflightCode;
  severity: PreflightSeverity;
  sceneIndex?: number;
  sceneId?: string;
  sceneTitle?: string;
  /** Zero-based row in the scene's resolved caption timeline. */
  cueIndex?: number;
  /** The exact file the issue is about, so repeated references collapse into one checklist row. */
  assetPath?: string;
  assetKind?: 'image' | 'audio' | 'bgm';
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
  narration_too_long: '旁白过长',
  caption_overflow: '字幕过长',
  caption_overtime: '字幕超出时长',
  scene_too_short: '场景过短',
  duration_target_miss: '时长偏离目标',
  missing_bgm: '背景音乐缺失',
  subtitles_off: '字幕已关闭',
  brand_logo_caption_conflict: '品牌 Logo 与字幕冲突',
  brand_logo_too_large: '品牌 Logo 尺寸过大',
};
export const preflightFixLabels: Record<PreflightFix, string> = {
  upload_asset: '补充素材',
  open_assets: '打开素材',
  generate_audio: '生成语音',
  open_captions: '打开字幕',
  open_render: '检查导出设置',
  rewrite_narration: '补充旁白',
  open_brand_settings: '打开品牌套件',
};

const sceneLabel = (scene: Scene, index: number) => `场景 ${index + 1}${scene.title ? `「${scene.title}」` : ''}`;
const sceneAssetPath = /^projects\/[A-Za-z0-9_-]+\/assets\/[^/]+$/;
/** Shared with the V1.3 subtitle QC so the panel and the render check never disagree. */
export const captionDisplayWidth = (text: string) => (text.match(/[A-Za-z0-9]/g)?.length ?? 0) * 0.55 + [...text.replace(/[A-Za-z0-9]/g, '')].length;
export const captionCharLimit = (portrait: boolean, fontSize = 30) => {
  const width = portrait ? 1080 : 1920;
  return Math.max(1, Math.floor((width * 0.9 - 36) / fontSize));
};

function captionLineCount(text: string, lineWidth: number) {
  return text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(captionDisplayWidth(line) / lineWidth)), 0);
}

function cueIssues(scene: Scene, index: number, portrait: boolean, fontSize: number): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const limit = captionCharLimit(portrait, fontSize);
  const target = sceneLabel(scene, index);
  const cues = resolveCaptionCues(scene, captionDuration(scene), portrait);
  const overflowIndexes = cues.flatMap((cue, cueIndex) => captionLineCount(cue.text, limit) > 2 ? [cueIndex] : []);
  for (const cueIndex of overflowIndexes) {
    issues.push({ code: 'caption_overflow', severity: 'warning', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, cueIndex, message: `${target}第 ${cueIndex + 1} 条字幕按当前字号预计超过两行，可能挤占画面。`, fix: 'open_captions' });
  }
  const window = scene.audioDuration ?? Math.max(3, scene.duration ?? 6);
  const lateCue = scene.subtitleCues?.find(cue => cue.end > window + 0.01);
  if (lateCue) {
    const orderedManualCues = (scene.subtitleCues ?? []).filter(cue => cue.text.trim() && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start).sort((a, b) => a.start - b.start);
    const lateIndex = orderedManualCues.indexOf(lateCue);
    issues.push({ code: 'caption_overtime', severity: 'warning', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, ...(lateIndex >= 0 ? { cueIndex: lateIndex } : {}), message: `${target}第 ${Math.max(0, lateIndex) + 1} 条手动字幕超出场景音频的 ${window.toFixed(2)} 秒。`, fix: 'open_captions' });
  }
  return issues;
}

/** Share of the design-canvas width above which a portrait Logo is visually dominant (issue #49 check 3). */
export const brandLogoSizeWarnRatio = 0.3;

/**
 * Conservative worst-case Logo height as a multiple of its width. The Logo asset's aspect ratio is
 * not stored in the brand snapshot, so the preflight assumes a square image: real logos are usually
 * wider than tall, which makes this an upper bound for the geometric check.
 */
export const brandLogoHeightEstimateRatio = 1;

/** Largest caption line count any scene needs, measured exactly like the caption QC and the renderer. */
function maxCaptionLines(storyboard: Storyboard, portrait: boolean, fontSize: number): number {
  const limit = captionCharLimit(portrait, fontSize);
  let lines = 1;
  for (const scene of storyboard.scenes) {
    for (const cue of resolveCaptionCues(scene, captionDuration(scene), portrait)) {
      lines = Math.max(lines, captionLineCount(cue.text, limit));
    }
  }
  return lines;
}

/**
 * Issue #49 brand delivery checks. They are deliberately project-level: the video renders the Logo
 * once, so one project-level finding is emitted no matter how many scenes reference it.
 *
 * The geometry is the renderer's own: `brandLogoPlacement` resolves the pinned edge and the lift
 * above the caption safe area, and `captionSafeArea` gives the reserved band. A Logo sharing the
 * caption edge is only reported when:
 * - the lift is insufficient for the captions a scene actually needs (the renderer reserves 2
 *   lines; more lines grow the caption block back into the Logo band), or
 * - the conservative square height estimate would push the lifted Logo past the frame edge.
 * "Same side but the layout is safe" therefore never warns.
 */
function brandLogoIssues(storyboard: Storyboard, portrait: boolean, stale: (path: string) => boolean): PreflightIssue[] {
  const logo = storyboard.brand?.logo;
  const src = typeof logo?.src === 'string' ? logo.src.trim() : '';
  if (!logo?.enabled || !src) return [];

  // Check 1: the Logo file does not exist. It is decorative, so this stays a warning: the export
  // must not be blocked, but the user has to know the Logo will be missing.
  if (stale(src)) {
    return [{
      code: 'missing_file',
      severity: 'warning',
      assetPath: src,
      assetKind: 'image',
      message: `品牌 Logo 文件不存在：${src}；请打开品牌套件设置重新上传 Logo。`,
      fix: 'open_brand_settings',
    }];
  }

  const issues: PreflightIssue[] = [];
  const canvas = designCanvas(portrait);

  // Check 3: extreme portrait size. The ratio is design-canvas based, so it does not depend on the
  // export resolution and a landscape canvas never trips the 500px schema cap.
  if (portrait && logo.width > canvas.width * brandLogoSizeWarnRatio) {
    issues.push({
      code: 'brand_logo_too_large',
      severity: 'warning',
      message: `竖屏画面中品牌 Logo 宽度占设计画布的 ${Math.round((logo.width / canvas.width) * 100)}%，超过 ${Math.round(brandLogoSizeWarnRatio * 100)}%；Logo 会占据过多画面，请打开品牌套件设置调小 Logo 宽度。`,
      fix: 'open_brand_settings',
    });
  }

  // Check 2: Logo and captions share a vertical edge. Center/opposite captions never move the Logo,
  // so `brandLogoPlacement` yields the plain margin and the check below is skipped.
  const placement = brandLogoPlacement({ logo, subtitles: storyboard.subtitles, videoWidth: canvas.width, videoHeight: canvas.height });
  const subtitles = SubtitleSchema.parse(storyboard.subtitles ?? {});
  if (placement && subtitles.enabled && subtitles.position === placement.verticalEdge) {
    const scale = rendererScale(canvas.width, canvas.height);
    const lines = maxCaptionLines(storyboard, portrait, subtitles.fontSize);
    const band = captionSafeArea({ videoHeight: canvas.height, fontSize: subtitles.fontSize, scale, lines });
    const estimatedHeight = placement.width * brandLogoHeightEstimateRatio;
    const overlapsCaptions = placement.verticalOffset < band.total - 1e-9;
    const squeezedOut = placement.verticalOffset + estimatedHeight > canvas.height;
    if (overlapsCaptions || squeezedOut) {
      const side = placement.verticalEdge === 'top' ? '顶部' : '底部';
      const reasons = [
        ...(overlapsCaptions ? [`字幕实际需要 ${lines} 行，超过 Logo 避让预留的 ${CAPTION_RESERVED_LINES} 行安全区`] : []),
        ...(squeezedOut ? ['按保守高度估计，Logo 被安全区抬高后会超出画面'] : []),
      ];
      issues.push({
        code: 'brand_logo_caption_conflict',
        severity: 'warning',
        message: `品牌 Logo 与${side}字幕同侧：${reasons.join('；')}，可能与字幕重叠或显示不全；请打开品牌套件设置调整 Logo 位置或大小。`,
        fix: 'open_brand_settings',
      });
    }
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
      if (!src) issues.push({ code: 'missing_image', severity: 'error', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, assetKind: 'image', message: `${target}是图片场景，但还没有选择图片。`, fix: 'upload_asset' });
      else if (!sceneAssetPath.test(src)) issues.push({ code: 'missing_image', severity: 'error', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, assetPath: src, assetKind: 'image', message: `${target}引用的图片不在项目素材目录内：${src}`, fix: 'open_assets' });
      else if (assetPaths.size > 0 && !assetPaths.has(src)) issues.push({ code: 'missing_image', severity: 'error', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, assetPath: src, assetKind: 'image', message: `${target}引用的图片没有登记在项目素材中：${src}`, fix: 'open_assets' });
      else if (stale(src)) issues.push({ code: 'missing_file', severity: 'error', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, assetPath: src, assetKind: 'image', message: `${target}引用的图片文件已不存在：${src}`, fix: 'upload_asset' });
    }
    if (!narration) {
      issues.push({ code: 'empty_narration', severity: 'warning', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, message: `${target}没有旁白，导出后会是静音画面。`, fix: 'rewrite_narration' });
    } else {
      const credit = typeof scene.visual.attribution === 'string' ? scene.visual.attribution.trim() : '';
      if (credit && credit === narration) {
        issues.push({ code: 'empty_narration', severity: 'warning', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, message: `${target}的旁白只是素材署名，需要补充真正的讲解。`, fix: 'rewrite_narration' });
      }
      const narrationLength = [...narration].length;
      const sceneDuration = Math.max(scene.duration ?? 0, scene.audioDuration ?? 0);
      if (narrationLength > 600 || sceneDuration > 300) {
        const message = narrationLength > 600
          ? `${target}旁白有 ${narrationLength} 字，预计口播约 ${Math.ceil(narrationLength / 5)} 秒；请拆分场景或精简旁白，避免超长画面和字幕。`
          : `${target}时长为 ${Math.round(sceneDuration)} 秒，过长的场景会拉长整条时间轴；请检查旁白和场景时长。`;
        issues.push({ code: 'narration_too_long', severity: 'warning', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, message, fix: 'rewrite_narration' });
      }
      if (!scene.audioSrc && !(scene.audioDuration && scene.audioDuration > 0)) {
        issues.push({ code: 'missing_audio', severity: 'error', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, assetKind: 'audio', message: `${target}还没有生成语音。`, fix: 'generate_audio' });
      } else if (scene.audioSrc && stale(scene.audioSrc)) {
        issues.push({ code: 'missing_file', severity: 'error', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, assetPath: scene.audioSrc, assetKind: 'audio', message: `${target}的语音文件已不存在：${scene.audioSrc}`, fix: 'generate_audio' });
      }
    }
    // sceneSeconds floors every scene at 3 seconds, so the raw length is the honest signal.
    if (Math.max(scene.audioDuration ?? 0, scene.duration ?? 0) > 0 && Math.max(scene.audioDuration ?? 0, scene.duration ?? 0) < 3) {
      issues.push({ code: 'scene_too_short', severity: 'warning', sceneIndex: index, sceneId: scene.id, sceneTitle: scene.title, message: `${target}只有 ${Math.max(scene.audioDuration ?? 0, scene.duration ?? 0).toFixed(1)} 秒，画面会一闪而过。`, fix: 'open_captions' });
    }
    issues.push(...cueIssues(scene, index, portrait, storyboard.subtitles?.fontSize ?? 30));
  });

  const estimatedSeconds = timelineFor(storyboard).totalSeconds;
  if (storyboard.durationTarget) {
    const drift = Math.abs(estimatedSeconds - storyboard.durationTarget) / storyboard.durationTarget;
    if (drift > 0.15) {
      issues.push({ code: 'duration_target_miss', severity: 'info', message: `预计时长 ${Math.round(estimatedSeconds)} 秒，与目标 ${Math.round(storyboard.durationTarget)} 秒相差 ${Math.round(drift * 100)}%。`, fix: 'open_render' });
    }
  }
  if (storyboard.bgmSrc && stale(storyboard.bgmSrc)) {
    issues.push({ code: 'missing_bgm', severity: 'error', assetPath: storyboard.bgmSrc, assetKind: 'bgm', message: `背景音乐文件已不存在：${storyboard.bgmSrc}`, fix: 'upload_asset' });
  }
  // Brand Logo findings are project-level (one Logo for the whole video) and never block export.
  issues.push(...brandLogoIssues(storyboard, portrait, stale));
  if (storyboard.subtitles?.enabled === false) {
    issues.push({ code: 'subtitles_off', severity: 'info', message: '字幕已关闭，导出视频不会带字幕文件。', fix: 'open_render' });
  }

  const full = designCanvas(portrait).width;
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

export const preflightCategories = ['voice', 'image', 'subtitle', 'asset', 'narration', 'render'] as const;
export type PreflightCategory = (typeof preflightCategories)[number];
export const preflightCategoryLabels: Record<PreflightCategory, string> = {
  voice: '缺失语音',
  image: '缺失图片',
  subtitle: '字幕',
  asset: '素材文件',
  narration: '旁白',
  render: '导出设置',
};

/** Which checklist bucket an issue belongs to; the panel renders one filter chip per category. */
export function preflightCategoryOf(issue: PreflightIssue): PreflightCategory {
  if (issue.code === 'missing_audio') return 'voice';
  if (issue.code === 'missing_image') return 'image';
  if (issue.code === 'missing_file') return issue.assetKind === 'audio' ? 'voice' : 'asset';
  if (issue.code === 'missing_bgm') return 'asset';
  if (issue.code === 'caption_overflow' || issue.code === 'caption_overtime') return 'subtitle';
  if (issue.code === 'brand_logo_caption_conflict') return 'subtitle';
  if (issue.code === 'brand_logo_too_large') return 'render';
  if (issue.code === 'empty_narration' || issue.code === 'narration_too_long') return 'narration';
  return 'render';
}

export type PreflightGroup = { category: PreflightCategory; label: string; issues: PreflightIssue[]; blocking: number; warnings: number };

export function preflightGroups(result: PreflightResult): PreflightGroup[] {
  return preflightCategories
    .map(category => {
      const issues = result.issues.filter(issue => preflightCategoryOf(issue) === category);
      return {
        category,
        label: preflightCategoryLabels[category],
        issues,
        blocking: issues.filter(issue => issue.severity === 'error').length,
        warnings: issues.filter(issue => issue.severity === 'warning').length,
      };
    })
    .filter(group => group.issues.length > 0);
}

export type PreflightGapKind = 'image' | 'audio' | 'bgm' | 'subtitle';

/** One row of the "missing files" checklist: a single file can be referenced by many scenes. */
export type PreflightGap = {
  key: string;
  kind: PreflightGapKind;
  path: string | null;
  label: string;
  message: string;
  severity: PreflightSeverity;
  fix: PreflightFix;
  cueIndex?: number;
  scenes: { sceneIndex: number; sceneId?: string; sceneTitle?: string; cueIndex?: number }[];
};

function gapKindOf(issue: PreflightIssue): PreflightGapKind | null {
  if (issue.code === 'missing_image') return 'image';
  if (issue.code === 'missing_audio') return 'audio';
  if (issue.code === 'missing_bgm') return 'bgm';
  if (issue.code === 'missing_file') return issue.assetKind === 'audio' ? 'audio' : issue.assetKind === 'bgm' ? 'bgm' : 'image';
  if (issue.code === 'caption_overflow' || issue.code === 'caption_overtime') return 'subtitle';
  return null;
}

const severityRank: Record<PreflightSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Collapses issues into a per-file checklist so "三个场景引用同一张丢失的图" is one row. */
export function preflightGaps(result: PreflightResult): PreflightGap[] {
  const gaps = new Map<string, PreflightGap>();
  for (const issue of result.issues) {
    const kind = gapKindOf(issue);
    if (!kind) continue;
    const key = issue.assetPath ? `path:${issue.assetPath}` : `${kind}:${issue.sceneId ?? issue.code}${issue.cueIndex === undefined ? '' : `:cue:${issue.cueIndex}`}`;
    let gap = gaps.get(key);
    if (!gap) {
      gap = {
        key,
        kind,
        path: issue.assetPath ?? null,
        label: preflightCodeLabels[issue.code],
        message: issue.message,
        severity: issue.severity,
        fix: issue.fix,
        ...(issue.cueIndex === undefined ? {} : { cueIndex: issue.cueIndex }),
        scenes: [],
      };
      gaps.set(key, gap);
    } else if (severityRank[issue.severity] < severityRank[gap.severity]) {
      gap.severity = issue.severity;
    }
    if (issue.sceneIndex !== undefined && !gap.scenes.some(scene => scene.sceneIndex === issue.sceneIndex && scene.cueIndex === issue.cueIndex)) {
      gap.scenes.push({ sceneIndex: issue.sceneIndex, sceneId: issue.sceneId, sceneTitle: issue.sceneTitle, ...(issue.cueIndex === undefined ? {} : { cueIndex: issue.cueIndex }) });
    }
  }
  return [...gaps.values()].sort((a, b) =>
    severityRank[a.severity] - severityRank[b.severity] || (a.scenes[0]?.sceneIndex ?? -1) - (b.scenes[0]?.sceneIndex ?? -1),
  );
}

/**
 * The checklist mixes genuinely missing files with caption timing warnings, so the
 * summary must count them apart: a long subtitle is not a missing file.
 */
export function preflightGapCounts(gaps: PreflightGap[]): { files: number; subtitles: number } {
  const subtitles = gaps.filter(gap => gap.kind === 'subtitle').length;
  return { files: gaps.length - subtitles, subtitles };
}

export type PreflightDelta = { fixed: number; added: number; remaining: number };

const issueKey = (issue: PreflightIssue) => `${issue.code}|${issue.sceneId ?? '-'}|${issue.assetPath ?? '-'}|${issue.cueIndex ?? '-'}`;

/** Compares two checks so the panel can say what the last fix actually resolved. */
export function preflightDelta(previous: PreflightResult | null, current: PreflightResult): PreflightDelta {
  if (!previous) return { fixed: 0, added: 0, remaining: current.issues.length };
  const before = new Set(previous.issues.map(issueKey));
  const after = new Set(current.issues.map(issueKey));
  return {
    fixed: [...before].filter(key => !after.has(key)).length,
    added: [...after].filter(key => !before.has(key)).length,
    remaining: current.issues.length,
  };
}
