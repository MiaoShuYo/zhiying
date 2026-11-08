import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SceneSchema,
  StoryboardSchema,
  brandLogoSizeWarnRatio,
  preflight,
  preflightCategories,
  preflightCategoryOf,
  preflightCodeLabels,
  preflightFixLabels,
  preflightGaps,
} from '../src/index';

const LOGO_SRC = 'projects/p/assets/brand-logos/acme.png';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({
  id: 'a', type: 'title', narration: '第一句。第二句。', visual: {}, duration: 6, audioSrc: 'audio/a.wav', audioDuration: 6, ...patch,
});
const subtitles = (patch: Record<string, unknown> = {}) => ({ enabled: true, position: 'bottom', fontSize: 30, ...patch });
const brandSnapshot = (logo?: Record<string, unknown>) => ({
  name: '测试品牌',
  baseStyleId: 'minimal-tech',
  colors: { bg: '#080d19', fg: '#f3f7ff', muted: '#9aaac2', accent: '#50e3c2', card: '#111b2c', secondary: '#182741' },
  typography: { headingFont: 'Arial', bodyFont: 'Arial' },
  ...(logo ? { logo } : {}),
});
const board = (scenes: Record<string, unknown>[], patch: Record<string, unknown> = {}) => StoryboardSchema.parse({
  title: '例子', styleId: 'minimal-tech', scenes, ...patch,
});
const logo = (patch: Record<string, unknown> = {}) => ({ src: LOGO_SRC, enabled: true, ...patch });
const codes = (result: ReturnType<typeof preflight>) => result.issues.map(issue => issue.code);
const brandIssues = (result: ReturnType<typeof preflight>) => result.issues.filter(issue => issue.code.startsWith('brand_'));
const existsExcept = (...missing: string[]) => (path: string) => !missing.includes(path);

test('#49-1 文件存在的启用 Logo 不产生 missing finding', () => {
  const storyboard = board([scene()], { brand: brandSnapshot(logo()) });
  const result = preflight(storyboard, [], { exists: () => true });

  assert.equal(result.issues.some(issue => issue.assetPath === LOGO_SRC), false);
  assert.deepEqual(codes(result), [], 'a present Logo on a clean landscape project adds no issue');
});

test('#49-2 文件缺失时恰好 1 条项目级 warning，且不阻断导出', () => {
  const storyboard = board([scene()], { brand: brandSnapshot(logo()) });
  const result = preflight(storyboard, [], { exists: existsExcept(LOGO_SRC) });

  const missing = result.issues.filter(issue => issue.code === 'missing_file');
  assert.equal(missing.length, 1, 'one Logo file, one finding');
  assert.equal(result.issues.length, 1, 'a missing Logo is the only problem of this project');
  const issue = missing[0];
  assert.equal(issue.severity, 'warning');
  assert.equal(issue.assetKind, 'image');
  assert.equal(issue.fix, 'open_brand_settings');
  assert.equal(preflightFixLabels.open_brand_settings, '打开品牌套件');
  assert.equal(result.blocking, 0, 'a missing Logo must not block the export');
  assert.match(issue.message, /品牌 Logo 文件不存在/);
  assert.match(issue.message, new RegExp(LOGO_SRC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(issue.message, /打开品牌套件设置重新上传 Logo/);

  // The existing "missing files" checklist keeps listing it as an image asset gap.
  assert.equal(preflightCategoryOf(issue), 'asset');
  const gaps = preflightGaps(result).filter(gap => gap.path === LOGO_SRC);
  assert.equal(gaps.length, 1, 'the Logo gap stays a single checklist row');
  assert.equal(gaps[0].kind, 'image');
  assert.equal(gaps[0].fix, 'open_brand_settings', 'the fix button now opens the brand kit settings');
});

test('#49-3 disabled Logo 不检查文件，也不产生尺寸/冲突检查', () => {
  const storyboard = board([scene()], {
    aspectRatio: '9:16',
    brand: brandSnapshot(logo({ enabled: false, width: 500, position: 'bottom-right', margin: 200 })),
    subtitles: subtitles(),
  });
  const result = preflight(storyboard, [], { exists: () => false });

  assert.equal(result.issues.some(issue => issue.assetPath === LOGO_SRC), false, 'a disabled Logo is never checked');
  assert.equal(brandIssues(result).length, 0, 'no brand finding at all for a disabled Logo');
  assert.ok(result.issues.every(issue => issue.code !== 'brand_logo_too_large' && issue.code !== 'brand_logo_caption_conflict'));
});

test('#49-3 无 Logo 的品牌快照不产生任何品牌 finding', () => {
  const storyboard = board([scene()], { aspectRatio: '9:16', brand: brandSnapshot() });
  const result = preflight(storyboard, [], { exists: () => false });
  assert.equal(brandIssues(result).length, 0);
  assert.equal(result.issues.some(issue => issue.assetPath === LOGO_SRC), false);
});

test('#49-4 bottom Logo + bottom 字幕、布局安全时不误报', () => {
  const storyboard = board([scene()], {
    brand: brandSnapshot(logo({ position: 'bottom-right', width: 200, margin: 40 })),
    subtitles: subtitles(),
  });
  const result = preflight(storyboard, [], { exists: () => true });

  assert.equal(result.issues.some(issue => issue.code === 'brand_logo_caption_conflict'), false, 'renderer lift is enough for 2-line captions');
  assert.deepEqual(codes(result), []);

  // Exactly the renderer's 2-line reservation is still safe (strictly more lines is what starts to
  // grow back into the Logo band), and the same-side rule holds on the portrait canvas too.
  const twoLines = { text: '字'.repeat(100), start: 0, end: 2 };
  const boundary = preflight(
    board([scene({ subtitleCues: [twoLines] })], { brand: brandSnapshot(logo({ position: 'bottom-left' })), subtitles: subtitles() }),
    [],
    { exists: () => true },
  );
  assert.equal(boundary.issues.some(issue => issue.code === 'brand_logo_caption_conflict'), false, '2 reserved caption lines are safe');

  const portrait = preflight(
    board([scene()], { aspectRatio: '9:16', brand: brandSnapshot(logo({ position: 'bottom-right', width: 200 })), subtitles: subtitles() }),
    [],
    { exists: () => true },
  );
  assert.equal(portrait.issues.some(issue => issue.code === 'brand_logo_caption_conflict'), false, 'portrait safe area is larger and still safe');
  assert.deepEqual(codes(portrait), []);
});

test('#49-4 对侧字幕、居中字幕与关闭字幕都不做同侧检查', () => {
  const longCue = { text: '字幕'.repeat(60), start: 0, end: 2 };
  const cases: { name: string; subtitlePatch: Record<string, unknown> }[] = [
    { name: 'opposite edge', subtitlePatch: { position: 'top' } },
    { name: 'center', subtitlePatch: { position: 'center' } },
    { name: 'disabled', subtitlePatch: { enabled: false, position: 'bottom' } },
  ];
  for (const entry of cases) {
    const result = preflight(
      board([scene({ subtitleCues: [longCue] })], {
        brand: brandSnapshot(logo({ position: 'bottom-right' })),
        subtitles: subtitles(entry.subtitlePatch),
      }),
      [],
      { exists: () => true },
    );
    assert.equal(result.issues.some(issue => issue.code === 'brand_logo_caption_conflict'), false, `${entry.name} captions never conflict with a bottom Logo`);
  }
});

test('#49-5 字幕行数超出 Logo 避让预留安全区时给出项目级 warning', () => {
  const longCue = { text: '字幕'.repeat(60), start: 0, end: 2 };
  const storyboard = board([scene({ subtitleCues: [longCue] })], {
    brand: brandSnapshot(logo({ position: 'bottom-right', margin: 40 })),
    subtitles: subtitles(),
  });
  const result = preflight(storyboard, [], { exists: () => true });

  const conflicts = result.issues.filter(issue => issue.code === 'brand_logo_caption_conflict');
  assert.equal(conflicts.length, 1);
  const issue = conflicts[0];
  assert.equal(issue.severity, 'warning');
  assert.equal(result.blocking, 0);
  assert.equal(issue.sceneIndex, undefined, 'the finding is project level');
  assert.equal(issue.fix, 'open_brand_settings');
  assert.equal(preflightCodeLabels.brand_logo_caption_conflict, '品牌 Logo 与字幕冲突');
  assert.equal(preflightCategoryOf(issue), 'subtitle');
  assert.match(issue.message, /品牌 Logo 与底部字幕同侧/);
  assert.match(issue.message, /超过 Logo 避让预留的 2 行安全区/);
  assert.ok(preflightCategories.includes('subtitle'));

  // Top captions are symmetric.
  const top = preflight(
    board([scene({ subtitleCues: [longCue] })], {
      brand: brandSnapshot(logo({ position: 'top-left', margin: 40 })),
      subtitles: subtitles({ position: 'top' }),
    }),
    [],
    { exists: () => true },
  );
  assert.equal(top.issues.some(item => item.code === 'brand_logo_caption_conflict'), true, 'top Logo + top captions use the same rule');
});

test('#49-6 9:16 超大 Logo 给出 size warning，横屏不受 500 上限影响', () => {
  const oversized = board([scene()], {
    aspectRatio: '9:16',
    brand: brandSnapshot(logo({ width: 400 })),
  });
  const result = preflight(oversized, [], { exists: () => true });
  const sizes = result.issues.filter(issue => issue.code === 'brand_logo_too_large');
  assert.equal(sizes.length, 1);
  const issue = sizes[0];
  assert.equal(issue.severity, 'warning');
  assert.equal(issue.sceneIndex, undefined, 'the finding is project level');
  assert.equal(issue.fix, 'open_brand_settings');
  assert.equal(preflightCodeLabels.brand_logo_too_large, '品牌 Logo 尺寸过大');
  assert.equal(preflightCategoryOf(issue), 'render');
  assert.match(issue.message, /竖屏/);
  assert.match(issue.message, /超过 30%/);

  // Threshold is design-canvas based: 1080 * 0.3 = 324, and only values strictly above warn.
  assert.equal(brandLogoSizeWarnRatio, 0.3);
  const boundary = preflight(
    board([scene()], { aspectRatio: '9:16', brand: brandSnapshot(logo({ width: 1080 * brandLogoSizeWarnRatio })) }),
    [],
    { exists: () => true },
  );
  assert.equal(boundary.issues.some(item => item.code === 'brand_logo_too_large'), false, 'exactly 30% is still accepted');

  // 500px is the schema cap; on the 1920px landscape canvas it is only ~26% and must not warn.
  const landscape = preflight(
    board([scene()], { brand: brandSnapshot(logo({ width: 500, position: 'top-right' })) }),
    [],
    { exists: () => true },
  );
  assert.equal(landscape.issues.some(item => item.code === 'brand_logo_too_large'), false, 'landscape never trips the 500 cap');
  assert.deepEqual(codes(landscape), []);
});

test('#49-7 多 scene 时同一品牌问题只出现一次', () => {
  const longCue = { text: '字幕'.repeat(60), start: 0, end: 2 };
  const scenes = [
    scene({ id: 'a' }),
    scene({ id: 'b', subtitleCues: [longCue] }),
    scene({ id: 'c', subtitleCues: [longCue] }),
  ];

  const missing = preflight(
    board(scenes, { brand: brandSnapshot(logo()) }),
    [],
    { exists: path => path !== LOGO_SRC },
  );
  assert.equal(missing.issues.filter(issue => issue.code === 'missing_file').length, 1, 'same missing file is one finding');

  const conflict = preflight(
    board(scenes, { brand: brandSnapshot(logo({ position: 'bottom-right' })), subtitles: subtitles() }),
    [],
    { exists: () => true },
  );
  assert.equal(conflict.issues.filter(issue => issue.code === 'brand_logo_caption_conflict').length, 1, 'two scenes with long captions still yield one project-level finding');

  const portraitScenes = [scene({ id: 'a' }), scene({ id: 'b' }), scene({ id: 'c' })];
  const oversized = preflight(
    board(portraitScenes, { aspectRatio: '9:16', brand: brandSnapshot(logo({ width: 400 })) }),
    [],
    { exists: () => true },
  );
  assert.equal(oversized.issues.filter(issue => issue.code === 'brand_logo_too_large').length, 1, 'size finding is project level too');
});

test('#49 无 Brand 项目 preflight 结果完全不变', () => {
  const scenes = [scene({ audioDuration: 2, duration: 2 })];
  const plain = preflight(board(scenes, { subtitles: { enabled: false } }), [], { exists: () => true });
  assert.deepEqual(codes(plain), ['scene_too_short', 'subtitles_off'], 'existing findings are untouched');
  assert.equal(plain.blocking, 0);
  assert.equal(brandIssues(plain).length, 0);
  assert.equal(preflightGaps(plain).length, 0);

  // A project that only carries a pending brand kit id (no snapshot yet) must behave identically.
  const pending = preflight(board(scenes, { brandKitId: 'acme', subtitles: { enabled: false } }), [], { exists: () => true });
  assert.deepEqual(pending, plain, 'no brand snapshot means no brand checks at all');
});
