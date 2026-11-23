import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { createRequire } from 'node:module';
import { brandLogoPlacement, captionSafeArea, rendererScale, SceneSchema, SubtitleSchema, VisualPlanSchema, type Scene, type VisualTemplateId } from '@m2v/schema';
import { resolveBrandTheme } from '@m2v/styles';
import { VisualTemplateContent, visualTemplateRegistry } from '../src/visual-templates';
import { visualQualityStoryboard } from './fixtures/v19-visual-quality';

const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url));
const { renderToStaticMarkup } = webRequire('react-dom/server') as { renderToStaticMarkup: (element: unknown) => string };
const theme = resolveBrandTheme('minimal-tech');
const templateSceneIds: Record<VisualTemplateId, string> = {
  hero: 'v190-hero',
  comparison: 'v190-comparison',
  diagram: 'v190-diagram',
  timeline: 'v190-timeline',
  chart: 'v190-chart',
};

function render(scene: Scene, templateId: VisualTemplateId, portrait: boolean, options: { frame?: number; reducedMotion?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(VisualTemplateContent, { scene, templateId, theme, portrait, fps: 30, ...options }));
}

function renderedFontSizes(markup: string) {
  return [...markup.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
}

test('V1.9.0 registry contains five bounded templates for both aspect ratios', () => {
  assert.deepEqual(Object.keys(visualTemplateRegistry).sort(), ['chart', 'comparison', 'diagram', 'hero', 'timeline']);
  for (const [id, entry] of Object.entries(visualTemplateRegistry)) {
    assert.equal(entry.id, id);
    assert.deepEqual(entry.supportedAspectRatios, ['16:9', '9:16']);
    assert.ok(entry.minElements >= 1 && entry.maxElements >= entry.minElements, id);
    for (const edge of Object.values(entry.safeArea)) assert.ok(edge >= 0 && edge < 50, `${id} safe area`);
    assert.equal(entry.fallback, 'structured');
  }
});

test('five standard templates render source facts as editable HTML in landscape and portrait', () => {
  const expectedText: Record<VisualTemplateId, string[]> = {
    hero: ['从输入到输出：编译器的三个阶段', '词法分析把字符变成记号'],
    comparison: ['同步调用等待结果返回', '异步调用允许调用方继续执行'],
    diagram: ['词法分析把字符变成记号', '语法分析把记号组织成语法树', '代码生成把语法树转换为目标代码'],
    timeline: ['接收请求', '校验参数', '读取数据', '返回结果'],
    chart: ['第一季度', '120', '第四季度', '210'],
  };
  for (const templateId of Object.keys(templateSceneIds) as VisualTemplateId[]) {
    const scene = visualQualityStoryboard.scenes.find(item => item.id === templateSceneIds[templateId]);
    assert.ok(scene, `fixture for ${templateId}`);
    const landscape = render(scene, templateId, false);
    const portrait = render(scene, templateId, true);
    for (const markup of [landscape, portrait]) {
      assert.ok(markup.includes(`data-template-id="${templateId}"`), templateId);
      for (const text of expectedText[templateId]) assert.ok(markup.includes(text), `${templateId}: ${text}`);
    }
    assert.notEqual(landscape, portrait, `${templateId} must use distinct canvas composition`);
    assert.equal(render(scene, templateId, false), landscape, `${templateId} output is deterministic`);
    assert.equal(/<(?:img|iframe)\b/i.test(landscape + portrait), false, `${templateId} uses no remote/undocumented media`);
  }
});

test('portrait comparisons stack while landscape comparisons use independent columns', () => {
  const scene = visualQualityStoryboard.scenes.find(item => item.id === templateSceneIds.comparison)!;
  const landscape = render(scene, 'comparison', false);
  const portrait = render(scene, 'comparison', true);
  assert.match(landscape, /grid-template-columns:1fr 1fr/);
  assert.match(portrait, /grid-template-columns:1fr/);
  assert.ok(landscape.indexOf('同步') < landscape.indexOf('异步'));
  assert.ok(portrait.indexOf('同步') < portrait.indexOf('异步'));
});

test('all style packs keep chart and comparison text at the aspect-ratio readability floor', () => {
  const chart = visualQualityStoryboard.scenes.find(item => item.id === templateSceneIds.chart)!;
  const comparison = visualQualityStoryboard.scenes.find(item => item.id === templateSceneIds.comparison)!;
  for (const pack of ['editorial-tech', 'clean-data', 'paper-collage-lite'] as const) {
    const packTheme = resolveBrandTheme('minimal-tech', undefined, pack);
    for (const portrait of [false, true]) {
      const minimum = portrait ? 20 : 18;
      for (const [scene, template] of [[chart, 'chart'], [comparison, 'comparison']] as const) {
        const markup = renderToStaticMarkup(createElement(VisualTemplateContent, { scene, templateId: template, theme: packTheme, portrait, fps: 30 }));
        const sizes = renderedFontSizes(markup);
        assert.ok(sizes.length > 0, `${pack} ${template} has measured text styles`);
        assert.ok(sizes.every(size => size >= minimum), `${pack} ${template} ${portrait ? 'portrait' : 'landscape'} sizes: ${sizes.join(', ')}`);
      }
    }
  }
});

test('registry is local-only and template markup does not accept source executable markup', () => {
  const scene = {
    ...visualQualityStoryboard.scenes.find(item => item.id === templateSceneIds.hero)!,
    visual: { text: '<img src=x onerror=alert(1)>' },
  } as Scene;
  const markup = render(scene, 'hero', false);
  assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(/<img\b/i.test(markup), false);
  assert.equal(/https?:\/\//i.test(JSON.stringify(visualTemplateRegistry)), false);
});

test('bottom-right Brand Kit Logo clears the subtitle-safe band in both aspect ratios', () => {
  const logo = { enabled: true, src: 'brand-logo.png', position: 'bottom-right' as const, width: 150, opacity: 1, margin: 36 };
  for (const canvas of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) {
    const scale = rendererScale(canvas.width, canvas.height);
    const placement = brandLogoPlacement({
      logo,
      subtitles: SubtitleSchema.parse({ enabled: true, position: 'bottom', fontSize: 30 }),
      videoWidth: canvas.width,
      videoHeight: canvas.height,
    });
    assert.ok(placement);
    const safeArea = captionSafeArea({ videoHeight: canvas.height, fontSize: 30, scale });
    assert.equal(placement.verticalEdge, 'bottom');
    assert.ok(placement.verticalOffset >= safeArea.total, `${canvas.width}×${canvas.height}`);
    assert.equal(placement.width, logo.width * scale);
  }
});

test('chart number-count is frame-driven and reduced motion shows the complete static value', () => {
  const source = visualQualityStoryboard.scenes.find(item => item.id === templateSceneIds.chart)!;
  const beats = [
    { id: 'quarter-1', narrationText: '第一季度', targetIds: ['chart-value-1'] },
    { id: 'quarter-2', narrationText: '第四季度', targetIds: ['chart-value-4'] },
  ];
  const scene = SceneSchema.parse({
    ...source,
    visualPlan: VisualPlanSchema.parse({
      templateId: 'chart', beats,
      motionPresets: [{ targetId: 'chart-value-1', beatRef: 'quarter-1', durationPolicy: 'fixed', durationFrames: 30, action: 'number-count', parameters: { decimals: 0 } }],
    }),
    visualBeats: beats,
  });
  const start = render(scene, 'chart', false, { frame: 0 });
  const middle = render(scene, 'chart', false, { frame: 15 });
  const end = render(scene, 'chart', false, { frame: 30 });
  const reducedStart = render(scene, 'chart', false, { frame: 0, reducedMotion: true });
  const reducedEnd = render(scene, 'chart', false, { frame: 30, reducedMotion: true });
  assert.match(start, />0<\/strong>/);
  assert.match(middle, />90<\/strong>/);
  assert.match(end, />120<\/strong>/);
  assert.match(reducedStart, />120<\/strong>/);
  assert.equal(reducedStart, reducedEnd, 'reduced motion remains static across frames');
});
