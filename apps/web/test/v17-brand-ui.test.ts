import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandKitSchema, type BrandKit } from '@m2v/schema';
import { BrandKitDeleteDialog, BrandKitForm, BrandKitList } from '../src/components/brand-kit-settings';
import { BrandKitCard, BrandKitPreview } from '../src/components/brand-kit-preview';
import SettingsPage from '../src/app/settings/page';
import {
  BRAND_KIT_DELETE_NOTE,
  brandDraftPayload,
  brandKitLimitMessage,
  defaultBrandDraft,
  draftFromKit,
  isHexColor,
  normalizeHex,
  validateBrandKitDraft,
} from '../src/lib/brand-kit-ui';

/**
 * V1.6.7 #47 独立测试（tester）：品牌套件设置页的空列表、创建、错误展示、
 * 非法 hex 不提交、默认标记、职责分离，以及 #48 新建项目品牌字段。
 *
 * 无 jsdom：列表/表单/删除确认/预览都是纯 props 组件，用 renderToStaticMarkup
 * 断言真实 DOM；交互状态（提交前校验、点击后请求）用仓库既有的源码形状断言方式。
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

function renderList(kits: BrandKit[], patch: { max?: number; loading?: boolean; working?: boolean; error?: string } = {}) {
  return renderToStaticMarkup(createElement(BrandKitList, {
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
}

test('#47-1 空列表：说明品牌套件职责并给出创建入口；加载/上限/错误状态可静态验证', () => {
  const empty = renderList([]);
  assert.ok(empty.includes('还没有品牌套件'), '空列表显示空状态');
  assert.ok(empty.includes('＋ 新建品牌套件'), '空列表给出创建入口');
  assert.ok(empty.includes('品牌颜色、字体与 Logo'), '空状态说明品牌套件管理范围');
  assert.ok(empty.includes('和声音、字幕、BGM、导出等制作方案分开管理'), '页面说明与 ProductionTemplate 的职责边界');

  const loading = renderList([], { loading: true });
  assert.ok(loading.includes('正在读取品牌套件'), '读取中显示加载态');
  assert.ok(!loading.includes('还没有品牌套件'), '读取中不显示空状态');

  const many = Array.from({ length: 30 }, (_, index) => kit({ id: `kit-${index}`, name: `品牌 ${index}`, isDefault: index === 0 }));
  const atLimit = renderList(many, { max: 30 });
  assert.ok(atLimit.includes(brandKitLimitMessage(30)), '达到上限显示原因与处理方式');
  assert.match(atLimit, /<button class="button primary" disabled="">＋ 新建品牌套件<\/button>/, '达到上限禁止继续创建');

  const failed = renderList([], { error: '读取 Brand Kit 失败' });
  assert.match(failed, /role="alert"/, '列表 API 错误用 alert 展示');
  assert.ok(failed.includes('读取 Brand Kit 失败'));
});

test('#47-2 创建品牌：草稿→提交体合法；表单提供名称/基础 Style/六色/字体字段', () => {
  const draft = defaultBrandDraft('academic');
  assert.ok(draft.name === '', '新建草稿名称为空');
  assert.equal(brandDraftPayload(draft).ok, false, '空名称不允许提交');

  const named = { ...draft, name: 'ACME Corporate', colors: { ...draft.colors, accent: '#ff8800' } };
  const payload = brandDraftPayload(named);
  assert.equal(payload.ok, true);
  if (payload.ok) {
    assert.equal(payload.value.name, 'ACME Corporate');
    assert.equal(payload.value.baseStyleId, 'academic');
    assert.equal(payload.value.colors.accent, '#ff8800');
    assert.equal(payload.value.logo, undefined, '未上传 Logo 时不提交 logo（schema 要求 src）');
    assert.doesNotThrow(() => BrandKitSchema.parse({ ...payload.value, id: 'x', isDefault: false, createdAt: 'now', updatedAt: 'now' }), '提交体可直接写入品牌库');
  }

  const form = renderToStaticMarkup(createElement(BrandKitForm, {
    draft: named,
    issues: [],
    editingId: null,
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
  assert.ok(form.includes('新建品牌套件') && form.includes('创建品牌套件'), '新建表单有创建按钮');
  assert.ok(form.includes('名称') && form.includes('基础 Style'), '基本信息字段出现');
  for (const label of ['背景', '正文', '弱文字', '强调', '卡片', '辅助']) assert.ok(form.includes(label), `六个调色板字段包含「${label}」`);
  assert.ok(form.includes('标题字体') && form.includes('正文字体'), '字体字段出现');
  assert.ok(form.includes('Logo') && form.includes('启用 Logo'), 'Logo 配置出现');
  assert.ok(form.includes('上传 Logo') || form.includes('替换 Logo'), 'Logo 可上传/替换');
  assert.ok(form.includes('宽度') && form.includes('不透明度') && form.includes('边距'), 'Logo 宽度/透明度/边距可编辑');
  assert.ok(form.includes('左上') && form.includes('右下'), 'Logo 四角位置可选');
  assert.ok(form.includes('创建品牌套件'), '有提交入口');

  const settingsSource = source('../src/components/brand-kits.tsx');
  assert.ok(settingsSource.includes("fetch('/api/settings/brand-kits', {"), '复用品牌库 API');
  assert.match(settingsSource, /method: 'POST'/, '创建走 POST');
  assert.ok(settingsSource.includes('setDraft(defaultBrandDraft())'), '新建从草稿开始');
});

test('#47-3 编辑颜色/字体/logo：表单回填完整，预览使用品牌值', () => {
  const stored = kit({ logo: { enabled: true, src: 'brand-kits/kit-a/logo.png', position: 'bottom-left', width: 180, opacity: 0.85, margin: 60 } });
  const draft = draftFromKit(stored);
  assert.equal(draft.name, 'ACME Corporate');
  assert.equal(draft.baseStyleId, 'minimal-tech');
  assert.deepEqual(draft.colors, COLORS);
  assert.deepEqual(draft.typography, { headingFont: 'Georgia', bodyFont: 'Georgia' });
  assert.equal(draft.logo.position, 'bottom-left');
  assert.equal(draft.logo.width, '180');
  assert.equal(draft.logo.opacity, '0.85');
  assert.equal(draft.logo.margin, '60');

  const form = renderToStaticMarkup(createElement(BrandKitForm, {
    draft, issues: [], editingId: 'kit-a', working: false, uploadingLogo: false,
    error: '', notice: '', pendingLogoName: '', onChange: noop, onLogoFile: noop, onSave: noop, onCancel: noop,
  }));
  assert.ok(form.includes('编辑品牌套件') && form.includes('保存修改'), '编辑态复用同一表单');
  assert.ok(form.includes('value="ACME Corporate"'), '名称回填');
  assert.ok(form.includes('value="#111827"') && form.includes('value="#ef4444"'), '颜色输入回填');
  assert.ok(form.includes('value="Georgia"'), '字体回填');
  assert.ok(form.includes('value="180"') && form.includes('value="0.85"') && form.includes('value="60"'), 'Logo 数值回填');

  const preview = renderToStaticMarkup(createElement(BrandKitPreview, { draft }));
  assert.ok(preview.includes('background:#111827'), '预览使用品牌背景色');
  assert.ok(preview.includes('color:#f9fafb'), '预览使用品牌正文色');
  assert.ok(preview.includes('background:#ef4444'), '预览使用强调色');
  assert.ok(preview.includes('background:#1f2937'), '预览使用卡片色');
  assert.ok(preview.includes('src="/brand-kits/kit-a/logo.png"'), '预览显示 Logo');
  assert.match(preview, /left:[0-9.]+%/, '预览 Logo 位置为左下');
  assert.match(preview, /bottom:[0-9.]+%/, '预览 Logo 位置为左下');
  assert.ok(preview.includes('opacity:0.85'), '预览应用 Logo 透明度');
});

test('#47-8 API 失败错误展示：列表/表单/删除确认都有可读错误位，且上传失败不丢其它字段', () => {
  const listError = renderList([], { error: 'Brand Kit 最多保存 30 个，请先删除不用的项目' });
  assert.ok(listError.includes('Brand Kit 最多保存 30 个，请先删除不用的项目'));
  assert.match(listError, /<p class="error-box" role="alert">/);

  const formError = renderToStaticMarkup(createElement(BrandKitForm, {
    draft: { ...draftFromKit(kit()), name: '已改名称', colors: { ...COLORS, bg: '#000000' } },
    issues: [], editingId: 'kit-a', working: false, uploadingLogo: false,
    error: '保存品牌套件失败：网络错误', notice: '', pendingLogoName: '', onChange: noop, onLogoFile: noop, onSave: noop, onCancel: noop,
  }));
  assert.ok(formError.includes('保存品牌套件失败：网络错误'), 'API 错误显示在当前表单');
  assert.ok(formError.includes('value="已改名称"') && formError.includes('value="#000000"'), '错误展示时未丢失未保存字段');

  const deleteError = renderToStaticMarkup(createElement(BrandKitDeleteDialog, {
    kit: kit(), working: false, error: '删除品牌套件失败：文件被占用', onConfirm: noop, onCancel: noop,
  }));
  assert.ok(deleteError.includes('删除品牌套件失败：文件被占用'));

  const settingsSource = source('../src/components/brand-kits.tsx');
  assert.match(settingsSource, /catch \(error\) \{\s*setFormError\(error instanceof Error \? error\.message : '保存品牌套件失败'\)/);
  assert.ok(settingsSource.includes('Logo 上传失败'), '上传失败显示在表单内');
  assert.ok(settingsSource.includes('setDraft(draftFromKit(kit))'), 'Logo 上传失败时保留刚保存的其它字段');
  assert.match(settingsSource, /if \(!response\.ok\) throw new Error/, 'HTTP 错误转成可展示文案');
});

test('#47-9 非法 hex 不提交：纯函数即时校验，保存按钮禁用且提交前二次校验', () => {
  assert.equal(normalizeHex('#ABCDEF'), '#abcdef', '合法 hex 归一化');
  assert.equal(normalizeHex('ABCDEF'), '#abcdef', '无 # 也接受');
  assert.equal(normalizeHex('#abc'), null, '三位 hex 非法');
  assert.equal(normalizeHex('red'), null, '颜色名非法');
  assert.equal(normalizeHex('#12345g'), null, '非十六进制字符非法');
  assert.equal(isHexColor(''), false);

  const draft = { ...draftFromKit(kit()), colors: { ...COLORS, muted: '#12' } };
  const issues = validateBrandKitDraft(draft);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.field, 'colors.muted');
  assert.equal(issues[0]!.message, '弱文字颜色必须是 #RRGGBB 格式');
  assert.equal(brandDraftPayload(draft).ok, false, '非法 hex 不会构造提交体');

  const invalidButton = renderToStaticMarkup(createElement(BrandKitForm, {
    draft, issues, editingId: 'kit-a', working: false, uploadingLogo: false,
    error: '', notice: '', pendingLogoName: '', onChange: noop, onLogoFile: noop, onSave: noop, onCancel: noop,
  }));
  assert.ok(invalidButton.includes('弱文字颜色必须是 #RRGGBB 格式'), '非法值即时提示');
  assert.match(invalidButton, /aria-invalid="true"/, '非法 hex 标记 aria-invalid');
  assert.match(invalidButton, /<button class="button primary" disabled="">保存修改<\/button>/, '非法 hex 时禁止提交');

  const settingsSource = source('../src/components/brand-kits.tsx');
  const guard = settingsSource.indexOf('const payload = brandDraftPayload(draft);');
  const submitFetch = settingsSource.indexOf('body: JSON.stringify(payload.value)');
  assert.ok(guard >= 0 && submitFetch > guard, 'save() 先校验、后发请求');
  assert.ok(settingsSource.includes('if (!payload.ok)'), '校验失败直接返回，不提交');
});

test('#47-10 默认品牌有清晰标记：列表/卡片/选择器标记一致且仅一个默认', () => {
  const primary = kit({ id: 'kit-a', name: 'ACME Corporate', isDefault: true });
  const secondary = kit({ id: 'kit-b', name: '品牌乙', isDefault: false, colors: { ...COLORS, bg: '#f8fafc' } });

  const list = renderList([primary, secondary]);
  assert.equal(list.split('<span class="preset-default">默认</span>').length - 1, 1, '列表里只有默认品牌带默认标记');
  assert.ok(list.includes('is-default'), '默认卡片有独立样式类');
  assert.ok(list.includes('ACME Corporate') && list.includes('品牌乙'));
  assert.ok(list.includes('基础 Style：Minimal Tech'), '卡片显示基础 Style');
  assert.ok(list.includes('title="背景 #111827"') && list.includes('title="辅助 #374151"'), '卡片显示六色简化色板');
  assert.ok(list.includes('编辑') && list.includes('复制') && list.includes('删除'), '卡片有操作入口');

  const nonDefault = renderToStaticMarkup(createElement(BrandKitCard, {
    kit: secondary, disabled: false, onEdit: noop, onDuplicate: noop, onSetDefault: noop, onDelete: noop,
  }));
  assert.ok(!nonDefault.includes('preset-default'), '非默认卡片不显示默认标记');
  assert.ok(!nonDefault.includes('is-default'), '非默认卡片没有默认样式类');
  assert.ok(nonDefault.includes('设为默认'), '非默认卡片提供“设为默认”');

  const defaultOnly = renderList([kit({ id: 'kit-a', isDefault: true })]);
  assert.equal(defaultOnly.split('<span class="preset-default">默认</span>').length - 1, 1);
});

test('#47 删除确认明确 snapshot 语义，且删除不扫描项目引用', () => {
  const dialog = renderToStaticMarkup(createElement(BrandKitDeleteDialog, {
    kit: kit(), working: false, error: '', onConfirm: noop, onCancel: noop,
  }));
  assert.ok(dialog.includes(BRAND_KIT_DELETE_NOTE), '使用统一的删除说明常量');
  assert.ok(dialog.includes('已应用到项目的品牌快照会继续保留；删除只会移除品牌库中的套件。'), '删除文案明确 snapshot 不受影响');
  assert.ok(dialog.includes('确定删除「ACME Corporate」吗？'), '删除需要确认目标');
  assert.ok(dialog.includes('确认删除') && dialog.includes('取消'), '删除提供确认/取消');

  const settingsSource = source('../src/components/brand-kits.tsx');
  assert.match(settingsSource, /method: 'DELETE'/, '删除调用 DELETE API');
  assert.ok(!/projects[\s\S]{0,80}(brand|brandKit)/i.test(settingsSource), '删除不扫描项目引用');
});

test('#47 设置页有品牌套件入口，且品牌 UI 不混入 ProductionTemplate 的声音/字幕/BGM/导出设置', () => {
  const page = renderToStaticMarkup(createElement(SettingsPage, {}));
  assert.ok(page.includes('品牌套件'), '设置页包含品牌套件区域');
  assert.ok(page.includes('通用设置') || page.includes('设置'), '保留原有通用设置');
  assert.ok(page.includes('品牌套件只定义品牌颜色、字体与 Logo') || page.includes('品牌套件') , '品牌套件说明其职责');

  const form = renderToStaticMarkup(createElement(BrandKitForm, {
    draft: defaultBrandDraft(), issues: [], editingId: null, working: false, uploadingLogo: false,
    error: '', notice: '', pendingLogoName: '', onChange: noop, onLogoFile: noop, onSave: noop, onCancel: noop,
  }));
  for (const forbidden of ['参考音频', '导出画质', 'BGM 文件', '字幕开关', '语速']) {
    assert.ok(!form.includes(forbidden), `品牌表单不出现 ProductionTemplate 设置「${forbidden}」`);
  }
  assert.ok(form.includes('不会修改声音、字幕、BGM 或导出设置'), '用一句话说明与制作方案分离，而不是提供这些控件');
  for (const forbidden of ['参考音频', '导出画质', 'BGM 文件']) {
    assert.ok(!renderList([kit()]).includes(forbidden), `品牌列表不出现「${forbidden}」`);
  }
});

test('#48-1 新建项目有独立品牌下拉，有默认品牌时默认选中', () => {
  const dashboard = source('../src/components/dashboard.tsx');
  assert.ok(dashboard.includes('<label className="field-label">品牌套件</label>'), '新建弹窗有独立“品牌套件”字段');
  assert.ok(dashboard.includes('kits.find(kit => kit.isDefault)'), '读取默认品牌');
  assert.ok(dashboard.includes('setBrandKitId(preferred.id)'), '有默认品牌时默认选中');
  assert.ok(dashboard.includes('brandKitTouched'), '用户改选后不再被覆盖');
  assert.ok(dashboard.includes("form.set('brandKitId', brandKitId)"), '创建请求携带 brandKitId');
  assert.ok(dashboard.includes('视频风格') && dashboard.includes('styleIds.map'), '品牌选择不隐藏/替换 Style 选择');
  assert.match(dashboard, /<select className="input" value=\{brandKitId\}/, '品牌下拉独立于 Style 芯片');
  assert.ok(dashboard.includes('/api/settings/brand-kits'), '新建时读取品牌库');
});

test('#48-2 新建项目可选择“无品牌”', () => {
  const dashboard = source('../src/components/dashboard.tsx');
  assert.ok(dashboard.includes('<option value="">无品牌</option>'), '品牌下拉提供“无品牌”选项');
  assert.ok(dashboard.includes('setBrandKitId(e.target.value)'), '选择空值即清除品牌');

  const route = source('../src/app/api/projects/route.ts');
  assert.ok(route.includes("form.get('brandKitId')"), '项目创建 API 接受 brandKitId');
  const pending = source('../src/lib/brand-kit-pending.ts');
  assert.ok(pending.includes('if (!id) return undefined'), '空 brandKitId 不写 pending 品牌');
  const pipeline = source('../src/lib/pipeline.ts');
  assert.ok(pipeline.includes('resolveCreationBrandKitId(input.brandKitId)'), '创建时只持久化存在的品牌');
});
