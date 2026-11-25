/**
 * P2 caption/QC regressions: #324 closing quotes, #292 width splits, #225 font-size-aware QC,
 * #264 preset preview colours, #232 estimate calibration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportPresetSchema, StoryboardSchema, SubtitleSchema, buildCaptionCues, estimateRender, preflight, presetChanges } from '../../schema/src/index';
import { checkSubtitles } from '../src/qc';

test('[#324] a closing quote stays with the sentence it closes', () => {
  assert.deepEqual(buildCaptionCues('他说：“你好。”').map(cue => cue.text), ['他说：“你好。”']);
  const cues = buildCaptionCues('他说：“你好。”然后他离开了。').map(cue => cue.text);
  assert.ok(cues.every(text => !text.startsWith('”')), JSON.stringify(cues));
  assert.ok(cues.some(text => text.endsWith('你好。”')), JSON.stringify(cues));
});

const sceneOf = (patch: Record<string, unknown>) => ({ id: 's1', type: 'text', title: '标题', narration: '旁白', visual: { text: '正文' }, duration: 6, audioSrc: 'audio/a.wav', audioDuration: 6, ...patch });
const boardOf = (scene: Record<string, unknown>, patch: Record<string, unknown> = {}) => StoryboardSchema.parse({ title: '片名', styleId: 'minimal-tech', scenes: [scene], ...patch });

test('[#292] a long unpunctuated Chinese run is split into fitting cues, not reported as overflow', () => {
  const result = preflight(boardOf(sceneOf({ narration: '字'.repeat(50) })), []);
  assert.equal(result.issues.filter(issue => issue.code === 'caption_overflow').length, 0);
});

test('[#225] subtitle QC uses the configured font size and the two-line limit', () => {
  const big = checkSubtitles(boardOf(sceneOf({ subtitleCues: [{ text: '字'.repeat(28), start: 0, end: 6 }] }), { aspectRatio: '9:16', subtitles: { fontSize: 72 } }));
  assert.ok(big.issues.some(issue => issue.code === 'subtitle_too_long'), '72px 下 28 个字是三行');
  const twoLines = checkSubtitles(boardOf(sceneOf({ subtitleCues: [{ text: '字'.repeat(40), start: 0, end: 6 }] }), { aspectRatio: '9:16' }));
  assert.equal(twoLines.issues.filter(issue => issue.code === 'subtitle_too_long').length, 0, '默认字号下两行以内不报');
});

test('[#264] a colour-only preset change is visible in the preview', () => {
  const board = boardOf(sceneOf({}), { subtitles: { color: '#ffffff' } });
  const preset = ExportPresetSchema.parse({ id: 'p', name: '黄色字幕', aspectRatio: '16:9', subtitles: SubtitleSchema.parse({ ...board.subtitles, color: '#ffcc00' }), intro: board.intro, outro: board.outro, transition: board.transition ?? 'none', createdAt: 'x', updatedAt: 'x' });
  const row = presetChanges(board, preset).find(change => change.key === 'subtitles')!;
  assert.equal(row.changed, true);
  assert.notEqual(row.current, row.next);
  assert.match(row.next, /#ffcc00/);
});

test('[#232] cache-only exports do not calibrate frame speed', () => {
  const plan = { preset: 'full', totalSeconds: 600, renderedSeconds: 600, renderedCount: 10, reusedCount: 0, segments: Array.from({ length: 10 }, () => ({})) } as never;
  const cold = estimateRender({ plan });
  const cached = estimateRender({ plan, samples: Array.from({ length: 6 }, () => ({ preset: 'full', videoSeconds: 600, durationSeconds: 60, renderedSeconds: 0, segmentCount: 10 })) });
  assert.equal(cached.totalDurationSeconds, cold.totalDurationSeconds);
  assert.equal(cached.confidence, 'low');
  const real = estimateRender({ plan, samples: [{ preset: 'full', videoSeconds: 600, durationSeconds: 1200, renderedSeconds: 600, segmentCount: 10 }] });
  assert.ok(real.totalDurationSeconds <= 1200 + 1, `编码与开销不重复计入：${real.totalDurationSeconds}`);
});
