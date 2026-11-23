import React from 'react';
import { resolveVisualBeatTimeline, type Scene, type VisualTemplateId } from '@m2v/schema';
import type { ResolvedTheme } from '@m2v/styles';
import { visualDesignTokens } from '@m2v/styles';
import { motionStyleForTarget, animatedNumberValue } from './motion';

export type VisualTemplateDefinition = {
  id: VisualTemplateId;
  sceneTypes: readonly string[];
  supportedAspectRatios: readonly ['16:9', '9:16'];
  minElements: number;
  maxElements: number;
  editableParameters: readonly string[];
  safeArea: { top: number; right: number; bottom: number; left: number };
  fallback: VisualTemplateId | 'structured';
};

/** Static, auditable registry. Layouts use local CSS/SVG primitives and have no remote assets. */
export const visualTemplateRegistry: Record<VisualTemplateId, VisualTemplateDefinition> = {
  hero: { id: 'hero', sceneTypes: ['title', 'text'], supportedAspectRatios: ['16:9', '9:16'], minElements: 1, maxElements: 5, editableParameters: ['keyFocus', 'accent'], safeArea: { top: 8, right: 7, bottom: 19, left: 7 }, fallback: 'structured' },
  comparison: { id: 'comparison', sceneTypes: ['comparison'], supportedAspectRatios: ['16:9', '9:16'], minElements: 2, maxElements: 2, editableParameters: ['keyFocus', 'emphasis'], safeArea: { top: 8, right: 7, bottom: 19, left: 7 }, fallback: 'structured' },
  diagram: { id: 'diagram', sceneTypes: ['diagram'], supportedAspectRatios: ['16:9', '9:16'], minElements: 2, maxElements: 12, editableParameters: ['keyFocus', 'flowDirection'], safeArea: { top: 8, right: 7, bottom: 19, left: 7 }, fallback: 'structured' },
  timeline: { id: 'timeline', sceneTypes: ['timeline'], supportedAspectRatios: ['16:9', '9:16'], minElements: 2, maxElements: 10, editableParameters: ['keyFocus', 'density'], safeArea: { top: 8, right: 7, bottom: 19, left: 7 }, fallback: 'structured' },
  chart: { id: 'chart', sceneTypes: ['chart'], supportedAspectRatios: ['16:9', '9:16'], minElements: 1, maxElements: 12, editableParameters: ['keyFocus', 'chartKind'], safeArea: { top: 8, right: 7, bottom: 19, left: 7 }, fallback: 'structured' },
};

type Props = { scene: Scene; templateId: VisualTemplateId; theme: ResolvedTheme; portrait: boolean; frame?: number; fps?: number; reducedMotion?: boolean };

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const cardStyle = (theme: ResolvedTheme, portrait: boolean): React.CSSProperties => {
  const pack = theme.stylePackId;
  const flat = Boolean(pack && theme.layout.cardStyle === 'flat');
  const borderless = Boolean(pack && theme.layout.cardStyle === 'none');
  const editorial = pack === 'editorial-tech';
  const paper = pack === 'paper-collage-lite';
  return {
    background: borderless ? 'transparent' : paper
      ? `linear-gradient(155deg, ${theme.colors.card}, ${theme.colors.card} 82%, ${theme.colors.secondary}55)`
      : editorial ? `linear-gradient(135deg, ${theme.colors.card}, ${theme.colors.bg} 160%)` : theme.colors.card,
    border: borderless ? 'none' : !pack ? `1px solid ${theme.colors.accent}44` : paper ? `1px solid ${theme.colors.secondary}cc` : editorial ? `1px solid ${theme.colors.accent}66` : `1px solid ${theme.colors.muted}55`,
    borderLeft: !borderless && editorial ? `7px solid ${theme.colors.accent}` : undefined,
    borderRadius: pack ? theme.layout.borderRadius : visualDesignTokens.spacing.md,
    padding: portrait ? '24px 22px' : '28px 32px',
    boxShadow: borderless || flat ? 'none' : !pack ? `0 16px 48px ${theme.colors.bg}55` : paper
      ? `5px 7px 0 ${theme.colors.secondary}77, 0 12px 24px ${theme.colors.bg}22`
      : editorial ? `0 18px 36px ${theme.colors.bg}88` : visualDesignTokens.depth.panel,
    minWidth: 0,
  };
};

/** Render one validated standard template. All visible content remains ordinary editable text. */
export function VisualTemplateContent({ scene, templateId, theme, portrait, frame = 0, fps = 30, reducedMotion = false }: Props) {
  const editorial = theme.stylePackId === 'editorial-tech';
  const cleanData = theme.stylePackId === 'clean-data';
  const paper = theme.stylePackId === 'paper-collage-lite';
  const beatFrames = resolveVisualBeatTimeline(scene, fps);
  const activeBeat = beatFrames.find(beat => frame >= beat.startFrame && frame < beat.endFrame);
  const beatTargets = new Set(beatFrames.flatMap(beat => beat.targetIds));
  const motion = (targetId: string): React.CSSProperties => {
    const chartTarget = targetId.match(/^chart-(?:value-|bar-)?(\d+)$/)?.[1];
    const semanticTarget = chartTarget ? 'chart-' + chartTarget : targetId;
    const staged = beatTargets.has(semanticTarget);
    return {
      ...motionStyleForTarget({ targetId, scene, frame, fps, reducedMotion }),
      ...(staged && activeBeat && !activeBeat.targetIds.includes(semanticTarget) ? { display: 'none' } : {}),
    };
  };
  const title = scene.title?.trim() || (templateId === 'hero' ? '要点' : '');
  const keyFocus = scene.visualPlan?.keyFocus?.trim();
  const minimumReadableFont = portrait ? 20 : 18;
  const bodyFontSize = (size: number) => Math.max(minimumReadableFont, size * (theme.stylePackId ? theme.typography.bodyScale : 1));
  const titleStyle: React.CSSProperties = {
    margin: 0,
    color: theme.colors.fg,
    fontFamily: theme.fontFamilies.heading,
    fontSize: (portrait ? 47 : 58) * (theme.stylePackId ? theme.typography.titleScale : 1) * (editorial ? 1.08 : paper ? 1.035 : 1),
    lineHeight: 1.12,
    fontWeight: 760,
    overflowWrap: 'anywhere',
    letterSpacing: editorial ? '-.045em' : cleanData ? '-.015em' : paper ? '-.02em' : undefined,
    ...(editorial ? { borderLeft: `8px solid ${theme.colors.accent}`, paddingLeft: 22 } : {}),
    ...(cleanData ? { paddingBottom: 14, borderBottom: `2px solid ${theme.colors.muted}66` } : {}),
    ...(paper ? { textDecoration: `underline ${theme.colors.accent} 3px`, textUnderlineOffset: 9 } : {}),
  };
  const labelStyle: React.CSSProperties = { color: theme.colors.muted, fontSize: bodyFontSize(portrait ? 20 : 22), lineHeight: 1.45 };
  const titleBlock = title ? <h1 style={{ ...titleStyle, ...motion('scene-title') }} data-target-id="scene-title">{title}</h1> : null;
  const headingAlign: React.CSSProperties['textAlign'] = cleanData ? 'center' : theme.stylePackId && theme.layout.alignment === 'center' ? 'center' : 'left';
  const heading = <div style={{ display: 'grid', gap: editorial ? 22 : paper ? 12 : 16, marginBottom: 30, textAlign: headingAlign, ...(paper ? { padding: '0 8px 10px', borderBottom: `1px dashed ${theme.colors.secondary}aa` } : {}) }}>{titleBlock}{keyFocus && <p style={{ color: theme.colors.accent, fontSize: (portrait ? 23 : 26) * (theme.stylePackId ? theme.typography.bodyScale : 1), fontWeight: 700, margin: 0, ...(cleanData ? { letterSpacing: '.08em', textTransform: 'uppercase' as const } : {}), ...(paper ? { display: 'inline-block', justifySelf: 'start', padding: '6px 12px', background: `${theme.colors.secondary}77`, borderRadius: 2 } : {}), ...motion('key-focus') }} data-target-id="key-focus">{keyFocus}</p>}</div>;
  const common = { fontFamily: theme.fontFamilies.body, color: theme.colors.fg, width: editorial ? '100%' : cleanData ? '92%' : paper ? '97%' : '100%', maxWidth: editorial ? 1500 : cleanData ? 1320 : paper ? 1480 : 1420, margin: 'auto', position: 'relative' as const, zIndex: 1, ...(cleanData ? { paddingTop: 8 } : {}) };

  if (templateId === 'hero') {
    const narration = text(scene.visual.text) || scene.narration;
    const number = narration.match(/\d+(?:[,.，]\d+)*(?:%|％|倍|年|天|人|元|万|亿)?/u)?.[0];
    const numberValue = number ? Number(number.replace(/[,.，]/gu, '').replace(/[^\d.-]/gu, '')) : 0;
    const numberSuffix = number?.replace(/[\d,.，-]/gu, '') ?? '';
    const beats = scene.visualBeats?.length ? scene.visualBeats : scene.visualPlan?.beats ?? [];
    const copy = beats.length > 1 && beats.some(beat => beat.contentText !== undefined)
      ? beats.map((beat, index) => ({ id: beat.targetIds[0] ?? `hero-copy-${index + 1}`, text: (beat.contentText ?? '').trim() })).filter(beat => beat.text.length > 0)
      : [{ id: 'hero-copy', text: narration }];
    return <div style={{ ...common, display: 'grid', gridTemplateColumns: portrait || !number ? '1fr' : '1.15fr .85fr', alignItems: 'center', gap: 36 }} data-template-id="hero">
      <section style={{ display: 'grid', gap: 28 }}>{heading}{copy.map(beat => <p key={beat.id} style={{ color: theme.colors.fg, fontSize: (portrait ? 27 : 31) * (theme.stylePackId ? theme.typography.bodyScale : 1), lineHeight: 1.55, margin: 0, maxWidth: 980, whiteSpace: 'pre-wrap', ...motion(beat.id) }} data-target-id={beat.id}>{beat.text}</p>)}</section>
      {number && <aside style={{ ...cardStyle(theme, portrait), borderLeft: `8px solid ${theme.colors.accent}`, display: 'grid', gap: 12, justifyItems: 'start', ...motion('hero-stat') }} data-target-id="hero-stat"><span style={labelStyle}>关键数据</span><strong style={{ color: theme.colors.accent, fontSize: portrait ? 74 : 112, lineHeight: 1, letterSpacing: '-.04em' }} data-target-id="hero-stat-number">{Number.isFinite(numberValue) ? animatedNumberValue({ targetId: 'hero-stat-number', value: numberValue, scene, frame, fps, reducedMotion }) : number}{numberSuffix}</strong></aside>}
      <div aria-hidden style={{ position: 'absolute', width: portrait ? 160 : 240, height: portrait ? 160 : 240, right: portrait ? -18 : 20, top: portrait ? -24 : -60, borderRadius: '50%', border: `2px solid ${theme.colors.accent}33`, boxShadow: `0 0 0 24px ${theme.colors.accent}0d`, zIndex: -1 }} />
    </div>;
  }

  if (templateId === 'comparison') {
    const columns = list(scene.visual.columns).slice(0, 2) as { title?: string; items?: string[] }[];
    const cards = columns.map((column, index) => <article key={index} style={{ ...cardStyle(theme, portrait), borderTop: paper ? undefined : `5px solid ${index ? theme.colors.secondary : theme.colors.accent}`, display: 'grid', alignContent: 'start', gap: editorial ? 22 : 18, ...motion(`compare-${index + 1}`) }} data-target-id={`compare-${index + 1}`}>
      {(editorial || cleanData || paper) && <span aria-hidden style={{ color: theme.colors.accent, fontSize: bodyFontSize(14), fontWeight: 800, letterSpacing: editorial ? '.18em' : '.06em', borderBottom: `1px ${paper ? 'dashed' : 'solid'} ${theme.colors.muted}55`, paddingBottom: 8 }}>{editorial ? `COMPARE / 0${index + 1}` : cleanData ? `对照 ${String(index + 1).padStart(2, '0')}` : `纸片 ${String(index + 1).padStart(2, '0')}`}</span>}
      <h2 style={{ margin: 0, fontSize: (portrait ? 29 : 34) * (theme.stylePackId ? theme.typography.titleScale : 1), lineHeight: 1.25, ...(cleanData ? { fontWeight: 650 } : {}), ...(paper ? { fontFamily: theme.fontFamilies.heading, textDecoration: `underline ${theme.colors.secondary} 2px`, textUnderlineOffset: 5 } : {}) }}>{text(column?.title) || `选项 ${index + 1}`}</h2>
      {list(column?.items).slice(0, 8).map((item, row) => <p key={row} style={{ margin: 0, padding: paper ? '14px 16px' : '12px 14px', borderLeft: editorial ? `4px solid ${index ? theme.colors.secondary : theme.colors.accent}` : undefined, borderBottom: cleanData ? `1px solid ${theme.colors.muted}44` : undefined, background: cleanData ? 'transparent' : paper ? `${theme.colors.secondary}66` : `${theme.colors.bg}99`, borderRadius: paper ? 3 : 0, boxShadow: paper ? `2px 3px 0 ${theme.colors.secondary}55` : undefined, fontSize: bodyFontSize(portrait ? 21 : 24), lineHeight: 1.45, overflowWrap: 'anywhere' }}>{text(item)}</p>)}
    </article>);
    return <div style={{ ...common, display: 'grid', gap: 24 }} data-template-id="comparison">{heading}<div style={{ display: 'grid', gridTemplateColumns: portrait ? '1fr' : '1fr 1fr', gap: 24, alignItems: 'stretch' }}>{cards}</div></div>;
  }

  if (templateId === 'diagram') {
    const nodes = list(scene.visual.nodes).slice(0, 12).map((value, index) => {
      if (typeof value === 'string') return { id: `node-${index + 1}`, label: value };
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      return { id: text(record.id) || `node-${index + 1}`, label: text(record.label) || text(record.text) || text(record.title) || text(record.content) };
    }).filter((node): node is { id: string; label: string } => Boolean(node?.label));
    return <div style={{ ...common, display: 'grid', gap: 22 }} data-template-id="diagram">{heading}<div style={{ display: 'flex', flexDirection: portrait ? 'column' : 'row', flexWrap: portrait ? 'nowrap' : 'wrap', gap: 16, alignItems: 'center' }}>
      {nodes.map((node, index) => <React.Fragment key={node.id}><article style={{ ...cardStyle(theme, portrait), display: 'grid', alignContent: 'center', minHeight: portrait ? 76 : 110, textAlign: 'center', fontSize: bodyFontSize(portrait ? 22 : 27), fontWeight: 700, overflowWrap: 'anywhere', flex: '1 1 180px', ...motion(node.id) }} data-target-id={node.id}>{node.label}</article>{index < nodes.length - 1 && <span aria-hidden data-target-id={`flow-${index + 1}`} style={{ color: theme.colors.accent, fontSize: portrait ? 30 : 36, fontWeight: 800, textAlign: 'center', ...motion(`flow-${index + 1}`) }}>{portrait ? '↓' : '→'}</span>}</React.Fragment>)}
    </div></div>;
  }

  if (templateId === 'timeline') {
    const items = list(scene.visual.items).slice(0, 10) as { date?: string; label?: string }[];
    return <div style={{ ...common, display: 'grid', gap: 24 }} data-template-id="timeline">{heading}<div style={{ display: 'grid', gridTemplateColumns: portrait ? '1fr' : `repeat(${Math.min(items.length, 4)}, minmax(0, 1fr))`, gap: 16 }}>
      {items.map((item, index) => <article key={index} style={{ ...cardStyle(theme, portrait), position: 'relative', display: 'grid', gap: 12, alignContent: 'start', borderTop: `5px solid ${index % 2 ? theme.colors.secondary : theme.colors.accent}`, ...motion(`timeline-${index + 1}`) }} data-target-id={`timeline-${index + 1}`}><span style={{ color: theme.colors.accent, fontSize: bodyFontSize(portrait ? 20 : 22), fontWeight: 800 }}>{text(item?.date)}</span><p style={{ margin: 0, fontSize: bodyFontSize(portrait ? 22 : 25), lineHeight: 1.45, overflowWrap: 'anywhere' }}>{text(item?.label)}</p></article>)}
    </div></div>;
  }

  const data = list(scene.visual.data).filter((item): item is { label: string; value: number } => Boolean(item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).label === 'string' && typeof (item as Record<string, unknown>).value === 'number' && Number.isFinite((item as Record<string, unknown>).value))).slice(0, 12);
  if (!data.length) return <div style={common} data-template-id="chart">{heading}<p style={labelStyle}>{scene.narration}</p></div>;
  const max = Math.max(1, ...data.map(item => item.value));
  const min = Math.min(0, ...data.map(item => item.value));
  const chartGrid = editorial
    ? `repeating-linear-gradient(to bottom, transparent 0, transparent 55px, ${theme.colors.accent}33 56px, transparent 57px)`
    : cleanData
      ? `repeating-linear-gradient(to bottom, transparent 0, transparent 47px, ${theme.colors.muted}35 48px, transparent 49px)`
      : paper ? `repeating-linear-gradient(to bottom, transparent 0, transparent 39px, ${theme.colors.secondary}55 40px, transparent 41px)` : undefined;
  return <div style={{ ...common, display: 'grid', gap: 24 }} data-template-id="chart">{heading}<div style={{ ...cardStyle(theme, portrait), position: 'relative', overflow: 'hidden', display: 'grid', gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))`, alignItems: 'end', gap: portrait ? 10 : 20, minHeight: portrait ? 310 : 380, padding: cleanData ? (portrait ? '28px 18px 20px' : '34px 32px 24px') : undefined, borderLeft: cleanData ? `2px solid ${theme.colors.muted}88` : undefined, borderBottom: cleanData ? `2px solid ${theme.colors.muted}88` : undefined, backgroundImage: chartGrid, ...(paper ? { backgroundSize: '100% 40px', backgroundPosition: '0 0' } : {}) }}>
    {data.map((item, index) => <div key={`${item.label}-${index}`} style={{ minWidth: 0, display: 'grid', gridTemplateRows: 'auto 1fr auto', height: '100%', alignItems: 'end', textAlign: cleanData ? 'left' : 'center', gap: cleanData ? 8 : 12, padding: cleanData ? '0 5px' : undefined, ...motion(`chart-${index + 1}`) }} data-target-id={`chart-${index + 1}`}>
      <strong style={{ color: theme.colors.fg, fontVariantNumeric: editorial || cleanData ? 'tabular-nums' : undefined, fontSize: bodyFontSize(portrait ? 20 : 20), overflowWrap: 'anywhere', ...motion(`chart-value-${index + 1}`) }} data-target-id={`chart-value-${index + 1}`}>{animatedNumberValue({ targetId: `chart-value-${index + 1}`, value: item.value, scene, frame, fps, reducedMotion })}</strong>
      <div style={{ width: cleanData ? '52%' : paper ? '66%' : portrait ? '70%' : '76%', justifySelf: 'center', height: `${Math.max(8, ((item.value - min) / Math.max(1, max - min)) * 250)}px`, background: paper
        ? `repeating-linear-gradient(135deg, ${index % 2 ? theme.colors.secondary : theme.colors.accent} 0 7px, ${theme.colors.card} 7px 10px)`
        : editorial ? `linear-gradient(180deg, ${theme.colors.accent}, ${index % 2 ? theme.colors.secondary : theme.colors.accent}bb)`
          : index % 2 ? theme.colors.secondary : theme.colors.accent, borderRadius: cleanData ? '3px 3px 0 0' : paper ? '0' : '10px 10px 2px 2px', clipPath: paper ? 'polygon(0 3%, 96% 0, 100% 98%, 4% 100%)' : undefined, boxShadow: paper ? `3px 4px 0 ${theme.colors.secondary}66` : editorial ? `0 8px 28px ${theme.colors.accent}33` : 'none', ...motion(`chart-bar-${index + 1}`) }} data-target-id={`chart-bar-${index + 1}`} />
      <span style={{ ...labelStyle, textAlign: cleanData ? 'left' : 'center', fontSize: bodyFontSize(portrait ? 20 : 18), overflowWrap: 'anywhere' }}>{item.label}</span>
    </div>)}
  </div></div>;
}
