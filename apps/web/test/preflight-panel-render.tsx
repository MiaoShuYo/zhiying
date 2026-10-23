import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SceneSchema, StoryboardSchema, preflight } from '@m2v/schema';
import { PreflightPanel } from '../src/components/preflight-panel';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({ id: 'a', type: 'title', narration: '第一句。第二句。', visual: {}, duration: 6, ...patch });
const board = (scenes: Record<string, unknown>[]) => StoryboardSchema.parse({ title: '例子', styleId: 'minimal-tech', scenes });
const image = 'projects/p/assets/a.png';
const long = { subtitleCues: [{ text: '很'.repeat(40), start: 0, end: 2 }] };

const render = (data: ReturnType<typeof preflight>) => renderToStaticMarkup(createElement(PreflightPanel, {
  data,
  previous: null,
  loading: false,
  error: '',
  allowIssues: false,
  onAllowChange: () => {},
  onRefresh: () => {},
  onFix: () => {},
  onLocateScene: () => {},
}));

// Nothing missing: one over-long cue must not be counted as a missing file.
const captionsOnly = render(preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 6, ...long })]), [], { exists: () => true }));
assert.ok(captionsOnly.includes('缺失文件<b>0</b>'), '没有缺失素材时「缺失文件」必须是 0');
assert.ok(captionsOnly.includes('字幕问题<b>1</b>'), '字幕问题单独计数');
assert.ok(captionsOnly.includes('字幕时间轴问题（1）'), '字幕问题要有自己的分组');
assert.ok(!captionsOnly.includes('缺失语音、图片与素材文件（'), '没有缺失文件时不显示该分组');
assert.ok(captionsOnly.includes('打开字幕'), '字幕问题仍给出可直接跳转的修复入口');

// A missing image plus the same cue: the file count is 1, not 2.
const mixed = render(preflight(
  board([scene({ type: 'media', visual: { src: image }, audioSrc: 'audio/a.wav', audioDuration: 6, ...long })]),
  [{ path: image, kind: 'image' }],
  { exists: path => path !== image },
));
assert.ok(mixed.includes('缺失文件<b>1</b>'), '缺图只算一个缺失文件');
assert.ok(mixed.includes('字幕问题<b>1</b>'), '缺图不影响字幕计数');
assert.ok(mixed.includes('缺失语音、图片与素材文件（1）'), '缺失文件分组照常出现');
assert.ok(mixed.includes('字幕时间轴问题（1）'), '字幕分组与缺失文件分组并列');
assert.ok(mixed.includes('场景 1'), '缺失条目要能定位到场景');

// Clean project: no gap sections at all.
const clean = render(preflight(board([scene({ audioSrc: 'audio/a.wav', audioDuration: 6 })]), []));
assert.ok(clean.includes('缺失文件<b>0</b>'), '干净项目也显示 0');
assert.ok(!clean.includes('字幕问题'), '没有字幕问题时不多出一个数字');
assert.ok(!clean.includes('字幕时间轴问题'), '没有字幕问题时不显示分组');
assert.ok(clean.includes('没有发现需要处理的问题，可以直接导出。'), '干净项目要说明可以直接导出');

console.log('PASS: 导出前检查把字幕时间轴问题单独计数与分组，「缺失文件」只统计真的缺失或未登记的语音、图片与素材，并保留跳转场景与修复入口。');

// Defects 2–4 are interaction-level, so guard the code shapes that fix them.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const editor = source('../src/components/project-editor.tsx');
assert.ok(editor.includes('applyAssetToScene'), '点选素材要经过统一的选图入口');
assert.ok(editor.includes("scene.type === 'media'"), '图片场景要原地替换画面');
assert.match(editor, /board\.scenes\.map\(\(item, itemIndex\) => \(itemIndex === index \? \{ \.\.\.item, visual:/, '替换而不是追加场景');
assert.ok(editor.includes('点选后用作场景'), '素材卡片要写明点选的作用范围');
assert.ok(!/function useLocalImage[\s\S]{0,400}scenes\.length\]/.test(editor), '点选图片不再追加场景');

const assets = source('../src/components/asset-manager.tsx');
assert.ok(assets.includes('linkMissing'), '缺失素材要能关联到已有素材');
assert.ok(assets.includes('关联到已有素材'), '缺失行要给出关联入口');
assert.ok(assets.includes('上传并关联') && assets.includes('上传补齐'), '上传按钮要说明是否同时改引用');
assert.match(assets, /const value = e\.currentTarget\.value;\s*setLinked\(current => \(\{ \.\.\.current, \[item\.path\]: value \}\)\)/, '先在事件回调中读取选中值，避免异步状态更新时 currentTarget 已清空');

const delivery = source('../src/components/quality-delivery.tsx');
assert.ok(delivery.includes('settledStatuses'), '成片列表要知道哪些渲染任务还没结束');
assert.match(delivery, /setInterval\([\s\S]{0,200}readExports/, '有渲染任务未结束时轮询成片列表');
assert.match(delivery, /checkQc[\s\S]{0,900}readExports/, '开始检查后要重新读一次成片列表');

const storage = source('../src/components/maintenance-panel.tsx');
const tools = source('../src/components/production-tools.tsx');
assert.match(storage, /const load = useCallback\(async \(\) => \{[\s\S]{0,400}\}, \[id\]\)/, '空间占用读取函数随项目 ID 稳定更新');
assert.match(storage, /useEffect\(\(\) => \{ void load\(\)\.catch\(error => setMessage\(String\(error\)\)\); \}, \[load, refreshKey\]\)/, '场景素材引用变化后，空间占用和未引用清单要重新读取');
assert.ok(tools.includes('refreshKey={storageRefreshKey}'), '把当前素材引用状态传到空间占用面板');

console.log('PASS: 点选素材替换当前场景画面、缺失素材可关联已有素材、质检页能自己等到最新成片。');
