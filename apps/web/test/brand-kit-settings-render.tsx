import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandKitSchema, type BrandKit } from '@m2v/schema';
import { BrandKitDeleteDialog, BrandKitForm, BrandKitList } from '../src/components/brand-kit-settings';
import { BrandKitPreview } from '../src/components/brand-kit-preview';
import {
  BRAND_KIT_DELETE_NOTE,
  brandDraftPayload,
  brandKitLimitMessage,
  defaultBrandDraft,
  draftFromKit,
  isHexColor,
  normalizeHex,
  previewPalette,
  validateBrandKitDraft,
} from '../src/lib/brand-kit-ui';

/**
 * V1.6.7 #47 品牌套件设置页静态渲染 + 纯函数测试。
 * 无 jsdom：列表/表单/删除确认都是纯 props 组件，直接 renderToStaticMarkup。
 */

const noop = () => {};

const BASE_COLORS = { bg: '#080d19', fg: '#f3f7ff', muted: '#9aaac2', accent: '#50e3c2', card: '#111b2c', secondary: '#182741' };

function kit(patch: Record<string, unknown> = {}): BrandKit {
  return BrandKitSchema.parse({
    id: 'kit-1',
    name: 'ACME Corporate',
    isDefault: true,
    baseStyleId: 'minimal-tech',
    colors: { ...BASE_COLORS },
    typography: { headingFont: 'Arial', bodyFont: 'Arial' },
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
    ...patch,
  });
}

const renderList = (kits: BrandKit[], patch: { max?: number; loading?: boolean; error?: string; working?: boolean } = {}) => renderToStaticMarkup(createElement(BrandKitList, {
  kits,
  max: patch.max ?? 30,
  loading: patch.loading ?? false,
  working: patch.working ?? false,
  error: patch.error ?? '',
  notice: '',
  onStartCreate: noop,
  onEdit: noop,
  onDuplicate: noop,
  onSetDefault: noop,
  onDelete: noop,
}));

// ── 1. 空列表：解释品牌职责 + 创建入口 ──────────────────────────────────
const empty = renderList([]);
assert.ok(empty.includes('还没有品牌套件'), '空列表要有空状态');
assert.ok(empty.includes('＋ 新建品牌套件'), '空列表要有创建按钮');
assert.ok(empty.includes('品牌颜色、字体与 Logo'), '空状态说明品牌套件管理的内容');
assert.ok(!empty.includes('参考音频'), '品牌设置页不出现通用声音字段');

// ── 2. 列表卡片：Logo/名称/六色/基础 Style/默认标记 ────────────────────
const cardHtml = renderList([kit({ logo: { enabled: true, src: 'brand-kits/kit-1/logo.png', position: 'top-right', width: 160, opacity: 1, margin: 40 } })]);
assert.ok(cardHtml.includes('ACME Corporate'), '卡片显示品牌名称');
assert.ok(cardHtml.includes('<span class="preset-default">默认</span>'), '默认品牌有清晰标记');
assert.ok(cardHtml.includes('基础 Style：Minimal Tech'), '卡片显示基础 Style');
assert.ok(cardHtml.includes('src="/brand-kits/kit-1/logo.png"'), '卡片显示 Logo 缩略图');
assert.ok(cardHtml.includes('title="背景 #080d19"') && cardHtml.includes('title="强调 #50e3c2"'), '卡片显示六色简化色板');
assert.ok(cardHtml.includes('编辑') && cardHtml.includes('复制') && cardHtml.includes('删除'), '卡片提供编辑/复制/删除');

// ── 3. 上限提示（MAX_BRAND_KITS=30）────────────────────────────────────
const many = Array.from({ length: 30 }, (_, index) => kit({ id: `kit-${index}`, name: `品牌 ${index}`, isDefault: index === 0 }));
const atLimit = renderList(many, { max: 30 });
assert.ok(atLimit.includes(brandKitLimitMessage(30)), '达到上限时显示原因与处理方式');
assert.match(atLimit, /<button class="button primary" disabled="">＋ 新建品牌套件<\/button>/, '达到上限时禁止继续创建');

// ── 4. API 错误在当前列表/表单显示 ─────────────────────────────────────
assert.ok(renderList([], { error: '读取 Brand Kit 失败' }).includes('读取 Brand Kit 失败'), '列表错误显示在品牌区域');

// ── 5. 表单：非法 hex 即时提示，非法时保存按钮禁用 ─────────────────────
const draft = draftFromKit(kit());
const invalidDraft = { ...draft, colors: { ...draft.colors, accent: 'not-a-hex' } };
const invalidIssues = validateBrandKitDraft(invalidDraft);
assert.equal(invalidIssues.length, 1);
assert.equal(invalidIssues[0]!.field, 'colors.accent');
assert.equal(invalidIssues[0]!.message, '强调颜色必须是 #RRGGBB 格式');
const formHtml = renderToStaticMarkup(createElement(BrandKitForm, {
  draft: invalidDraft,
  issues: invalidIssues,
  editingId: 'kit-1',
  working: false,
  uploadingLogo: false,
  error: '',
  notice: '',
  pendingLogoName: '',
  onChange: noop,
  onLogoFile: noop,
  onSave: noop,
  onCancel: noop,
}));
assert.ok(formHtml.includes('强调颜色必须是 #RRGGBB 格式'), '非法 hex 在表单内即时提示');
assert.ok(formHtml.includes('aria-invalid="true"'), '非法 hex 输入标记 aria-invalid');
assert.match(formHtml, /<button class="button primary" disabled="">保存修改<\/button>/, '非法 hex 时禁止提交');
assert.ok(formHtml.includes('品牌颜色') && formHtml.includes('背景') && formHtml.includes('弱文字'), '六个调色板字段都出现');
assert.ok(formHtml.includes('标题字体') && formHtml.includes('正文字体'), '字体字段出现');
assert.ok(formHtml.includes('Logo') && formHtml.includes('启用 Logo'), 'Logo 配置出现');
assert.ok(formHtml.includes('宽度') && formHtml.includes('不透明度') && formHtml.includes('边距'), 'Logo 尺寸/透明度/边距可编辑');
assert.ok(formHtml.includes('位置') && formHtml.includes('右上'), 'Logo 四角位置可编辑');
assert.ok(!formHtml.includes('参考音频') && !formHtml.includes('导出画质') && !formHtml.includes('BGM 文件'), '品牌表单不混入 ProductionTemplate 设置');

// 合法草稿才允许构造提交体。
const validDraft = { ...draftFromKit(kit()), name: 'ACME 2026', colors: { ...BASE_COLORS, accent: '#ff8800' } };
const payload = brandDraftPayload(validDraft);
assert.equal(payload.ok, true);
if (payload.ok) {
  assert.equal(payload.value.name, 'ACME 2026');
  assert.equal(payload.value.colors.accent, '#ff8800');
  assert.equal(payload.value.logo, undefined, '未上传 Logo 时不提交 logo（schema 要求 src）');
}
assert.equal((brandDraftPayload(invalidDraft) as { ok: boolean }).ok, false, '非法十六进制不会构造提交体');

// ── 6. Logo 上传入口与保存中防重复提交（源码形状）─────────────────────
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const settingsSource = source('../src/components/brand-kits.tsx');
assert.ok(settingsSource.includes("fetch('/api/settings/brand-kits/logo'"), '复用 Logo 上传 API');
assert.ok(settingsSource.includes('brandKitId') && settingsSource.includes("form.set('file', file)"), 'multipart 携带 brandKitId+file');
assert.ok(settingsSource.includes('uploadingLogo'), '上传过程有独立状态');
assert.match(settingsSource, /Logo 上传失败/, '上传失败要在表单内显示');
assert.ok(settingsSource.includes('setFormError') && settingsSource.includes('setFormNotice'), 'API 错误/成功在表单里显示');
assert.ok(settingsSource.includes("disabled={working}") || settingsSource.includes('working'), '保存中有禁用状态');
assert.ok(settingsSource.includes('brandKitLimitMessage'), '上限提示由列表组件使用');
assert.ok(settingsSource.includes("method: 'DELETE'"), '删除调用品牌库 DELETE API');

// ── 7. 删除确认文案必须说明快照保留 ───────────────────────────────────
const deleteHtml = renderToStaticMarkup(createElement(BrandKitDeleteDialog, {
  kit: kit(),
  working: false,
  error: '',
  onConfirm: noop,
  onCancel: noop,
}));
assert.ok(deleteHtml.includes(BRAND_KIT_DELETE_NOTE), '删除确认包含 snapshot 说明原文');
assert.ok(deleteHtml.includes('已应用到项目的品牌快照会继续保留'), '删除文案明确 snapshot 不受影响');
assert.ok(deleteHtml.includes('确认删除'), '删除需要确认按钮');

// ── 8. 静态实时预览：背景/标题/正文/accent/card/Logo 位置 ─────────────
const logoDraft = draftFromKit(kit({
  logo: { enabled: true, src: 'brand-kits/kit-1/logo.png', position: 'bottom-left', width: 180, opacity: 0.85, margin: 60 },
}));
const previewHtml = renderToStaticMarkup(createElement(BrandKitPreview, { draft: logoDraft }));
assert.ok(previewHtml.includes('background:#080d19'), '预览使用品牌背景色');
assert.ok(previewHtml.includes('color:#f3f7ff'), '预览标题/正文使用品牌文字色');
assert.ok(previewHtml.includes('background:#50e3c2'), '预览 accent 强调块使用品牌强调色');
assert.ok(previewHtml.includes('background:#111b2c'), '预览卡片使用品牌 card 色');
assert.ok(previewHtml.includes('src="/brand-kits/kit-1/logo.png"'), '预览显示 Logo');
assert.match(previewHtml, /left:[0-9.]+%/, 'Logo 位置为左下');
assert.match(previewHtml, /bottom:[0-9.]+%/, 'Logo 位置为左下');
assert.ok(previewHtml.includes('opacity:0.85'), 'Logo 透明度进入预览');
assert.ok(previewHtml.includes('BRAND PREVIEW'), '预览是确定性静态卡片');
assert.deepEqual(previewPalette(invalidDraft), previewPalette({ ...draft, colors: { ...BASE_COLORS } }), '非法颜色回退到基础 Style 调色板');

// ── 9. 纯函数边界 ─────────────────────────────────────────────────────
assert.equal(normalizeHex('#ABCDEF'), '#abcdef');
assert.equal(normalizeHex('abcdef'), '#abcdef');
assert.equal(normalizeHex('#abc'), null);
assert.equal(normalizeHex(''), null);
assert.equal(isHexColor('#123456'), true);
assert.equal(isHexColor('#12345g'), false);
assert.equal(brandDraftPayload({ ...draftFromKit(kit()), name: '  ' }).ok, false, '空名称不允许提交');
assert.deepEqual(defaultBrandDraft('academic').colors, { bg: '#f2ead8', fg: '#2d2923', muted: '#736a5b', accent: '#8a3d2e', card: '#faf6eb', secondary: '#e6dcc6' }, '新建草稿从基础 Style 调色板开始');
assert.deepEqual(defaultBrandDraft('academic').typography, { headingFont: 'Georgia', bodyFont: 'Georgia' }, '新建草稿从基础 Style 字体开始');

console.log('PASS: 品牌套件设置页空列表/卡片/上限/非法 hex/删除确认/静态预览与 API 复用均有测试覆盖。');
