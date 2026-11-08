import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrandLogoSchema,
  CAPTION_RESERVED_LINES,
  SceneSchema,
  StoryboardSchema,
  SubtitleSchema,
  brandLogoHeightEstimateRatio,
  brandLogoPlacement,
  brandLogoSizeWarnRatio,
  captionCharLimit,
  captionSafeArea,
  designCanvas,
  preflight,
  preflightCategoryOf,
  preflightCodeLabels,
  preflightFixLabels,
  preflightGaps,
  rendererScale,
  type PreflightResult,
  type Storyboard,
} from '../src/index';

/**
 * V1.6.7 #49 独立测试（tester）。
 *
 * `preflight-brand.test.ts` 由 preflight-dev 提供；本文件不复用它的用例，而是把
 * renderer 的共享几何（designCanvas / brandLogoPlacement / captionSafeArea）当作独立
 * oracle：按“字幕实际行数是否超过 renderer 预留的 2 行安全区”重新推导预期结论，
 * 逐格核对 preflight 的 finding 是否与几何一致，防止实现与 renderer 规则漂移。
 */

const LOGO_SRC = 'brand-kits/acme/logo.png';
const COLORS = { bg: '#080d19', fg: '#f3f7ff', muted: '#9aaac2', accent: '#50e3c2', card: '#111b2c', secondary: '#182741' };
const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

let sceneCounter = 0;
const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({
  id: `scene-${(sceneCounter += 1)}`,
  type: 'title',
  narration: '旁白内容。',
  visual: {},
  duration: 6,
  audioSrc: 'audio/a.wav',
  audioDuration: 6,
  ...patch,
});
const brand = (logo?: Record<string, unknown>) => ({
  name: '测试品牌',
  baseStyleId: 'minimal-tech',
  colors: { ...COLORS },
  typography: { headingFont: 'Arial', bodyFont: 'Arial' },
  ...(logo ? { logo } : {}),
});
const logo = (patch: Record<string, unknown> = {}) => BrandLogoSchema.parse({ src: LOGO_SRC, enabled: true, ...patch });
const board = (scenes: Record<string, unknown>[], patch: Record<string, unknown> = {}): Storyboard => StoryboardSchema.parse({
  title: '例子', styleId: 'minimal-tech', scenes, ...patch,
});
const codes = (result: PreflightResult) => result.issues.map(issue => issue.code);
const brandIssues = (result: PreflightResult) => result.issues.filter(issue => issue.code.startsWith('brand_'));
const cueLines = (lines: number, portrait: boolean, fontSize: number) => {
  // CJK-only text: display width equals character count, one cue therefore wraps into exactly
  // `lines` renderer lines at the caption QC limit the renderer/preflight both use.
  const limit = captionCharLimit(portrait, fontSize);
  return { text: '字'.repeat(limit * lines), start: 0, end: 2 };
};

/** Independent oracle: a same-edge Logo only conflicts when the caption band outgrows the reserved lines. */
function sameEdgeConflictExpected(lines: number): boolean {
  return lines > CAPTION_RESERVED_LINES;
}

test('#49-4/#49-5 同侧 Logo 只在字幕实际行数超过 renderer 预留 2 行时提示冲突（几何 oracle 全矩阵）', () => {
  let checked = 0;
  for (const portrait of [false, true]) {
    const canvas = designCanvas(portrait);
    for (const position of POSITIONS) {
      const sameSide = position.startsWith('top') ? 'top' : 'bottom';
      for (const fontSize of [30, 72]) {
        for (const lines of [1, 2, 3]) {
          for (const subtitlePatch of [{ position: sameSide }, { position: sameSide === 'top' ? 'bottom' : 'top' }, { position: 'center' }, { enabled: false, position: sameSide }]) {
            const subtitles = { enabled: true, fontSize, ...subtitlePatch };
            const storyboard = board([scene({ subtitleCues: [cueLines(lines, portrait, fontSize)] })], {
              aspectRatio: portrait ? '9:16' : '16:9',
              brand: brand(logo({ position, width: 160, margin: 40, enabled: true })),
              subtitles,
            });
            const result = preflight(storyboard, [], { exists: () => true });
            const settings = SubtitleSchema.parse(subtitles);
            const placement = brandLogoPlacement({
              logo: storyboard.brand!.logo,
              subtitles: storyboard.subtitles,
              videoWidth: canvas.width,
              videoHeight: canvas.height,
            });
            assert.ok(placement);
            const sharesEdge = settings.enabled && settings.position === placement.verticalEdge;
            const expected = sharesEdge && sameEdgeConflictExpected(lines);
            const actual = result.issues.some(issue => issue.code === 'brand_logo_caption_conflict');
            assert.equal(
              actual,
              expected,
              `portrait=${portrait} ${position} fontSize=${fontSize} lines=${lines} subtitles=${settings.position}/${settings.enabled}：预期冲突=${expected}，实际=${actual}`,
            );
            if (actual) {
              const issue = result.issues.find(item => item.code === 'brand_logo_caption_conflict')!;
              assert.equal(issue.severity, 'warning');
              assert.equal(issue.sceneIndex, undefined, '品牌冲突是项目级 finding');
              assert.equal(issue.fix, 'open_brand_settings');
              assert.equal(preflightCategoryOf(issue), 'subtitle');
              assert.match(issue.message, new RegExp(`字幕实际需要 ${lines} 行`));
              assert.match(issue.message, /可能.*重叠|显示不全/);
              assert.equal(result.blocking, 0, 'Logo/字幕冲突不阻断导出');
            }
            checked += 1;
          }
        }
      }
    }
  }
  assert.ok(checked >= 64, `矩阵至少覆盖 64 种组合，实际 ${checked}`);
});

test('#49-5 几何护栏：schema 允许的 width/margin/fontSize 不会把 Logo 顶出画面，冲突规则必须只依赖字幕行数', () => {
  for (const portrait of [false, true]) {
    const canvas = designCanvas(portrait);
    const scale = rendererScale(canvas.width, canvas.height);
    for (const position of POSITIONS) {
      for (const fontSize of [18, 30, 72]) {
        for (const width of [40, 160, 500]) {
          for (const margin of [0, 40, 200]) {
            const placement = brandLogoPlacement({
              logo: logo({ position, width, margin }),
              subtitles: SubtitleSchema.parse({ enabled: true, position: position.startsWith('top') ? 'top' : 'bottom', fontSize }),
              videoWidth: canvas.width,
              videoHeight: canvas.height,
            });
            assert.ok(placement);
            const estimatedHeight = placement.width * brandLogoHeightEstimateRatio;
            assert.ok(
              placement.verticalOffset + estimatedHeight <= canvas.height,
              `portrait=${portrait} ${position} fontSize=${fontSize} width=${width} margin=${margin} 不应超出画面`,
            );
            // Same-edge lift is always the larger of the plain margin and the 2-line safe area.
            const settings = SubtitleSchema.parse({ enabled: true, position: position.startsWith('top') ? 'top' : 'bottom', fontSize });
            const band = captionSafeArea({ videoHeight: canvas.height, fontSize, scale });
            assert.ok(placement.verticalOffset >= Math.max(margin * scale, band.total - 1e-9) - 1e-9);
          }
        }
      }
    }
  }
});

test('#49-6 9:16 超大 Logo 的阈值来自设计画布 30%，与导出分辨率无关', () => {
  const portraitCanvas = designCanvas(true);
  const threshold = portraitCanvas.width * brandLogoSizeWarnRatio;
  assert.equal(brandLogoSizeWarnRatio, 0.3);
  for (const width of [40, threshold - 1, threshold, threshold + 1, 400, 500]) {
    const result = preflight(
      board([scene()], { aspectRatio: '9:16', brand: brand(logo({ width, position: 'top-right' })) }),
      [],
      { exists: () => true },
    );
    const warned = result.issues.some(issue => issue.code === 'brand_logo_too_large');
    assert.equal(warned, width > threshold, `竖屏 width=${width} 预期尺寸告警=${width > threshold}`);
    if (warned) {
      const issue = result.issues.find(item => item.code === 'brand_logo_too_large')!;
      assert.equal(issue.severity, 'warning');
      assert.equal(issue.sceneIndex, undefined);
      assert.equal(issue.fix, 'open_brand_settings');
      assert.equal(preflightCategoryOf(issue), 'render');
      assert.match(issue.message, /竖屏/);
      assert.match(issue.message, /超过 30%/);
      assert.equal(result.blocking, 0);
    }
  }
  // Landscape 1920 design width: the schema's 500px cap is ~26%, so the size check must not fire.
  const landscape = preflight(
    board([scene()], { brand: brand(logo({ width: 500, position: 'bottom-left' })) }),
    [],
    { exists: () => true },
  );
  assert.equal(landscape.issues.some(issue => issue.code === 'brand_logo_too_large'), false);
  assert.deepEqual(codes(landscape), []);
});

test('#49-1/#49-2/#49-3 Logo 存在/缺失/禁用/无 Logo 的 finding 语义', () => {
  const existing = preflight(board([scene()], { brand: brand(logo()) }), [], { exists: () => true });
  assert.deepEqual(codes(existing), [], '文件存在的干净项目没有任何 finding');

  const missing = preflight(board([scene()], { brand: brand(logo()) }), [], { exists: path => path !== LOGO_SRC });
  assert.equal(missing.issues.length, 1, '缺失 Logo 只产生 1 条项目级 finding');
  const issue = missing.issues[0]!;
  assert.equal(issue.code, 'missing_file');
  assert.equal(issue.severity, 'warning');
  assert.equal(issue.assetPath, LOGO_SRC);
  assert.equal(issue.assetKind, 'image');
  assert.equal(issue.fix, 'open_brand_settings');
  assert.equal(issue.sceneIndex, undefined);
  assert.equal(missing.blocking, 0, '缺失 Logo 不阻断正式导出');
  assert.match(issue.message, /品牌 Logo 文件不存在/);
  assert.ok(issue.message.includes(LOGO_SRC));
  assert.match(issue.message, /打开品牌套件设置/);

  const disabled = preflight(board([scene()], { brand: brand(logo({ enabled: false })) }), [], { exists: () => false });
  assert.deepEqual(brandIssues(disabled), [], '禁用 Logo 不做文件/尺寸/冲突检查');
  assert.equal(disabled.issues.some(item => item.assetPath === LOGO_SRC), false);

  const withoutLogo = preflight(board([scene()], { brand: brand() }), [], { exists: () => true });
  assert.deepEqual(brandIssues(withoutLogo), [], '品牌快照没有 Logo 时不做任何品牌检查');
  assert.equal(withoutLogo.issues.length, 0);
});

test('#49-7 多 scene 的品牌问题按项目级去重（缺文件/冲突/超大各只 1 条）', () => {
  const longCue = cueLines(3, false, 30);
  const scenes = [scene(), scene({ subtitleCues: [longCue] }), scene({ id: 'third', subtitleCues: [longCue] })];

  const missing = preflight(
    board(scenes, { brand: brand(logo()) }),
    [],
    { exists: path => path !== LOGO_SRC },
  );
  assert.equal(missing.issues.filter(item => item.code === 'missing_file').length, 1);
  assert.equal(preflightGaps(missing).filter(gap => gap.path === LOGO_SRC).length, 1, '缺失清单里 Logo 只占一行');

  const conflict = preflight(
    board(scenes, { brand: brand(logo({ position: 'bottom-right' })), subtitles: { enabled: true, position: 'bottom', fontSize: 30 } }),
    [],
    { exists: () => true },
  );
  assert.equal(conflict.issues.filter(item => item.code === 'brand_logo_caption_conflict').length, 1, '多个长字幕场景仍只报 1 条同侧冲突');
  assert.equal(conflict.issues.find(item => item.code === 'brand_logo_caption_conflict')!.sceneIndex, undefined);

  const portraitScenes = [scene(), scene({ id: 'b' }), scene({ id: 'c' })];
  const oversized = preflight(
    board(portraitScenes, { aspectRatio: '9:16', brand: brand(logo({ width: 400 })) }),
    [],
    { exists: () => true },
  );
  assert.equal(oversized.issues.filter(item => item.code === 'brand_logo_too_large').length, 1, '尺寸问题也是项目级');
});

test('#49 新增 code/fix 的 label 与分类齐全，且可被 URL 面板使用', () => {
  assert.equal(preflightFixLabels.open_brand_settings, '打开品牌套件');
  assert.equal(preflightCodeLabels.brand_logo_caption_conflict, '品牌 Logo 与字幕冲突');
  assert.equal(preflightCodeLabels.brand_logo_too_large, '品牌 Logo 尺寸过大');

  const conflict = preflight(
    board([scene({ subtitleCues: [cueLines(3, false, 30)] })], {
      brand: brand(logo({ position: 'bottom-left' })),
      subtitles: { enabled: true, position: 'bottom', fontSize: 30 },
    }),
    [],
    { exists: () => true },
  );
  const conflictIssue = conflict.issues.find(item => item.code === 'brand_logo_caption_conflict')!;
  assert.equal(preflightCategoryOf(conflictIssue), 'subtitle', '同侧冲突归入字幕分类');
  assert.equal(preflightFixLabels[conflictIssue.fix], '打开品牌套件', '面板按钮文案可直接使用');
});

test('#49 无 Brand 项目的 preflight 结果完全保持原样（含仅有 brandKitId 的 pending 项目）', () => {
  const scenes = [scene({ audioDuration: 2, duration: 2 })];
  const plain = preflight(board(scenes, { subtitles: { enabled: false } }), [], { exists: () => true });
  assert.deepEqual(codes(plain), ['scene_too_short', 'subtitles_off']);
  assert.equal(plain.blocking, 0);
  assert.equal(brandIssues(plain).length, 0);
  assert.equal(preflightGaps(plain).length, 0);

  const pendingOnly = preflight(board(scenes, { brandKitId: 'acme', subtitles: { enabled: false } }), [], { exists: () => true });
  assert.deepEqual(pendingOnly, plain, '只有 pending brandKitId、没有快照时行为不变');

  const longCue = cueLines(3, false, 30);
  const mixed = preflight(
    board([scene({ subtitleCues: [longCue] })], { subtitles: { enabled: true, position: 'bottom', fontSize: 30 } }),
    [],
    { exists: () => true },
  );
  assert.equal(mixed.issues.some(item => item.code.startsWith('brand_')), false, '没有品牌快照时不会出现品牌 finding');
  assert.ok(mixed.issues.some(item => item.code === 'caption_overflow'), '既有字幕检查不受影响');
});
