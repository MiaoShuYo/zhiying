import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandKitSchema, type BrandKit } from '@m2v/schema';
import { BrandKitChangeDialog, BrandKitPicker, ProjectBrandBar } from '../src/components/brand-kit-picker';
import { BRAND_CHANGE_KEEPS, BRAND_CHANGE_UPDATES } from '../src/lib/brand-kit-ui';

/**
 * V1.6.7 #48 独立测试（tester）：项目编辑器的品牌显示、更换/重新应用/移除、
 * 切换确认影响范围、来源套件已删除、锁定态，以及编辑器/新建流程的接线形状。
 */

const noop = () => {};
const COLORS = { bg: '#111827', fg: '#f9fafb', muted: '#9ca3af', accent: '#ef4444', card: '#1f2937', secondary: '#374151' };
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

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

const renderBar = (patch: Partial<Parameters<typeof ProjectBrandBar>[0]> = {}) => renderToStaticMarkup(createElement(ProjectBrandBar, {
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
  ...patch,
}));

test('#48-4 项目级品牌区域显示当前品牌，并提供更换/重新应用/移除', () => {
  const bar = renderBar();
  assert.ok(bar.includes('品牌：') && bar.includes('<b>ACME Corporate</b>'), '显示当前项目品牌名');
  assert.ok(bar.includes('title="背景 #111827"'), '显示当前品牌简化色板');
  assert.ok(bar.includes('更换') && bar.includes('重新应用') && bar.includes('移除'), '三个操作入口都存在');
  assert.ok(bar.includes('aria-label="项目品牌套件"'), '品牌区域语义明确');
  assert.match(bar, /<button class="button subtle"[^>]*>更换<\/button>/, '更换按钮可用');
  assert.match(bar, /<button class="button subtle"[^>]*>(重新应用|应用中…)<\/button>/, '重新应用按钮始终可见（MVP 不强制差异检测）');
  assert.match(bar, /<button class="text-button"[^>]*>移除<\/button>/, '移除按钮可用');
  assert.ok(!bar.includes('role="alert"') && !bar.includes('role="status"'), '无错误/提示时不显示多余状态');
});

test('#48-5 重新应用同一品牌：按钮把当前 brandKitId 再提交一次，库更新后刷新快照', () => {
  const editor = source('../src/components/project-editor.tsx');
  assert.ok(editor.includes('onReapply={() => { const id = currentBrandKitId; if (id) void changeBrandKit(id); }}'), '重新应用复用当前 brandKitId');
  assert.ok(editor.includes("fetch(`/api/projects/${data.id}/brand-kit`"), '调用项目品牌 API');
  assert.match(editor, /body: JSON\.stringify\(\{ brandKitId: kitId \}\)/, 'POST 提交 brandKitId');
  assert.ok(editor.includes("'if-match': String(revisionRef.current)"), '携带 revision 防止并发覆盖');
  assert.ok(editor.includes('adoptBrandStoryboard(result.storyboard, result.revision)'), '采纳 API 返回的新快照与 revision');
  assert.ok(editor.includes("setBrandKitNotice('品牌快照已更新，预览立即使用新视觉；旁白、配音、字幕时间与场景时长未改变。')"), '明确提示预览立即变化且内容不变');
  assert.ok(editor.includes('persistBoard') && editor.includes('分镜保存失败，请先保存再切换品牌'), '切换前先落库未保存分镜');
});

test('#48-6 移除品牌：DELETE 调用并恢复项目自身 Style，不触碰内容', () => {
  const bar = renderBar();
  assert.ok(bar.includes('移除'));
  const editor = source('../src/components/project-editor.tsx');
  assert.ok(editor.includes('removeProjectBrand'), '有移除处理函数');
  assert.match(editor, /method: 'DELETE'/, '移除使用 DELETE');
  assert.ok(editor.includes("setBrandKitNotice('已移除项目品牌，项目回到自身 Style；旁白、配音、字幕时间与场景时长未改变。')"));
  const dialog = renderToStaticMarkup(createElement(BrandKitChangeDialog, {
    kind: 'remove', kitName: 'ACME Corporate', working: false, error: '', onConfirm: noop, onCancel: noop,
  }));
  assert.ok(dialog.includes('移除项目品牌套件'), '移除有确认对话框');
  assert.ok(dialog.includes('确认移除'), '移除需要确认');
  assert.ok(dialog.includes('将移除') && dialog.includes('不会修改'), '移除也列出影响范围');
});

test('#48-4 切换确认明确列出“将更新 / 不会修改”的完整范围', () => {
  const dialog = renderToStaticMarkup(createElement(BrandKitChangeDialog, {
    kind: 'apply', kitName: 'ACME Corporate', working: false, error: '', onConfirm: noop, onCancel: noop,
  }));
  assert.ok(dialog.includes('切换品牌套件：ACME Corporate'), '确认框点名目标品牌');
  assert.ok(dialog.includes('将更新') && dialog.includes('不会修改'), '两栏影响说明');
  for (const update of ['品牌颜色', '标题/正文字体', 'Logo']) {
    assert.ok(BRAND_CHANGE_UPDATES.includes(update as (typeof BRAND_CHANGE_UPDATES)[number]), `常量包含「${update}」`);
    assert.ok(dialog.includes(update), `确认框包含「${update}」`);
  }
  for (const keep of ['旁白', '分镜内容', '配音', '语速/停顿', '字幕时间', '场景时长', '制作方案']) {
    assert.ok(BRAND_CHANGE_KEEPS.includes(keep as (typeof BRAND_CHANGE_KEEPS)[number]), `常量包含「${keep}」`);
    assert.ok(dialog.includes(keep), `不会修改包含「${keep}」`);
  }
  assert.ok(dialog.includes('不会调用 Qwen、重新生成 TTS、清空音频缓存或改动字幕时间'), '说明不触发 LLM/TTS/不改时间');
  assert.ok(dialog.includes('确认切换') && dialog.includes('取消'), '提供确认/取消');
});

test('#48-7 来源套件已删除：显示“来源套件已删除”，仍可更换/移除且不影响打开项目', () => {
  const staleBar = renderBar({ stale: true });
  assert.ok(staleBar.includes('（来源套件已删除）'), '明确标注来源已删除');
  assert.ok(staleBar.includes('项目仍使用保存时的品牌快照'), '说明项目继续使用快照');
  assert.ok(staleBar.includes('更换') && staleBar.includes('移除'), '允许更换为其它品牌或移除');
  assert.ok(!staleBar.includes('重新应用'), '来源不存在时不显示无法执行的重新应用');
  assert.ok(!staleBar.includes('disabled=""'), '来源删除不锁定项目');

  const editor = source('../src/components/project-editor.tsx');
  assert.ok(editor.includes('brandStale'), '项目编辑器计算 stale 状态');
  assert.ok(editor.includes('brandKits !== null') && editor.includes('!currentBrandKit'), '用品牌库是否包含来源套件判断 stale');
  assert.ok(editor.includes('currentProjectBrand?.name ?? currentBrandKit?.name'), 'stale 时仍显示快照品牌名');
});

test('#48-9 锁定/忙碌态：品牌按钮禁用并说明原因，API 错误在品牌区域展示', () => {
  const locked = renderBar({ disabled: true });
  assert.ok(locked.includes('项目正在执行任务或保存中，品牌切换暂不可用。'), '禁用时说明原因');
  for (const label of ['更换', '重新应用', '移除']) {
    assert.match(locked, new RegExp(`<button[^>]*disabled=""[^>]*>${label}<\\/button>`), `锁定态「${label}」按钮 disabled`);
  }
  const working = renderBar({ disabled: true, working: true });
  assert.ok(working.includes('应用中…'), '执行中显示进行态');
  assert.ok(!working.includes('品牌切换暂不可用'), '执行中不重复提示不可用');

  const failed = renderBar({ disabled: false, error: '项目正在执行渲染任务，请稍后再试' });
  assert.match(failed, /<p class="brand-project-error" role="alert">/, '品牌操作错误用 alert 展示');
  assert.ok(failed.includes('项目正在执行渲染任务，请稍后再试'));
  const noticed = renderBar({ notice: '品牌快照已更新' });
  assert.match(noticed, /role="status"/, '成功提示用 status 展示');

  const editor = source('../src/components/project-editor.tsx');
  assert.ok(editor.includes('disabled={isBusy || brandWorking}'), '忙碌/锁定态禁用品牌操作');
  assert.ok(editor.includes("setBrandKitError(error instanceof Error ? error.message : '切换品牌失败')"), 'API 失败信息进入品牌区域');
  assert.ok(editor.includes('if (isBusy || brandWorking) return;'), '锁定/忙碌时直接拒绝品牌切换');
  assert.ok(editor.includes("['created', 'extracting', 'analyzing', 'storyboarding', 'generating_audio', 'rendering', 'encoding']"), '执行中的项目状态让 isBusy 为真');
});

test('#48-4 选择器列出 Logo/名称/简化色板/base style/默认标记，并标记当前品牌', () => {
  const picker = renderToStaticMarkup(createElement(BrandKitPicker, {
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
  assert.ok(picker.includes('选择品牌套件'), '选择器标题');
  assert.ok(picker.includes('品牌只影响颜色、字体与 Logo'), '说明品牌影响范围');
  assert.ok(picker.includes('ACME Corporate') && picker.includes('品牌乙'), '列出全部品牌');
  assert.ok(picker.includes('src="/brand-kits/kit-a/logo.png"'), '列表显示 Logo');
  assert.ok(picker.includes('title="强调 #ef4444"'), '列表显示简化色板');
  assert.ok(picker.includes('基础 Style：Minimal Tech') && picker.includes('基础 Style：Academic'), '显示 base style');
  assert.ok(picker.includes('默认'), '标记默认品牌');
  assert.ok(picker.includes('当前'), '标记当前项目品牌');
  assert.ok(picker.includes('aria-pressed="true"'), '当前项可访问性状态');

  const empty = renderToStaticMarkup(createElement(BrandKitPicker, {
    kits: [], currentKitId: undefined, loading: false, disabled: false, error: '', onSelect: noop, onClose: noop,
  }));
  assert.ok(empty.includes('还没有品牌套件'), '空库给出创建引导');

  const loading = renderToStaticMarkup(createElement(BrandKitPicker, {
    kits: [], loading: true, disabled: false, error: '', onSelect: noop, onClose: noop,
  }));
  assert.ok(loading.includes('正在读取品牌套件'));
});

test('#48 项目编辑器接入品牌区域/选择器/确认框，preflight 修复可跳到品牌设置', () => {
  const editor = source('../src/components/project-editor.tsx');
  assert.ok(editor.includes('<ProjectBrandBar'), '故事板存在时渲染项目级品牌区域');
  assert.ok(editor.includes('brandPickerOpen && <BrandKitPicker'), '更换时打开品牌选择器');
  assert.ok(editor.includes('brandConfirm && <BrandKitChangeDialog'), '切换/移除前弹确认');
  assert.ok(editor.includes("window.location.assign('/settings#brand-kits')"), 'preflight open_brand_settings 跳到品牌套件');
  assert.ok(editor.includes("String(issue.fix) === 'open_brand_settings'"), '按 fix 值跳转');
  assert.ok(!editor.includes('brand-kits/logo'), '项目编辑器不编辑品牌内容/不重复上传 Logo');
  assert.ok(!/setStyleId\s*\(/.test(editor), '品牌切换不修改项目 styleId');
});
