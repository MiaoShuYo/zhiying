import type { Scene, Storyboard } from './index';
import type { SubtitleSettings } from './delivery';

export type BatchLayout = 'auto' | 'stack' | 'columns' | 'compact';

/** Subtitle settings are project-level, so they are shown apart from the per-scene rows. */
export type BatchChanges = {
  layout?: BatchLayout;
  speechSpeed?: number;
  sentencePause?: number;
  sceneGap?: number;
  subtitles?: Partial<SubtitleSettings>;
};

export type BatchImpactRow = {
  /** -1 for project-level rows, which apply to every scene. */
  sceneIndex: number;
  sceneTitle: string;
  field: string;
  label: string;
  current: string;
  next: string;
};

export type BatchImpact = {
  scenes: number[];
  /** Rows that change one selected scene. */
  rows: BatchImpactRow[];
  /** Subtitle rows: they change every scene in the project. */
  projectRows: BatchImpactRow[];
  changes: number;
  /** Selected scenes whose existing voice track no longer matches the new speech settings. */
  staleAudio: number[];
  empty: boolean;
};

const layoutLabels: Record<BatchLayout, string> = { auto: '自适应', stack: '纵向排列', columns: '双栏', compact: '紧凑' };

const subtitleFieldLabels: Record<keyof SubtitleSettings, string> = {
  enabled: '字幕开关', preset: '字幕预设', position: '字幕位置', fontSize: '字幕字号',
  color: '字幕颜色', background: '字幕底色', backgroundOpacity: '底色不透明度',
};

const presetLabels: Record<string, string> = { minimal: '极简', boxed: '描边盒', highlight: '高亮' };
const positionLabels: Record<string, string> = { top: '顶部', center: '居中', bottom: '底部' };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 100) / 100;

const subtitleDefaults: SubtitleSettings = { enabled: true, preset: 'boxed', position: 'bottom', fontSize: 30, color: '#ffffff', background: '#000000', backgroundOpacity: 0.72 };

/** The voice route synthesises with 0.12s pauses when a scene never set one, so the preview must compare against that. */
const defaultSentencePause = 0.12;

function formatSubtitle(field: keyof SubtitleSettings, value: SubtitleSettings[keyof SubtitleSettings]): string {
  if (field === 'enabled') return value ? '开启' : '关闭';
  if (field === 'preset') return presetLabels[String(value)] ?? String(value);
  if (field === 'position') return positionLabels[String(value)] ?? String(value);
  if (field === 'backgroundOpacity') return `${Math.round(Number(value) * 100)}%`;
  if (field === 'fontSize') return `${value} px`;
  return String(value);
}

/** Applies the project defaults the renderer would fall back to, so "no change" is recognised as no change. */
export function effectiveSubtitles(board: Storyboard): SubtitleSettings {
  return { ...subtitleDefaults, ...board.subtitles };
}

export function batchImpact(board: Storyboard, selected: number[], changes: BatchChanges): BatchImpact {
  const scenes = [...new Set(selected)].filter(index => index >= 0 && index < board.scenes.length).sort((a, b) => a - b);
  const rows: BatchImpactRow[] = [];
  const staleAudio: number[] = [];
  for (const index of scenes) {
    const scene = board.scenes[index];
    const title = scene.title ?? scene.type;
    const push = (field: string, label: string, current: string, next: string) => {
      if (current !== next) rows.push({ sceneIndex: index, sceneTitle: title, field, label, current, next });
    };
    if (changes.layout !== undefined) {
      const current = scene.layout ?? 'auto';
      push('layout', '版式', layoutLabels[current], layoutLabels[changes.layout]);
    }
    if (changes.speechSpeed !== undefined) {
      const current = scene.speechSpeed ?? 1;
      const next = round(clamp(changes.speechSpeed, 0.5, 3));
      push('speechSpeed', '语速', `${current}×`, `${next}×`);
      if (current !== next && scene.audioSrc) staleAudio.push(index);
    }
    if (changes.sentencePause !== undefined) {
      const current = scene.sentencePause ?? defaultSentencePause;
      const next = round(clamp(changes.sentencePause, 0, 3));
      push('sentencePause', '句间停顿', `${current}s`, `${next}s`);
      if (current !== next && scene.audioSrc && !staleAudio.includes(index)) staleAudio.push(index);
    }    if (changes.sceneGap !== undefined) {
      const current = scene.sceneGap ?? 0;
      push('sceneGap', '场景间隔', `${current}s`, `${round(clamp(changes.sceneGap, 0, 10))}s`);
    }
  }
  const currentSubtitles = effectiveSubtitles(board);
  const projectRows: BatchImpactRow[] = [];
  for (const [field, value] of Object.entries(changes.subtitles ?? {}) as [keyof SubtitleSettings, SubtitleSettings[keyof SubtitleSettings]][]) {
    if (value === undefined) continue;
    const current = formatSubtitle(field, currentSubtitles[field]);
    const next = formatSubtitle(field, value);
    if (current !== next) projectRows.push({ sceneIndex: -1, sceneTitle: '全部场景', field: `subtitles.${field}`, label: subtitleFieldLabels[field], current, next });
  }
  return { scenes, rows, projectRows, changes: rows.length + projectRows.length, staleAudio, empty: rows.length + projectRows.length === 0 };
}

/** Pure: returns a new board so the caller can keep the previous one for a one-step undo. */
export function applyBatch(board: Storyboard, selected: number[], changes: BatchChanges): Storyboard {
  const scenes = new Set(batchImpact(board, selected, changes).scenes);
  const patch = (scene: Scene): Scene => {
    const next: Scene = { ...scene };
    if (changes.layout !== undefined) next.layout = changes.layout;
    if (changes.speechSpeed !== undefined) next.speechSpeed = round(clamp(changes.speechSpeed, 0.5, 3));
    if (changes.sentencePause !== undefined) next.sentencePause = round(clamp(changes.sentencePause, 0, 3));
    if (changes.sceneGap !== undefined) next.sceneGap = round(clamp(changes.sceneGap, 0, 10));
    return next;
  };
  const next: Storyboard = { ...board, scenes: board.scenes.map((scene, index) => scenes.has(index) ? patch(scene) : scene) };
  if (changes.subtitles && Object.values(changes.subtitles).some(value => value !== undefined)) {
    next.subtitles = { ...effectiveSubtitles(board), ...changes.subtitles };
  }
  return next;
}
