import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandKitSchema, type BrandKit } from '@m2v/schema';
import { BrandKitChangeDialog, BrandKitPicker, ProjectBrandBar } from '../src/components/brand-kit-picker';

/**
 * V1.6.7 #48 项目侧品牌 UI 测试：
 * - 项目编辑器品牌区域（显示 / 来源已删除 / 锁定态）；
 * - 切换确认文案明确“将更新 / 不会修改”；
 * - 选择器列出 Logo/名称/简化色板/base style/默认标记；
 * - 新建项目弹窗品牌字段、pending 品牌注入与 locateIssue 跳转的源码形状。
 */

const noop = () => {};
const COLORS = { bg: '#111827', fg: '#f9fafb', muted: '#9ca3af', accent: '#ef4444', card: '#1f2937', secondary: '#374151' };

function kit(patch: Record<string, unknown> = {}): BrandKit {
  return BrandKitSchema.parse({
    id: 'kit-a',
    name: 'ACME Corporate',
    isDefault: true,
    baseStyleId: 'minimal-tech',
    colors: { ...COLORS },
    typography: { headingFont: 'Georgia', bodyFont: 'Georgia' },
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
    ...patch,
  });
}

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// ── 1. 项目品牌区域：显示当前品牌 + 操作入口 ──────────────────────────
const bar = renderToStaticMarkup(createElement(ProjectBrandBar, {
  brandName: 'ACME Corporate',
  brandColors: COLORS,
  stale: false,
  disabled: false,
  working: false,
  error: '',
  notice: '',
  onOpenPicker: noop,
  onReapply: noop,
  onRemove: noop,
}));
assert.ok(bar.includes('品牌：') && bar.includes('ACME Corporate'), '显示当前品牌名称');
assert.ok(bar.includes('更换') && bar.includes('重新应用') && bar.includes('移除'), '提供更换/重新应用/移除');
assert.ok(bar.includes('title="背景 #111827"'), '品牌区域显示当前色板');

// ── 2. 来源套件已删除：项目仍可打开，允许更换或移除 ───────────────────
const staleBar = renderToStaticMarkup(createElement(ProjectBrandBar, {
  brandName: 'ACME Corporate',
  brandColors: COLORS,
  stale: true,
  disabled: false,
  working: false,
  error: '',
  notice: '',
  onOpenPicker: noop,
  onReapply: noop,
  onRemove: noop,
}));
assert.ok(staleBar.includes('来源套件已删除'), 'stale brandKitId 显示来源套件已删除');
assert.ok(staleBar.includes('品牌快照'), '说明项目继续使用快照');
assert.ok(staleBar.includes('更换') && staleBar.includes('移除'), '仍允许更换或移除');
assert.ok(!staleBar.includes('重新应用'), '来源已删除时不显示无法完成的重新应用');

// ── 3. 锁定/忙碌态：按钮禁用并说明原因 ────────────────────────────────
const disabledBar = renderToStaticMarkup(createElement(ProjectBrandBar, {
  brandName: 'ACME Corporate',
  brandColors: COLORS,
  stale: false,
  disabled: true,
  working: false,
  error: '项目正在执行渲染任务，请稍后再试',
  notice: '',
  onOpenPicker: noop,
  onReapply: noop,
  onRemove: noop,
}));
assert.ok(disabledBar.includes('项目正在执行任务'), '锁定/忙碌时说明按钮不可用原因');
assert.match(disabledBar, /<button class="button subtle" disabled="">更换<\/button>/, '忙碌时更换按钮禁用');
assert.ok(disabledBar.includes('role="alert"'), '切换错误显示在品牌区域');

// ── 4. 未应用品牌：显示“未应用”并提供选择入口 ────────────────────────
const emptyBar = renderToStaticMarkup(createElement(ProjectBrandBar, {
  brandName: null,
  stale: false,
  disabled: false,
  working: false,
  error: '',
  notice: '',
  onOpenPicker: noop,
  onReapply: noop,
  onRemove: noop,
}));
assert.ok(emptyBar.includes('未应用') && emptyBar.includes('选择品牌'), '没有品牌时可选择品牌');

// ── 5. 切换确认：明确列出将更新 / 不会修改 ───────────────────────────
const applyDialog = renderToStaticMarkup(createElement(BrandKitChangeDialog, {
  kind: 'apply',
  kitName: 'ACME Corporate',
  working: false,
  error: '',
  onConfirm: noop,
  onCancel: noop,
}));
for (const update of ['将更新', '品牌颜色', '标题/正文字体', 'Logo']) assert.ok(applyDialog.includes(update), `切换确认包含「${update}」`);
for (const keep of ['不会修改', '旁白', '分镜内容', '配音', '语速/停顿', '字幕时间', '场景时长', '制作方案']) assert.ok(applyDialog.includes(keep), `切换确认包含「${keep}」`);
assert.ok(applyDialog.includes('不会调用 Qwen'), '确认框说明不触发 LLM/TTS');
assert.ok(applyDialog.includes('确认切换') && applyDialog.includes('取消'), '确认框提供确认/取消');

const removeDialog = renderToStaticMarkup(createElement(BrandKitChangeDialog, {
  kind: 'remove',
  kitName: 'ACME Corporate',
  working: false,
  error: '',
  onConfirm: noop,
  onCancel: noop,
}));
assert.ok(removeDialog.includes('将移除'), '移除确认使用“将移除”');
assert.ok(removeDialog.includes('确认移除'), '移除确认按钮');
assert.ok(removeDialog.includes('旁白') && removeDialog.includes('字幕时间'), '移除也说明不会修改旁白/字幕时间');

// ── 6. 选择器：Logo/名称/简化色板/base style/默认标记 ─────────────────
const pickerHtml = renderToStaticMarkup(createElement(BrandKitPicker, {
  kits: [
    kit({ logo: { enabled: true, src: 'brand-kits/kit-a/logo.png', position: 'top-right', width: 160, opacity: 1, margin: 40 } }),
    kit({ id: 'kit-b', name: '品牌乙', isDefault: false, baseStyleId: 'academic' }),
  ],
  currentKitId: 'kit-a',
  loading: false,
  disabled: false,
  error: '',
  onSelect: noop,
  onClose: noop,
}));
assert.ok(pickerHtml.includes('ACME Corporate') && pickerHtml.includes('品牌乙'), '选择器列出所有品牌');
assert.ok(pickerHtml.includes('默认'), '选择器标记默认品牌');
assert.ok(pickerHtml.includes('基础 Style：Minimal Tech') && pickerHtml.includes('基础 Style：Academic'), '选择器显示 base style');
assert.ok(pickerHtml.includes('title="强调 #ef4444"'), '选择器显示简化色板');
assert.ok(pickerHtml.includes('src="/brand-kits/kit-a/logo.png"'), '选择器显示 Logo');
assert.ok(pickerHtml.includes('当前'), '选择器标记当前项目品牌');
const emptyPicker = renderToStaticMarkup(createElement(BrandKitPicker, {
  kits: [], loading: false, disabled: false, error: '', onSelect: noop, onClose: noop,
}));
assert.ok(emptyPicker.includes('还没有品牌套件'), '品牌库为空时给出创建引导');
const loadingPicker = renderToStaticMarkup(createElement(BrandKitPicker, {
  kits: [], loading: true, disabled: false, error: '', onSelect: noop, onClose: noop,
}));
assert.ok(loadingPicker.includes('正在读取品牌套件'), '品牌库读取中显示加载态');

// ── 7. 项目编辑器源码：API 调用、先保存、确认与跳转 ──────────────────
const editor = source('../src/components/project-editor.tsx');
assert.ok(editor.includes("fetch(`/api/projects/${data.id}/brand-kit`"), '项目编辑器调用项目品牌 API');
assert.match(editor, /method: 'DELETE'/, '移除品牌调用 DELETE');
assert.ok(editor.includes("'if-match': String(revisionRef.current)"), '携带 if-match 处理保存冲突');
assert.ok(editor.includes('分镜保存失败，请先保存再切换品牌') && editor.includes('分镜保存失败，请先保存再移除品牌'), '切换/移除前先保存未落库分镜');
assert.ok(editor.includes('BrandKitChangeDialog') && editor.includes('BrandKitPicker'), '项目编辑器接入选择器与确认框');
assert.ok(editor.includes('adoptBrandStoryboard'), '品牌 API 返回的 storyboard/revision 被采纳');
assert.ok(editor.includes('open_brand_settings') && editor.includes("window.location.assign('/settings#brand-kits')"), 'preflight 品牌修复跳转设置页品牌套件区域');
assert.ok(editor.includes('persistBoard'), '切换品牌复用既有保存逻辑');
assert.ok(!editor.includes('brand-kits/logo'), '项目编辑器不上传/编辑品牌内容本身');

// ── 8. 新建视频弹窗：独立品牌下拉、默认选择、无品牌、不影响 Style ─────
const dashboard = source('../src/components/dashboard.tsx');
assert.ok(dashboard.includes("form.set('brandKitId', brandKitId)"), '创建请求提交 brandKitId');
assert.ok(dashboard.includes('品牌套件') && dashboard.includes('无品牌'), '新建弹窗有独立品牌套件字段与“无品牌”');
assert.ok(dashboard.includes('/api/settings/brand-kits'), '新建弹窗读取品牌库');
assert.ok(dashboard.includes('isDefault'), '有默认品牌时可默认选中');
assert.ok(dashboard.includes('视频风格') && dashboard.includes('styleIds.map'), '品牌选择不影响 Style 选择');

// ── 9. Listener/主流程源码：pending 注入与消费 ────────────────────────
const pipeline = source('../src/lib/pipeline.ts');
assert.ok(pipeline.includes('resolveCreationBrandKitId'), 'createProject 校验并保存 pending 品牌');
assert.ok(pipeline.includes('writeImportSettings'), 'pending 品牌写入 import-settings.json');
assert.ok(pipeline.includes('applyPendingBrandSnapshot'), 'runProject 首次构造 storyboard 时注入快照');
assert.ok(pipeline.includes('consumePendingBrandKitId'), '首次落库成功后消费 pending 品牌');
const pending = source('../src/lib/brand-kit-pending.ts');
assert.ok(pending.includes('copyBrandLogoToProject'), 'pending 品牌复制 Logo 为项目自有文件');
assert.ok(pending.includes('snapshotFromBrandKit'), 'pending 品牌复制独立快照');
assert.ok(pending.includes('parseImportSettings'), 'import-settings 解析可独立测试');
const projectApi = source('../src/app/api/projects/route.ts');
assert.ok(projectApi.includes("form.get('brandKitId')"), 'POST /api/projects 接受 brandKitId');

console.log('PASS: 项目品牌区域/来源删除/锁定态/切换确认/选择器与新建弹窗、pending 注入源码形状均有覆盖。');
