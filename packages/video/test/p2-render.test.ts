/**
 * P2 render/export regressions: #150 re-sanitized font-family, #233 full disk, #265 renderer minimum,
 * #268 preset render quality.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportPresetSchema, StoryboardSchema, SubtitleSchema, estimateRender, presetChanges, sanitizeSceneHtml } from '../../schema/src/index';
import { checkSubtitles } from '../src/qc';
import { createElement } from 'react';
import { createRequire } from 'node:module';
import { SceneSchema } from '../../schema/src/index';
import { CodeSceneView } from '../src/code-scene';
import { renderCodeHtmlScene } from '../src/code-html-scene';

// packages/video has no react-dom dependency; resolve it from apps/web like code-scene.test.ts does.
const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { renderToStaticMarkup } = webRequire('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };

test('[#150] a quoted font-family survives a second sanitizer pass', () => {
  const once = sanitizeSceneHtml('<div style="font-family:&quot;Noto Sans SC&quot;, sans-serif;color:#ffffff">x</div>');
  const raw = sanitizeSceneHtml('<div style=\'font-family:"Noto Sans SC", sans-serif;color:#ffffff\'>x</div>');
  assert.match(raw, /font-family:&quot;Noto Sans SC&quot;, sans-serif/);
  assert.equal(sanitizeSceneHtml(raw), raw, '再次清洗结果不变');
  assert.match(once, /font-family:&quot;Noto Sans SC&quot;/);
});

test('[#233] a full disk is a reading, not unknown', () => {
  const plan = { preset: 'full', totalSeconds: 60, renderedSeconds: 60, renderedCount: 1, reusedCount: 0, segments: [{}] } as never;
  const estimate = estimateRender({ plan, freeDiskBytes: 0 });
  assert.equal(estimate.freeDiskBytes, 0);
  assert.ok(estimate.findings.some(finding => finding.code === 'disk_low'));
  assert.equal(estimateRender({ plan, freeDiskBytes: null }).freeDiskBytes, null);
});

const scene = (patch: Record<string, unknown>) => ({ id: 's', type: 'title', narration: '第一句。', visual: {}, ...patch });
test('[#265] a 2-second scene is stretched by the renderer and flagged', () => {
  const board = StoryboardSchema.parse({ title: 't', styleId: 'minimal-tech', scenes: [scene({ duration: 2, subtitleCues: [{ text: '一闪', start: 0, end: 0.3 }] })] });
  const result = checkSubtitles(board);
  assert.ok(result.issues.some(issue => issue.code === 'scene_too_short'));
  assert.ok(!result.issues.some(issue => issue.code === 'subtitle_too_short'), '被拉长的场景不判停留时间');
  const voiced = StoryboardSchema.parse({ title: 't', styleId: 'minimal-tech', scenes: [scene({ duration: 2, audioDuration: 5 })] });
  assert.ok(!checkSubtitles(voiced).issues.some(issue => issue.code === 'scene_too_short'), '音频足够长时场景不是被最短时长拉长');
});

test('[#268] the render quality row reflects the current quality', () => {
  const board = StoryboardSchema.parse({ title: 't', styleId: 'minimal-tech', scenes: [scene({ duration: 6 })] });
  const preset = ExportPresetSchema.parse({ id: 'p', name: '草稿', aspectRatio: board.aspectRatio ?? '16:9', renderPreset: 'draft', subtitles: SubtitleSchema.parse(board.subtitles ?? {}), transition: board.transition ?? 'none', createdAt: 'x', updatedAt: 'x' });
  assert.equal(presetChanges(board, preset, 'draft').find(change => change.key === 'renderPreset')!.changed, false);
  assert.equal(presetChanges(board, preset, 'full').find(change => change.key === 'renderPreset')!.changed, true);
});

test('[#168] line numbers sit in a fixed-width gutter in both renderers', () => {
  const code = Array.from({ length: 120 }, (_, index) => `  const value${index} = ${index};`).join('\n');
  const scene = SceneSchema.parse({ id: 'c', type: 'code', title: '长代码', narration: '讲解代码。', visual: { code, language: 'javascript' }, duration: 6 });
  const props = { scene, styleId: 'minimal-tech' as const, frame: 0, width: 1920, height: 1080 };
  const standard = renderToStaticMarkup(createElement(CodeSceneView, props));
  const widths = [...standard.matchAll(/data-line-gutter="true" style="display:inline-block;width:([\d.]+)px/g)].map(match => match[1]);
  assert.ok(widths.length > 1, '标准渲染输出行号槽');
  assert.equal(new Set(widths).size, 1, '每行行号槽等宽');
  const html = renderCodeHtmlScene(props);
  assert.match(html, /class="line-number" style="display:inline-block;width:\d+px/, 'HTML 渲染同样有固定宽度行号槽（经清洗后保留）');
});
