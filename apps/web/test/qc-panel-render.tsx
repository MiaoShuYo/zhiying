import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StoryboardSchema } from '@m2v/schema';
import { QualityDelivery } from '../src/components/quality-delivery';

const board = StoryboardSchema.parse({
  title: '质检测试', styleId: 'minimal-tech',
  scenes: [{ id: 's1', type: 'title', title: '开场', narration: '第一句旁白。', duration: 6 }],
});

const render = (patch: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(QualityDelivery, {
  id: 'project-1',
  board,
  busy: false,
  save: async () => true,
  onLocate: () => {},
  onRegenerateAudio: () => {},
  onApplyPreset: () => {},
  onOpenRender: () => {},
  currentPreset: 'full',
  onTemplateApplied: () => {},
  ...patch,
}));

const html = render();

for (const copy of ['成片质检', '开始检查', '重新测量音频', '检查字幕、旁白音量、背景音乐、场景时长与最近一次渲染']) {
  assert.ok(html.includes(copy), `质检卡片缺少「${copy}」`);
}
for (const copy of ['成片文件校验', '还没有渲染完成的成片', '前往渲染导出']) {
  assert.ok(html.includes(copy), `成片文件校验卡片缺少「${copy}」`);
}
for (const copy of ['交付包', 'MP4 成片', '缺少渲染完成的成片', '字幕 SRT / VTT / ASS', '封面图', '项目备份 .m2v', '生成交付包 ZIP', '字幕与成片使用同一时间轴']) {
  assert.ok(html.includes(copy), `交付包卡片缺少「${copy}」`);
}
assert.ok(!html.includes('qc-status'), '未检查时不显示四态徽标');
assert.ok(!html.includes('再次下载'), '没有交付包时不显示重复下载入口');
for (const copy of ['导出预设', '保存当前设置', '预设名称，例如「竖屏交付」', '不改动分镜、旁白与素材', '将保存：画幅 16:9 · 字幕底板 · 无片头 / 无片尾 · 转场 直切']) {
  assert.ok(html.includes(copy), `导出预设卡片缺少「${copy}」`);
}
assert.ok(html.includes('还没有保存过导出预设'), '没有预设时要有空状态提示');
assert.ok(!html.includes('字幕质检'), '检查之前不显示分组结果');
assert.ok(!html.includes('校验通过'), '没有校验记录时不能预判结论');

const portrait = render({ board: StoryboardSchema.parse({ ...board, aspectRatio: '9:16', transition: 'fade', intro: { enabled: true, title: '片头' }, subtitles: { preset: 'highlight' } }) });
assert.ok(portrait.includes('将保存：画幅 9:16 · 字幕醒目 · 片头 / 无片尾 · 转场 淡入淡出'), '预设摘要要跟随当前画幅、字幕、片头片尾与转场');
assert.ok(portrait.includes('使用片头标题卡'), '有片头时封面图来自标题卡');

const source = readFileSync(new URL('../src/components/quality-delivery.tsx', import.meta.url), 'utf8');
assert.ok(!source.includes('window.confirm'), '应用预设前用可读的差异预览代替原生确认框');
assert.ok(source.includes('presetChanges') && source.includes('changedPresetCount'), '应用预设前先算出会修改哪些导出设置');
assert.ok(source.includes('deliveryStepLabels'), '交付包失败时要指出缺失环节');
assert.ok(source.includes('再次下载'), '交付包已生成时提供重复下载入口');
assert.ok(source.includes('stale'), '阻断或项目变更后旧包要单独标为已过期，而不是继续显示已生成');
assert.ok(source.includes('readExports') && source.includes('savePackage'), '连接中断后要按记录判断包是否真的生成，并单独处理下载');
assert.ok(source.includes('startDownload') && !source.includes('createObjectURL'), 'ZIP 交给浏览器原生下载，不能整包读进页面内存');
assert.ok(source.includes('有意静音'), '空台词场景要说成有意静音，而不是当成还没测的漏配旁白');
assert.ok(source.includes('qc.audio.silent'), '面板要读语音质检的 silent 计数，才能说明哪些场景是有意静音');

console.log('PASS: 质检交付面板渲染出成片质检、成片文件校验、交付包与导出预设四张卡片，空状态给出下一步入口，预设摘要跟随当前画幅、字幕样式、片头片尾与转场，且不预判未执行的校验结论。');