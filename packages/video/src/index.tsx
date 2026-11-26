import React, { useCallback, useMemo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { AbsoluteFill, Audio, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig, delayRender, continueRender } from 'remotion';
import { sanitizeSceneHtml, SubtitleSchema, SceneSchema, SoundEffectsSettingsSchema, resolveVisualBeatTimeline, resolveTableRowsForFrame, layoutMetrics, timelineFrames, sceneTransitionWindows, codeVisualOf, STYLE_PACK_LOGO_SAFE_AREA_RATIO, type Scene, type Storyboard, type StyleId, type StylePackId, type FrameCard, type Transition } from '@m2v/schema';
import { resolveSceneTheme } from './theme';
import { captionDuration, captionAt, resolveCaptionCues } from './captions';
import { rendererScale, CAPTION_EDGE_RATIO, CAPTION_LINE_HEIGHT, CAPTION_PADDING_Y, captionSafeArea } from './safe-area';
import { brandLogoPlacement } from './brand-overlay';
import { CodeScene } from './code-scene';
import { CodeHtmlScene } from './code-html-scene';
import { VisualTemplateContent, visualTemplateRegistry } from './visual-templates';
import { animatedNumberValue, motionStyleForTarget } from './motion';
import { resolveAudioDuckGain, resolveBgmFrameGain, resolveSfxCueFadeEnvelope, resolveSfxCueInstances } from './sfx';

export * from './code-scene';
export * from './code-html-scene';
export * from './visual-templates';
export * from './motion';
export * from './sfx';

function FitContent({ children, signature, onOverflow, minimumScale = .62 }: { children: React.ReactNode; signature: string; onOverflow?: (overflowing: boolean) => void; minimumScale?: number }) {
  const outer = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null);
  const [factor, setFactor] = useState(1);
  const { width: compositionWidth, height: compositionHeight } = useVideoConfig();
  useLayoutEffect(() => {
    const handle = delayRender('计算场景排版'); let stopped = false, continued = false;
    const unblock = () => { if (!continued) { continued = true; continueRender(handle); } };
    const measure = () => {
      if (stopped || !outer.current || !inner.current) return;
      const available = outer.current;
      const content = inner.current;
      // Remotion first mounts the composition in a small probe viewport (often 200x150),
      // then resizes Chromium to the actual composition dimensions. Measuring text wrapping
      // in that probe viewport incorrectly scales dense scenes and leaves stale QA overflow.
      // Keep the initial factor at 1; ResizeObserver remeasures after the real viewport arrives.
      if (available.clientWidth < compositionWidth * .5 || available.clientHeight < compositionHeight * .5) return;
      const raw = Math.min(1, available.clientHeight / Math.max(1, content.scrollHeight), available.clientWidth / Math.max(1, content.scrollWidth));
      const floor = Math.min(1, Math.max(.62, minimumScale));
      const next = Math.max(floor, raw);
      const overflowing = raw < floor;
      available.dataset.visualQaOverflow = String(overflowing);
      setFactor(next);
      onOverflow?.(minimumScale > .62 ? overflowing : raw < .9);
    };
    void document.fonts.ready.then(() => { measure(); requestAnimationFrame(unblock); });
    const observer = new ResizeObserver(measure); if (inner.current) observer.observe(inner.current);
    return () => { stopped = true; observer.disconnect(); unblock(); };
  }, [signature, onOverflow, minimumScale]);
  return <div ref={outer} data-visual-qa-overflow="false" style={{ position: 'absolute', inset: '15% 5% 20%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div ref={inner} style={{ width: '100%', flexShrink: 0, transform: `scale(${factor})`, transformOrigin: 'center', overflowWrap: 'anywhere' }}>{children}</div></div>;
}

function StylePackBackdrop({ stylePack, colors }: { stylePack?: StylePackId; colors: { accent: string; secondary: string } }) {
  if (stylePack !== 'paper-collage-lite') return null;
  return <div aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
    <div style={{ position: 'absolute', top: '10%', right: '8%', width: '16%', height: '13%', background: `${colors.secondary}66`, border: `2px solid ${colors.accent}44`, transform: 'rotate(7deg)', borderRadius: 4 }} />
    <div style={{ position: 'absolute', left: '4%', bottom: '13%', width: '11%', height: '18%', background: `${colors.accent}20`, border: `2px solid ${colors.accent}33`, transform: 'rotate(-8deg)', clipPath: 'polygon(5% 0, 100% 5%, 90% 100%, 0 88%)' }} />
    <div style={{ position: 'absolute', right: '17%', bottom: '12%', width: 42, height: 42, borderRadius: '50%', background: `${colors.secondary}88`, opacity: .55 }} />
  </div>;
}

function SfxAudio({ src, durationFrames, gain, settings, scene, cueStartFrame, fps, allCues }: {
  src: string; durationFrames: number; gain: number; settings: ReturnType<typeof SoundEffectsSettingsSchema.parse>;
  scene: Scene; cueStartFrame: number; fps: number; allCues: { startFrame: number; durationFrames: number; gain: number }[];
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    const handle = delayRender('检查本地音效素材');
    void fetch(staticFile(src), { method: 'HEAD' })
      .then(response => { if (active) setAvailable(response.ok); })
      .catch(() => { if (active) setAvailable(false); })
      .finally(() => { if (active) continueRender(handle); });
    return () => { active = false; continueRender(handle); };
  }, [src]);
  if (!settings.enabled || available !== true) return null;
  const fadeIn = Math.round(settings.fadeIn * fps);
  const fadeOut = Math.round(settings.fadeOut * fps);
  const voiceFrames = Math.round((scene.audioDuration ?? scene.duration ?? 0) * fps);
  return <Sequence from={cueStartFrame} durationInFrames={Math.max(1, durationFrames)}>
    <Audio src={staticFile(src)} volume={frame => {
      const sceneFrame = cueStartFrame + frame;
      const activeCues = allCues.filter(cue => sceneFrame >= cue.startFrame && sceneFrame < cue.startFrame + cue.durationFrames).length;
      const envelope = resolveSfxCueFadeEnvelope({ frame, durationFrames, fadeInFrames: fadeIn, fadeOutFrames: fadeOut });
      const voiceDuck = scene.audioSrc ? resolveAudioDuckGain(sceneFrame, [{ startFrame: 0, endFrame: voiceFrames }], 1 - settings.voiceDuck) : 1;
      return Math.max(0, Math.min(.8, settings.volume * gain / Math.max(1, activeCues) * envelope * voiceDuck));
    }} />
  </Sequence>;
}

function SceneSfxTrack({ scene, soundEffects, fps }: { scene: Scene; soundEffects: Storyboard['soundEffects']; fps: number }) {
  const settings = SoundEffectsSettingsSchema.parse(soundEffects ?? {});
  if (!settings.enabled || scene.visualStaticFallback || !scene.sfxCues?.length) return null;
  const cues = resolveSfxCueInstances(scene, scene.sfxCues, fps);
  const levels = cues.map(({ startFrame, durationFrames, cue }) => ({ startFrame, durationFrames, gain: cue.gain }));
  return <>{cues.map(({ cue, startFrame, durationFrames, src }) => <SfxAudio key={`${src}-${startFrame}`} src={src} durationFrames={durationFrames} gain={cue.gain} settings={settings} scene={scene} cueStartFrame={startFrame} fps={fps} allCues={levels} />)}</>;
}

function SceneViewContent({ scene, styleId, stylePack, brand, subtitles, soundEffects, transition = 'none', durationInFrames, reducedMotion = false, onOverflow, visualFrameOverride, includeAudio = true, includeSubtitles = true }: { scene: Scene; styleId: StyleId; stylePack?: StylePackId; brand: Storyboard['brand']; subtitles: Storyboard["subtitles"]; soundEffects: Storyboard['soundEffects']; transition?: Storyboard["transition"]; durationInFrames?: number; reducedMotion?: boolean; onOverflow?: (sceneId: string, overflowing: boolean) => void; visualFrameOverride?: number; includeAudio?: boolean; includeSubtitles?: boolean }) {
  styleId = scene.sceneStyle ?? styleId;
  const reportOverflow = useCallback((overflowing: boolean) => onOverflow?.(scene.id, overflowing), [onOverflow, scene.id]);
  const layoutSignature = useMemo(() => JSON.stringify([scene, styleId, stylePack, brand]), [scene, styleId, stylePack, brand]);
  const currentFrame = useCurrentFrame();
  const frame = visualFrameOverride ?? currentFrame;
  const { fps, width, height } = useVideoConfig();
  const sceneReducedMotion = reducedMotion || scene.visualStaticFallback === true;
  const beatFrames = resolveVisualBeatTimeline(scene, fps);
  const activeVisualBeat = beatFrames.find(beat => frame >= beat.startFrame && frame < beat.endFrame);
  const beatTargets = new Set(beatFrames.flatMap(beat => beat.targetIds));
  const motion = (targetId: string) => {
    const chartTarget = targetId.match(/^chart-(?:value-|bar-)?(\d+)$/)?.[1];
    const semanticTarget = chartTarget ? 'chart-' + chartTarget : targetId;
    const staged = beatTargets.has(semanticTarget);
    return {
      ...motionStyleForTarget({ targetId, scene, frame, fps, reducedMotion: sceneReducedMotion }),
      ...(staged && activeVisualBeat && !activeVisualBeat.targetIds.includes(semanticTarget) ? { display: 'none' } : {}),
    };
  };
  const scale = rendererScale(width, height);
  const metrics = layoutMetrics(scene, height > width);
  const theme = resolveSceneTheme({ styleId, stylePack, brand }, scene);
  const bodyBoost = height > width ? 1.15 : 1;
  const style = { ...theme, typography: { ...theme.typography, bodyScale: theme.typography.bodyScale * metrics.density * bodyBoost }, layout: { ...theme.layout, padding: theme.layout.padding * scale } };
  const subtitle = SubtitleSchema.parse(subtitles ?? {});
  const captionStyle: React.CSSProperties = { position: "absolute", zIndex: 5, left: `${CAPTION_EDGE_RATIO * 100}%`, right: `${CAPTION_EDGE_RATIO * 100}%`, ...(subtitle.position === "top" ? { top: `${CAPTION_EDGE_RATIO * 100}%` } : subtitle.position === "center" ? { top: "50%", transform: "translateY(-50%)" } : { bottom: `${CAPTION_EDGE_RATIO * 100}%` }), boxSizing: "border-box", padding: `${CAPTION_PADDING_Y * scale}px ${18 * scale}px`, borderRadius: 8 * scale, background: subtitle.preset === "minimal" ? "transparent" : `${subtitle.background}${Math.round(subtitle.backgroundOpacity * 255).toString(16).padStart(2, "0")}`, color: subtitle.color, textShadow: subtitle.preset === "minimal" ? "0 2px 4px #000" : undefined, textAlign: "center", fontSize: subtitle.fontSize * scale, lineHeight: CAPTION_LINE_HEIGHT, fontWeight: subtitle.preset === "highlight" ? 900 : 700, overflowWrap: "anywhere" };
  const imageStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: scene.image?.fit ?? "contain", objectPosition: `${scene.image?.x ?? 50}% ${scene.image?.y ?? 50}%`, transform: `scale(${scene.image?.zoom ?? 1})`, transformOrigin: `${scene.image?.x ?? 50}% ${scene.image?.y ?? 50}%` };
  const colors = theme.colors;
  const bg = stylePack === 'editorial-tech' ? `linear-gradient(${colors.accent}0c 1px, transparent 1px), linear-gradient(90deg, ${colors.accent}0c 1px, transparent 1px), radial-gradient(ellipse at 82% 14%, ${colors.secondary} 0%, ${colors.bg} 59%)`
    : stylePack === 'clean-data' ? `radial-gradient(ellipse at 88% 12%, ${colors.secondary}88 0%, transparent 36%), linear-gradient(145deg, ${colors.bg}, ${colors.bg} 72%, ${colors.accent}12)`
      : stylePack === 'paper-collage-lite' ? `linear-gradient(145deg, ${colors.bg}, ${colors.secondary}55 48%, ${colors.bg})`
        : styleId === 'minimal-tech' ? `linear-gradient(${brand ? `${colors.accent}0E` : 'rgba(80,227,194,.055)'} 1px, transparent 1px), linear-gradient(90deg, ${brand ? `${colors.accent}0E` : 'rgba(80,227,194,.055)'} 1px, transparent 1px), radial-gradient(ellipse at 85% 15%, ${brand ? colors.secondary : '#173553'} 0%, ${colors.bg} 56%)` : styleId === 'social-short' ? `radial-gradient(circle at 12% 85%, ${colors.secondary} 0%, transparent 34%), radial-gradient(circle at 88% 15%, ${brand ? colors.secondary : '#6346bd'} 0%, ${colors.bg} 50%)` : colors.bg;
  const backgroundSize = stylePack === 'editorial-tech' || (!stylePack && styleId === 'minimal-tech') ? '42px 42px, 42px 42px, cover' : 'cover';
  const entering = sceneReducedMotion
    ? { opacity: 1, transform: 'none' }
    : style.motion.entrance === 'kinetic'
    ? { opacity: .86 + .14 * interpolate(frame, [0, 9], [0, 1], { extrapolateRight: 'clamp' }), transform: `translateY(${interpolate(frame, [0, 12], [80, 0], { extrapolateRight: 'clamp' })}px) scale(${interpolate(frame, [0, 12], [.86, 1], { extrapolateRight: 'clamp' })})` }
    : style.motion.entrance === 'slide'
      ? { opacity: 1, transform: `translateX(${interpolate(frame, [0, 16], [-60, 0], { extrapolateRight: 'clamp' })}px)` }
      : style.motion.entrance === 'scale'
        ? { opacity: .86 + .14 * interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' }), transform: `scale(${interpolate(frame, [0, 12], [.92, 1], { extrapolateRight: 'clamp' })})` }
        : { opacity: .86 + .14 * interpolate(frame, [0, Math.min(16, fps / 2)], [0, 1], { extrapolateRight: 'clamp' }) };
  const fadeFrames = Math.max(1, Math.round(fps * 0.6));
  const fade = transition === 'fade' && durationInFrames
    ? Math.min(
      interpolate(frame, [0, fadeFrames], [0, 1], { extrapolateRight: 'clamp' }),
      interpolate(frame, [Math.max(0, durationInFrames - fadeFrames), durationInFrames], [1, 0], { extrapolateLeft: 'clamp' }),
    )
    : 1;
  const centered = style.layout.alignment === 'center';
  const htmlVisual = sanitizeSceneHtml(String(scene.visual.html ?? '')).replace(/(<div\b[^>]*\bstyle="[^"]*)justify-content\s*:\s*center\b([^"]*")/i, '$1justify-content:flex-start$2');
  const mediaSrc = String(scene.visual.src ?? '');
  const credit = [scene.visual['attribution'], scene.visual['license']].map(value => typeof value === 'string' ? value.trim() : '').filter(Boolean).join(' · ');
  const creditUrl = [scene.visual['licenseUrl'], scene.visual['sourceUrl']].find((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value));
  const creditText = credit && creditUrl ? `${credit} · ${creditUrl}` : credit;
  const isFullBleedSlide = scene.type === 'media' && (scene.visual.fullBleed === true || /(?:^|\/)slide-\d+\.png$/i.test(mediaSrc));
  const captionCues = useMemo(() => resolveCaptionCues(scene, captionDuration(scene), height > width), [scene, height, width]);
  const caption = includeSubtitles && subtitle.enabled ? captionAt(captionCues, frame / fps) : "";
  const sfxTrack = includeAudio ? <SceneSfxTrack scene={scene} soundEffects={soundEffects} fps={fps} /> : null;
  if (isFullBleedSlide) {
    return <AbsoluteFill style={{ backgroundColor: '#000', opacity: fade }}>
      <Img src={staticFile(mediaSrc)} style={imageStyle} />
      {caption && <div data-visual-qa-type="subtitle" data-visual-qa-target-id="subtitle" style={captionStyle}>{caption}</div>}
      {creditText && <small style={{ position: 'absolute', right: 20 * scale, top: 16 * scale, padding: `${5 * scale}px ${8 * scale}px`, background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: 13 * scale }}>{creditText}</small>}
      {includeAudio && scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
      {sfxTrack}
    </AbsoluteFill>;
  }
  if (scene.visualPlan && scene.type !== 'html' && scene.type !== 'code' && scene.type !== 'media' && typeof scene.visual.html !== 'string') {
    const template = visualTemplateRegistry[scene.visualPlan.templateId];
    if (template?.sceneTypes.includes(scene.type)) {
      const inset = `${template.safeArea.top}% ${template.safeArea.right}% ${template.safeArea.bottom}% ${template.safeArea.left}%`;
      return <AbsoluteFill style={{ ...entering, opacity: Number(entering.opacity) * fade, background: bg, backgroundSize, overflow: 'hidden', color: colors.fg, fontFamily: theme.fontFamilies.body }}>
        <StylePackBackdrop stylePack={stylePack} colors={colors} />
        <div style={{ position: 'absolute', inset, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <VisualTemplateContent scene={scene} templateId={scene.visualPlan.templateId} theme={theme} portrait={height > width} frame={frame} fps={fps} reducedMotion={sceneReducedMotion} />
        </div>
        {caption && <div data-visual-qa-type="subtitle" data-visual-qa-target-id="subtitle" style={captionStyle}>{caption}</div>}
        {includeAudio && scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
        {sfxTrack}
      </AbsoluteFill>;
    }
    onOverflow?.(scene.id, true);
  }
  const box: React.CSSProperties = { borderRadius: style.layout.cardStyle === 'none' ? 0 : style.layout.borderRadius, padding: style.layout.cardStyle === 'none' ? '20px 0' : 32, background: style.layout.cardStyle === 'soft' ? colors.card : 'transparent', border: style.layout.cardStyle === 'soft' ? `1px solid ${colors.accent}55` : 'none', boxShadow: styleId === 'social-short' ? `10px 10px 0 ${colors.secondary}` : 'none' };
  const title = <h1 style={{ fontFamily: theme.fontFamilies.heading, fontSize: 55 * scale * style.typography.titleScale * ((scene.title?.length ?? 0) > 24 ? .8 : 1), lineHeight: 1.08, margin: `0 0 ${24 * scale}px`, color: colors.fg, letterSpacing: styleId === 'social-short' ? -2 * scale : 0, textAlign: centered ? 'center' : 'left' }}>{scene.title ?? scene.type.toUpperCase()}</h1>;
  let content: React.ReactNode;
  // Structured code scenes always use the dynamic renderer; a static `visual.html` on such a scene
  // only means "HTML generation mode" and must not replace the code window with stale markup.
  const structuredCode = scene.type === 'code' && codeVisualOf(scene.visual) !== null;
  const staticHtmlScene = typeof scene.visual.html === 'string' && scene.type !== 'media' && !structuredCode;
  let tableMinimumScale = .62;
  switch (staticHtmlScene ? 'html' : scene.type) {
    case 'title': content = <div style={{ textAlign: 'center' }}>{title}<p style={{ color: colors.muted, fontSize: 32 * scale * style.typography.bodyScale }}>{scene.narration}</p></div>; break;
    case 'text': content = <div>{title}<p style={{ color: colors.fg, fontSize: 34 * scale * style.typography.bodyScale, lineHeight: 1.55, whiteSpace: 'pre-wrap', textAlign: centered ? 'center' : 'left' }}>{String(scene.visual.text ?? scene.narration)}</p></div>; break;
    case 'bullets': { const items = (scene.visual.items as (string | { text: string; children?: string[] })[] | undefined) ?? []; content = <div>{title}<ul style={{ color: colors.fg, fontSize: 34 * scale * style.typography.bodyScale, lineHeight: styleId === 'academic' ? 1.45 : 1.65, paddingLeft: centered ? 38 * scale : undefined }}>{items.map((item, i) => { const text = typeof item === 'string' ? item : item.text; const children = typeof item === 'string' ? [] : item.children ?? []; return <li key={i} data-target-id={`bullet-${i + 1}`} style={{ padding: `${5 * scale}px 0`, ...motion(`bullet-${i + 1}`) }}>{text}{children.length > 0 && <ul style={{ fontSize: '0.78em', lineHeight: 1.45, paddingLeft: 30 * scale, marginTop: 4 * scale }}>{children.map((child, childIndex) => <li key={childIndex} style={{ padding: `${2 * scale}px 0` }}>{child}</li>)}</ul>}</li>; })}</ul></div>; break; }
    case 'comparison': {
      const schematic = scene.visual.layout === 'diagram';
      const columns = scene.visual.columns as { title?: string; items?: string[] }[];
      const arrowOpacity = interpolate(frame, [0, Math.max(1, fps / 2)], [.2, 1], { extrapolateRight: 'clamp' });
      content = <div>{title}<div style={{ display: 'flex', flexDirection: metrics.stacked ? 'column' : 'row', gap: 24 * scale }}>
        {columns.map((col, i) => <React.Fragment key={i}>
          {i > 0 && schematic && <span aria-hidden style={{ alignSelf: 'center', color: colors.accent, opacity: arrowOpacity, fontSize: 46 * scale }}>{metrics.stacked ? '↕' : '↔'}</span>}
          <div data-target-id={`compare-${i + 1}`} style={{ ...box, ...(schematic ? { border: `2px solid ${i ? colors.secondary : colors.accent}88`, background: colors.card, padding: 22 * scale } : {}), flex: 1, color: colors.fg, ...motion(`compare-${i + 1}`) }}>
            <h2 style={schematic ? { margin: 0, fontSize: 35 * scale } : undefined}>{col.title ?? `选项 ${i + 1}`}</h2>
            {(col.items ?? []).map((item, j) => <p key={j} style={{ fontSize: 25 * scale * style.typography.bodyScale, ...(schematic ? { borderLeft: `3px solid ${colors.accent}`, background: colors.bg, margin: `${12 * scale}px 0 0 ${14 * scale}px`, padding: `${8 * scale}px ${14 * scale}px` } : {}) }}>{item}</p>)}
          </div>
        </React.Fragment>)}
      </div></div>;
      break;
    }
    case 'chart': {
      const rawData: unknown[] = Array.isArray(scene.visual.data) ? scene.visual.data : [];
      const matrix = rawData.length > 0 && rawData.every(Array.isArray) ? rawData as unknown[][] : null;
      const sourceNodes = scene.visual.nodes;
      const rawNodes = Array.isArray(sourceNodes) ? sourceNodes : sourceNodes && typeof sourceNodes === 'object' ? Object.values(sourceNodes) : [];
      const nodes = rawNodes.map((value, index) => {
        if (typeof value === 'string') return { id: `node-${index}`, label: value.trim(), icon: '' };
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const node = value as Record<string, unknown>;
        const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data) ? node.data as Record<string, unknown> : {};
        const label = [node.label, data.label, node.text, data.text, node.title, data.title, node.name, node.content, data.content, node.description, data.description, node.value, data.value].find(item => typeof item === 'string' && item.trim());
        const icon = [node.icon, data.icon, node.emoji, data.emoji].find(item => typeof item === 'string' && item.trim());
        return typeof label === 'string' || typeof icon === 'string'
          ? { id: typeof node.id === 'string' && node.id ? node.id : `node-${index}`, label: typeof label === 'string' ? label.trim() : '', icon: typeof icon === 'string' ? icon.trim() : '' }
          : null;
      }).filter((node): node is { id: string; label: string; icon: string } => Boolean(node && (node.label || node.icon)));
      if (nodes.length) {
        content = <div>{title}<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>{nodes.map((node, index) => <React.Fragment key={`${node.id}-${index}`}><div data-target-id={node.id} style={{ ...box, color: colors.fg, fontSize: 28 * scale * style.typography.bodyScale, ...motion(node.id) }}>{node.icon && <span style={{ display: 'block', fontSize: 38 * scale, marginBottom: 8 * scale }}>{node.icon}</span>}{node.label}</div>{index < nodes.length - 1 && <span data-target-id={`flow-${index + 1}`} style={{ color: colors.accent, fontSize: 40, ...motion(`flow-${index + 1}`) }}>→</span>}</React.Fragment>)}</div></div>;
      } else if (matrix) {
        const width = Math.max(1, ...matrix.map(row => row.length));
        const headers = Array.from({ length: width }, (_, index) => String(matrix[0]?.[index] ?? `列 ${index + 1}`));
        const rows = matrix.slice(1).map(row => headers.map((_, index) => String(row[index] ?? '')));
        content = <div>{title}<table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', color: colors.fg, fontSize: 24 * scale * style.typography.bodyScale, lineHeight: 1.35 }}><thead><tr>{headers.map((header, index) => <th key={index} style={{ padding: `${12 * scale}px`, border: `1px solid ${colors.accent}88`, background: `${colors.accent}22`, textAlign: 'left', overflowWrap: 'anywhere' }}>{header}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index} style={{ padding: `${12 * scale}px`, border: `1px solid ${colors.accent}55`, textAlign: 'left', verticalAlign: 'top', overflowWrap: 'anywhere' }}>{cell}</td>)}</tr>)}</tbody></table></div>;
      } else {
        const data = rawData.filter((item): item is { label: string; value: number } => Boolean(item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).label === 'string' && typeof (item as Record<string, unknown>).value === 'number' && Number.isFinite((item as Record<string, unknown>).value)));
        if (data.length) {
          const max = Math.max(...data.map(item => item.value), 1);
          content = <div>{title}<div style={{ display: 'flex', alignItems: 'end', gap: 22, height: 340 }}>{data.map((item, index) => <div key={index} data-target-id={`chart-${index + 1}`} style={{ flex: 1, textAlign: 'center', color: colors.muted, ...motion(`chart-${index + 1}`) }}><div data-target-id={`chart-bar-${index + 1}`} style={{ height: `${Math.max(8, 280 * item.value / max)}px`, background: index % 2 ? colors.secondary : colors.accent, borderRadius: styleId === 'academic' ? 0 : '12px 12px 0 0', ...motion(`chart-bar-${index + 1}`) }} /><b data-target-id={`chart-value-${index + 1}`} style={{ color: colors.fg, ...motion(`chart-value-${index + 1}`) }}>{animatedNumberValue({ targetId: `chart-value-${index + 1}`, value: item.value, scene, frame, fps, reducedMotion })}</b><span>{item.label}</span></div>)}</div></div>;
        } else content = <div>{title}<p style={{ color: colors.fg, fontSize: 30 * scale * style.typography.bodyScale, lineHeight: 1.5 }}>{scene.narration}</p></div>;
      }
      break;
    }
    case 'code': {
      // Structured code scenes render the real source window at a protected font size and are not
      // part of the generic content-fitting pass.
      if (codeVisualOf(scene.visual)) {
        // Reserve the real caption band (live subtitle size/position) so the beat card cannot
        // overlap the subtitles in either aspect ratio. Both rendering modes use the same visual.
        const captionReservedPx = subtitle.enabled && subtitle.position === 'bottom'
          ? captionSafeArea({ videoHeight: height, fontSize: subtitle.fontSize, scale, lines: 2 }).total
          : 0;
        const htmlMode = typeof scene.visual.html === 'string';
        return <AbsoluteFill style={{ ...entering, opacity: Number(entering.opacity) * fade, background: bg, backgroundSize: styleId === 'minimal-tech' ? '42px 42px, 42px 42px, cover' : 'cover', overflow: 'hidden' }}>
          {htmlMode
            ? <CodeHtmlScene scene={scene} styleId={styleId} brand={brand} captionReservedPx={captionReservedPx} />
            : <CodeScene scene={scene} styleId={styleId} brand={brand} captionReservedPx={captionReservedPx} />}
          {caption && <div data-visual-qa-type="subtitle" data-visual-qa-target-id="subtitle" style={captionStyle}>{caption}</div>}
          {includeAudio && scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
          {sfxTrack}
        </AbsoluteFill>;
      }
      // Legacy code scenes (explanation/steps only, no visual.code) keep their original layout.
      content = <div>{title}<div style={{ ...box, color: colors.fg, fontSize: 30 * scale * style.typography.bodyScale, lineHeight: 1.5 }}><p>{String(scene.visual.explanation ?? scene.narration)}</p>{Array.isArray(scene.visual.steps) && <ul>{(scene.visual.steps as unknown[]).filter((step): step is string => typeof step === 'string' && Boolean(step.trim())).slice(0, 5).map((step, index) => <li key={index}>{step}</li>)}</ul>}</div></div>;
      break;
    }
    case 'diagram': {
      const sourceNodes = scene.visual.nodes;
      const rawNodes = Array.isArray(sourceNodes) ? sourceNodes : sourceNodes && typeof sourceNodes === 'object' ? Object.values(sourceNodes) : [];
      const nodes = rawNodes.map((value, index) => {
        if (typeof value === 'string') return { id: `node-${index}`, label: value.trim(), icon: '' };
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const node = value as Record<string, unknown>;
        const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data) ? node.data as Record<string, unknown> : {};
        const label = [node.label, data.label, node.text, data.text, node.title, data.title, node.name, node.content, data.content, node.description, data.description, node.value, data.value].find(item => typeof item === 'string' && item.trim());
        const icon = [node.icon, data.icon, node.emoji, data.emoji].find(item => typeof item === 'string' && item.trim());
        return typeof label === 'string' || typeof icon === 'string'
          ? { id: typeof node.id === 'string' && node.id ? node.id : `node-${index}`, label: typeof label === 'string' ? label.trim() : '', icon: typeof icon === 'string' ? icon.trim() : '' }
          : null;
      }).filter((node): node is { id: string; label: string; icon: string } => Boolean(node && (node.label || node.icon)));
      content = <div>{title}{nodes.length > 0
        ? <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>{nodes.map((node, i) => <React.Fragment key={`${node.id}-${i}`}><div data-target-id={node.id} style={{ ...box, color: colors.fg, fontSize: 28 * scale * style.typography.bodyScale, ...motion(node.id) }}>{node.icon && <span style={{ display: 'block', fontSize: 38 * scale, marginBottom: 8 * scale }}>{node.icon}</span>}{node.label}</div>{i < nodes.length - 1 && <span data-target-id={`flow-${i + 1}`} style={{ color: colors.accent, fontSize: 40, ...motion(`flow-${i + 1}`) }}>→</span>}</React.Fragment>)}</div>
        : <p style={{ color: colors.fg, fontSize: 30 * scale * style.typography.bodyScale, lineHeight: 1.5, textAlign: centered ? 'center' : 'left' }}>{nodes[0]?.label || scene.narration}</p>}</div>;
      break;
    }
    case 'timeline': { const items = (scene.visual.items as { date: string; label: string }[] | undefined) ?? []; content = <div>{title}<div style={{ display: 'flex', flexDirection: metrics.stacked ? 'column' : 'row', gap: 12 * scale, alignItems: 'stretch' }}>{items.map((item, i) => <div key={i} data-target-id={`timeline-${i + 1}`} style={{ flex: 1, borderTop: `4px solid ${colors.accent}`, padding: 16, color: colors.fg, background: colors.card, ...motion(`timeline-${i + 1}`) }}><b style={{ color: colors.accent }}>{item.date}</b><p>{item.label}</p></div>)}</div></div>; break; }
    case 'table': {
      const headers = scene.visual.headers as string[];
      const rows = scene.visual.rows as string[][];
      const selection = resolveTableRowsForFrame(scene, frame, fps);
      const visibleRows = new Set(selection.rowIndices);
      const minimumFontSize = height > width ? 20 : 18;
      const tableFontSize = Math.max(minimumFontSize, 24 * scale * style.typography.bodyScale);
      tableMinimumScale = Math.min(1, minimumFontSize / Math.max(minimumFontSize, tableFontSize));
      content = <div>{title}<table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', color: colors.fg, fontSize: tableFontSize, lineHeight: 1.3 }}><thead><tr>{headers.map((header, i) => <th key={i} style={{ padding: `${12 * scale}px`, border: `1px solid ${colors.accent}88`, background: `${colors.accent}22`, textAlign: 'left', overflowWrap: 'anywhere' }}>{header}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => selection.staged && !visibleRows.has(rowIndex) ? null : <tr key={rowIndex} data-target-id={`table-row-${rowIndex + 1}`} style={{ ...motion(`table-row-${rowIndex + 1}`), ...(selection.staged ? { display: 'table-row' } : {}) }}>{row.map((cell, i) => <td key={i} style={{ padding: `${12 * scale}px`, border: `1px solid ${colors.accent}55`, textAlign: 'left', verticalAlign: 'top', overflowWrap: 'anywhere' }}>{cell}</td>)}</tr>)}</tbody></table></div>;
      break;
    }
    case 'math': { const formula = katex.renderToString(String(scene.visual.formula ?? ''), { displayMode: true, throwOnError: false, trust: false, output: 'html' }); content = <div>{title}<div style={{ textAlign: 'center', fontSize: 52 * scale, padding: 36, color: colors.accent }} dangerouslySetInnerHTML={{ __html: formula }} /><p style={{ color: colors.fg }}>{String(scene.visual.explanation ?? scene.narration)}</p></div>; break; }
    case 'media': content = <div>{title}<div style={{ height: height * .56, overflow: 'hidden' }}><Img src={staticFile(String(scene.visual.src ?? ''))} style={imageStyle} /></div>    {creditText && <small style={{ display: 'block', textAlign: 'center', marginTop: 12, color: colors.muted, fontSize: 13 * scale }}>{creditText}</small>}</div>; break;
    case 'html': content = <div style={{ width: '100%', height: height * .7, maxHeight: height * .78, overflow: 'hidden', display: 'flex', flexDirection: 'column', color: colors.fg, fontFamily: theme.fontFamilies.body, fontSize: 30 * scale * style.typography.bodyScale, lineHeight: 1.45 }} dangerouslySetInnerHTML={{ __html: htmlVisual }} />; break;
  }
  if (typeof scene.visual.html === 'string' && scene.type !== 'media') {
    return <AbsoluteFill style={{ ...entering, opacity: Number(entering.opacity) * fade, background: bg, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'grid', overflow: 'hidden', background: brand ? colors.bg : '#0b1020', ...(brand ? { color: colors.fg, fontFamily: theme.fontFamilies.body } : {}), whiteSpace: 'pre-wrap' }} dangerouslySetInnerHTML={{ __html: htmlVisual }} />
      {caption && <div data-visual-qa-type="subtitle" data-visual-qa-target-id="subtitle" style={captionStyle}>{caption}</div>}
      {includeAudio && scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
      {sfxTrack}
    </AbsoluteFill>;
  }
  const texture = stylePack === 'paper-collage-lite' ? `repeating-linear-gradient(0deg, transparent, transparent 42px, ${colors.accent}0b 43px)` : styleId === 'academic' ? 'repeating-linear-gradient(0deg, transparent, transparent 43px, rgba(90,70,45,.08) 44px)' : styleId === 'clean-light' ? 'radial-gradient(#d8e0ef 1px, transparent 1px)' : 'none';
  return <AbsoluteFill style={{ ...entering, opacity: Number(entering.opacity) * fade, background: bg, backgroundSize, color: colors.fg, padding: style.layout.padding, justifyContent: 'center', fontFamily: theme.fontFamilies.body }}>
    <StylePackBackdrop stylePack={stylePack} colors={colors} />
    {texture !== 'none' && <div style={{ position: 'absolute', inset: 0, background: texture, backgroundSize: stylePack === 'paper-collage-lite' || styleId === 'academic' ? 'auto' : '20px 20px', pointerEvents: 'none', zIndex: 0 }} />}
    {styleId === 'minimal-tech' && <div style={{ position: 'absolute', top: 44, left: style.layout.padding, color: colors.accent, fontSize: 17, letterSpacing: 4 }}>◈ KNOWLEDGE / {scene.type.toUpperCase()}</div>}
    {styleId === 'clean-light' && <div style={{ position: 'absolute', top: 0, left: 0, width: 22, height: '100%', background: colors.accent }} />}
    {styleId === 'academic' && <div style={{ position: 'absolute', top: 48, left: style.layout.padding, right: style.layout.padding, borderTop: `2px solid ${colors.accent}`, paddingTop: 12, color: colors.muted, fontFamily: theme.fontFamilies.heading, fontSize: 16 }}>讲义　·　{scene.title ?? '章节摘要'}</div>}
    {styleId === 'social-short' && <div style={{ position: 'absolute', top: 48, right: 70, color: colors.accent, fontSize: 22, fontWeight: 900, letterSpacing: 2 }}>要点速看 ✦</div>}
    <FitContent signature={layoutSignature} minimumScale={tableMinimumScale} onOverflow={onOverflow ? reportOverflow : undefined}><div style={{ ...box, position: 'relative', zIndex: 1, width: '100%', overflowWrap: 'anywhere', boxSizing: 'border-box', textAlign: centered ? 'center' : 'left' }}>{content}</div></FitContent>
    {caption && <div data-visual-qa-type="subtitle" data-visual-qa-target-id="subtitle" style={captionStyle}>{caption}</div>}
    {includeAudio && scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}
    {sfxTrack}
  </AbsoluteFill>;
}

function SceneView(props: Parameters<typeof SceneViewContent>[0]) {
  const { scene, styleId, stylePack, brand, visualFrameOverride } = props;
  const { fps } = useVideoConfig();
  const currentFrame = useCurrentFrame();
  const frame = visualFrameOverride ?? currentFrame;
  const theme = resolveSceneTheme({ styleId: scene.sceneStyle ?? styleId, stylePack, brand }, scene);
  const beatFrames = resolveVisualBeatTimeline(scene, fps);
  return <div
    data-visual-qa-scene={scene.id}
    data-visual-qa-bg={theme.colors.bg}
    data-visual-qa-local-frame={frame}
    data-visual-qa-beats={JSON.stringify(beatFrames)}
    style={{ position: 'absolute', inset: 0, transform: scene.visualFitScale ? 'scale(' + scene.visualFitScale + ')' : undefined, transformOrigin: 'center' }}
  ><SceneViewContent {...props} /></div>;
}

function frameCardScene(card: FrameCard, id: string, fallbackTitle: string): Scene {
  return SceneSchema.parse({ id, type: 'title', title: card.title?.trim() || fallbackTitle, narration: card.subtitle ?? '', duration: card.duration });
}

function sharedFocusLabel(from: Scene, to: Scene): string | undefined {
  const fromFocus = from.visualPlan?.keyFocus?.trim();
  const toFocus = to.visualPlan?.keyFocus?.trim();
  if (fromFocus && toFocus && fromFocus.toLocaleLowerCase() === toFocus.toLocaleLowerCase()) return fromFocus;
  const fromTargets = new Set(Object.values(from.visualPlan?.elementMap ?? {}));
  const sharedId = Object.values(to.visualPlan?.elementMap ?? {}).find(target => fromTargets.has(target));
  if (!sharedId) return undefined;
  for (const scene of [from, to]) {
    const collections = [scene.visual.items, scene.visual.data, scene.visual.nodes];
    for (const collection of collections) {
      if (!Array.isArray(collection)) continue;
      for (const item of collection) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (record.id !== sharedId) continue;
        const label = [record.label, record.text, record.title, record.name].find(value => typeof value === 'string' && value.trim());
        if (typeof label === 'string') return label.trim();
      }
    }
  }
  return undefined;
}

function SceneBackdrop({ scene, storyboard }: { scene: Scene; storyboard: Storyboard }) {
  const theme = resolveSceneTheme({ styleId: storyboard.styleId, stylePack: storyboard.stylePack, brand: storyboard.brand }, scene);
  return <AbsoluteFill style={{ backgroundColor: theme.colors.bg }} />;
}

function SceneTransitionOverlay({ storyboard, fromIndex, toIndex, startFrame, frames, fromStartFrame, transition, onOverflow }: {
  storyboard: Storyboard;
  fromIndex: number;
  toIndex: number;
  startFrame: number;
  frames: number;
  fromStartFrame: number;
  transition: Exclude<Transition, 'none' | 'fade' | 'cut'>;
  onOverflow?: (sceneId: string, overflowing: boolean) => void;
}) {
  const frame = useCurrentFrame();
  const progress = frames <= 1 ? 1 : Math.min(1, Math.max(0, frame / (frames - 1)));
  const from = storyboard.scenes[fromIndex];
  const to = storyboard.scenes[toIndex];
  if (!from || !to) return null;
  const reduced = storyboard.reducedMotion === true;
  const effect = reduced && transition !== 'crossfade' ? 'crossfade' : transition;
  const fromStyle: React.CSSProperties = { position: 'absolute', inset: 0 };
  const toStyle: React.CSSProperties = { position: 'absolute', inset: 0 };
  if (effect === 'crossfade') {
    fromStyle.opacity = 1 - progress;
    toStyle.opacity = progress;
  } else if (effect === 'wipe') {
    toStyle.clipPath = `inset(0 ${(1 - progress) * 100}% 0 0)`;
  } else if (effect === 'slide') {
    fromStyle.transform = `translateX(${-progress * 100}%)`;
    toStyle.transform = `translateX(${(1 - progress) * 100}%)`;
  } else {
    fromStyle.opacity = 1 - progress;
    toStyle.opacity = progress;
  }
  const focusLabel = (effect === 'match-move' || effect === 'shared-element-lite') ? sharedFocusLabel(from, to) : undefined;
  const fromLocalFrame = Math.max(0, startFrame - fromStartFrame + frame);
  return <AbsoluteFill style={{ zIndex: 20, overflow: 'hidden', pointerEvents: 'none' }}>
    <div data-visual-qa-transition={effect} style={fromStyle}><SceneBackdrop scene={from} storyboard={storyboard} /><SceneView scene={from} styleId={storyboard.styleId} stylePack={storyboard.stylePack} brand={storyboard.brand} subtitles={storyboard.subtitles} soundEffects={storyboard.soundEffects} reducedMotion={storyboard.reducedMotion} visualFrameOverride={fromLocalFrame} includeAudio={false} onOverflow={onOverflow} /></div>
    <div data-visual-qa-transition={effect} style={toStyle}><SceneBackdrop scene={to} storyboard={storyboard} /><SceneView scene={to} styleId={storyboard.styleId} stylePack={storyboard.stylePack} brand={storyboard.brand} subtitles={storyboard.subtitles} soundEffects={storyboard.soundEffects} reducedMotion={storyboard.reducedMotion} visualFrameOverride={frame} includeAudio={false} includeSubtitles={false} onOverflow={onOverflow} /></div>
    {focusLabel && (effect === 'match-move' || effect === 'shared-element-lite') && <div style={{ position: 'absolute', zIndex: 8, left: `${20 + 60 * progress}%`, top: `${effect === 'match-move' ? 44 : 56}%`, transform: `translate(-50%, -50%) scale(${.94 + .06 * Math.sin(progress * Math.PI)})`, maxWidth: '45%', padding: '10px 18px', borderRadius: 999, color: '#fff', background: 'rgba(16, 24, 40, .88)', border: '1px solid rgba(255,255,255,.45)', boxShadow: '0 8px 30px rgba(0,0,0,.24)', fontSize: 20, fontWeight: 700, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{focusLabel}</div>}
  </AbsoluteFill>;
}

function BrandLogoOverlay({ logo, subtitles, scene, styleId, stylePack, brand }: { logo: NonNullable<Storyboard['brand']>['logo']; subtitles: Storyboard['subtitles']; scene?: Scene; styleId: StyleId; stylePack?: StylePackId; brand: Storyboard['brand'] }) {
  const { width: videoWidth, height: videoHeight } = useVideoConfig();
  const frame = useCurrentFrame();
  const placement = brandLogoPlacement({ logo, subtitles, videoWidth, videoHeight, safeAreaRatio: stylePack ? STYLE_PACK_LOGO_SAFE_AREA_RATIO : undefined });
  if (!placement || !logo || !scene) return null;
  const theme = resolveSceneTheme({ styleId: scene.sceneStyle ?? styleId, stylePack, brand }, scene);
  const horizontal = placement.edge === 'left' ? { left: placement.edgeOffset } : { right: placement.edgeOffset };
  const vertical = placement.verticalEdge === 'top' ? { top: placement.verticalOffset } : { bottom: placement.verticalOffset };
  const beats = resolveVisualBeatTimeline(scene);
  return <div data-visual-qa-scene={scene.id} data-visual-qa-bg={theme.colors.bg} data-visual-qa-local-frame={frame} data-visual-qa-beats={JSON.stringify(beats)} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    <Img data-visual-qa-type="logo" data-visual-qa-target-id="brand-logo" src={staticFile(logo.src)} style={{ position: 'absolute', zIndex: placement.zIndex, ...horizontal, ...vertical, width: placement.width, height: 'auto', opacity: placement.opacity, objectFit: 'contain', pointerEvents: 'none' }} />
  </div>;
}

function VisualQaCapture({ enabled }: { enabled: boolean }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  useLayoutEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    const handle = delayRender('收集视觉 QA 布局证据');
    let stopped = false;
    let continued = false;
    const finish = () => {
      if (!continued) {
        continued = true;
        continueRender(handle);
      }
    };
    const measure = () => {
      if (stopped) return finish();
      const layouts: Record<string, unknown>[] = [];
      const parseColor = (value: string): [number, number, number] | null => {
        const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (hex) {
          const short = hex[1]!.length === 3 ? hex[1]!.split('').map(char => char + char).join('') : hex[1]!;
          return [parseInt(short.slice(0, 2), 16), parseInt(short.slice(2, 4), 16), parseInt(short.slice(4, 6), 16)];
        }
        const rgb = value.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
        return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
      };
      const luminance = (color: [number, number, number]) => color.map(part => {
        const channel = part / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
      const contrast = (left: string, right: string) => {
        const a = parseColor(left);
        const b = parseColor(right);
        if (!a || !b) return undefined;
        const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return Number(((values[0]! + .05) / (values[1]! + .05)).toFixed(2));
      };
      for (const root of Array.from(document.querySelectorAll<HTMLElement>('[data-visual-qa-scene]'))) {
        const sceneId = root.dataset.visualQaScene ?? '';
        const intentionalTransition = root.closest('[data-visual-qa-transition]') !== null;
        const localFrame = Number(root.dataset.visualQaLocalFrame ?? 0);
        let beats: { id: string; startFrame: number; endFrame: number }[] = [];
        try { beats = JSON.parse(root.dataset.visualQaBeats ?? '[]') as typeof beats; } catch { beats = []; }
        const activeBeat = beats.find(beat => localFrame >= beat.startFrame && localFrame < beat.endFrame);
        const seen = new Set<Element>();
        const candidates = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,li,th,td,small,strong,span,[data-target-id],[data-visual-qa-type],[data-visual-qa-overflow]');
        for (const element of Array.from(candidates)) {
          if (seen.has(element)) continue;
          seen.add(element);
          if (element.matches('[data-target-id]') && element.querySelector('h1,h2,h3,h4,p,li,th,td,small,strong,span,[data-target-id]')) continue;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          let opacity = Number(style.opacity || 1);
          let ancestor = element.parentElement;
          while (ancestor) {
            opacity *= Number(getComputedStyle(ancestor).opacity || 1);
            if (ancestor.hasAttribute('data-visual-qa-frame')) break;
            ancestor = ancestor.parentElement;
          }
          if (opacity < .03 || rect.width < 1 || rect.height < 1 || style.visibility === 'hidden' || style.display === 'none') continue;
          const explicitType = element.dataset.visualQaType;
          const elementType = explicitType === 'subtitle' || explicitType === 'logo'
            ? explicitType
            : element.hasAttribute('data-visual-qa-overflow') || !element.textContent?.trim() ? 'visual' : 'text';
          const foreground = style.color;
          const background = root.dataset.visualQaBg ?? '';
          const targetId = element.dataset.visualQaTargetId ?? element.dataset.targetId ?? undefined;
          const x = rect.left / width;
          const y = rect.top / height;
          const w = rect.width / width;
          const h = rect.height / height;
          let renderedScale = 1;
          let scaleNode: HTMLElement | null = element;
          while (scaleNode && scaleNode !== root.parentElement) {
            const transform = getComputedStyle(scaleNode).transform;
            if (transform !== 'none') {
              try {
                const matrix = new DOMMatrixReadOnly(transform);
                renderedScale *= Math.hypot(matrix.a, matrix.b);
              } catch { /* Keep the measured CSS font size if the browser cannot parse a transform. */ }
            }
            if (scaleNode === root) break;
            scaleNode = scaleNode.parentElement;
          }
          layouts.push({
            sceneId,
            ...(activeBeat ? { beatId: activeBeat.id } : {}),
            ...(targetId ? { targetId } : {}),
            frame,
            elementType,
            bounds: { x, y, width: w, height: h },
            ...(elementType === 'text' && Number.isFinite(parseFloat(style.fontSize)) ? { fontSizePx: Number((parseFloat(style.fontSize) * renderedScale).toFixed(2)) } : {}),
            ...(elementType === 'text' && targetId && /^hero-copy-\d+$/u.test(targetId) ? { textContent: (element.textContent ?? '').slice(0, 1200) } : {}),
            ...(elementType === 'text' && contrast(foreground, background) !== undefined ? { contrastRatio: contrast(foreground, background) } : {}),
            overflow: !intentionalTransition && (element.dataset.visualQaOverflow === 'true' || rect.left < -1 || rect.top < -1 || rect.right > width + 1 || rect.bottom > height + 1),
          });
        }
      }
      const backgrounds = [...new Set(Array.from(document.querySelectorAll<HTMLElement>('[data-visual-qa-scene]'))
        .map(root => root.dataset.visualQaBg)
        .filter((color): color is string => Boolean(color)))];
      console.info('__M2V_VISUAL_QA__' + JSON.stringify({ frame, width, height, backgrounds, layout: layouts }));
      finish();
    };
    const imagesReady = Promise.all(Array.from(document.images).map(async image => {
      if (!image.complete) {
        await new Promise<void>(resolve => {
          const done = () => resolve();
          image.addEventListener('load', done, { once: true });
          image.addEventListener('error', done, { once: true });
        });
      }
      if (image.complete && image.naturalWidth > 0 && typeof image.decode === 'function') {
        try { await image.decode(); } catch { /* A broken or replaced image should not block QA capture. */ }
      }
    }));
    // A font/image readiness rejection must not silently skip the QA marker:
    // the scene can still be measured with the browser's fallback font/layout.
    void Promise.allSettled([document.fonts.ready, imagesReady])
      .then(() => requestAnimationFrame(() => requestAnimationFrame(measure)));
    return () => {
      stopped = true;
      finish();
    };
  }, [enabled, frame, height, width]);
  return null;
}

export function ExplainerVideo({ storyboard, onOverflow, visualQaCapture = false }: { storyboard: Storyboard; onOverflow?: (sceneId: string, overflowing: boolean) => void; visualQaCapture?: boolean }) {
  const globalFrame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { segments } = timelineFrames(storyboard, fps);
  const transitionWindows = sceneTransitionWindows(storyboard, fps);
  const music = storyboard.bgmEnabled !== false ? storyboard.bgmSrc : undefined;
  const soundSettings = SoundEffectsSettingsSchema.parse(storyboard.soundEffects ?? {});
  const totalFrames = getDurationInFrames(storyboard, fps);
  const fadeInFrames = Math.round((storyboard.bgmFadeIn ?? 1) * fps);
  const fadeOutFrames = Math.round((storyboard.bgmFadeOut ?? 1) * fps);
  const baseVolume = storyboard.bgmVolume ?? 0.12;
  const soundActivityWindows = soundSettings.enabled ? segments.flatMap(segment => {
    if (segment.kind !== 'scene') return [];
    const scene = storyboard.scenes[segment.index];
    if (!scene || scene.visualStaticFallback) return [];
    const windows: { startFrame: number; endFrame: number }[] = [];
    if (scene.audioSrc) windows.push({ startFrame: segment.startFrame, endFrame: segment.startFrame + Math.round((scene.audioDuration ?? scene.duration ?? 0) * fps) });
    if (scene.sfxCues?.length) windows.push(...resolveSfxCueInstances(scene, scene.sfxCues, fps).map(cue => ({ startFrame: segment.startFrame + cue.startFrame, endFrame: segment.startFrame + cue.startFrame + cue.durationFrames })));
    return windows;
  }) : [];
  const volume = (frame: number) => resolveBgmFrameGain({
    frame,
    totalFrames,
    baseVolume,
    fadeInFrames,
    fadeOutFrames,
    duckGain: resolveAudioDuckGain(frame, soundActivityWindows, 1 - soundSettings.bgmDuck),
  });
  const introSegment = segments.find(segment => segment.kind === 'intro');
  const outroSegment = segments.find(segment => segment.kind === 'outro');
  const sceneSegments = segments.filter(segment => segment.kind === 'scene');
  const intro = storyboard.intro?.enabled ? storyboard.intro : null;
  const outro = storyboard.outro?.enabled ? storyboard.outro : null;
  return <AbsoluteFill data-visual-qa-frame={globalFrame} style={{ backgroundColor: '#000' }}>
    {music && <Audio src={staticFile(music)} volume={volume} loop loopVolumeCurveBehavior="extend" />}
    {introSegment && intro && <Sequence from={introSegment.startFrame} durationInFrames={introSegment.frames}><SceneBackdrop scene={frameCardScene(intro, 'intro', storyboard.title)} storyboard={storyboard} /><SceneView scene={frameCardScene(intro, 'intro', storyboard.title)} styleId={storyboard.styleId} stylePack={storyboard.stylePack} brand={storyboard.brand} subtitles={storyboard.subtitles} soundEffects={storyboard.soundEffects} transition={storyboard.transition} durationInFrames={introSegment.frames} reducedMotion={storyboard.reducedMotion} onOverflow={onOverflow} /></Sequence>}
    {storyboard.scenes.map((scene, index) => { const segment = sceneSegments[index]; return <Sequence key={scene.id} from={segment.startFrame} durationInFrames={segment.frames}><SceneBackdrop scene={scene} storyboard={storyboard} /><SceneView scene={scene} styleId={storyboard.styleId} stylePack={storyboard.stylePack} brand={storyboard.brand} subtitles={storyboard.subtitles} soundEffects={storyboard.soundEffects} transition={storyboard.transition === 'fade' ? 'fade' : 'none'} durationInFrames={segment.frames} reducedMotion={storyboard.reducedMotion} onOverflow={onOverflow} /></Sequence>; })}
    {transitionWindows.map(window => <Sequence key={`transition-${window.fromIndex}-${window.toIndex}`} from={window.startFrame} durationInFrames={window.frames}><SceneTransitionOverlay storyboard={storyboard} fromIndex={window.fromIndex} toIndex={window.toIndex} startFrame={window.startFrame} frames={window.frames} fromStartFrame={window.fromStartFrame} transition={window.transition} onOverflow={onOverflow} /></Sequence>)}
    {outroSegment && outro && <Sequence from={outroSegment.startFrame} durationInFrames={outroSegment.frames}><SceneBackdrop scene={frameCardScene(outro, 'outro', storyboard.title)} storyboard={storyboard} /><SceneView scene={frameCardScene(outro, 'outro', storyboard.title)} styleId={storyboard.styleId} stylePack={storyboard.stylePack} brand={storyboard.brand} subtitles={storyboard.subtitles} soundEffects={storyboard.soundEffects} transition={storyboard.transition} durationInFrames={outroSegment.frames} reducedMotion={storyboard.reducedMotion} onOverflow={onOverflow} /></Sequence>}
    <BrandLogoOverlay logo={storyboard.brand?.logo} subtitles={storyboard.subtitles} scene={storyboard.scenes[0]} styleId={storyboard.styleId} stylePack={storyboard.stylePack} brand={storyboard.brand} />
    <VisualQaCapture enabled={visualQaCapture} />
  </AbsoluteFill>;
}

export const getDurationInFrames = (storyboard: Storyboard, fps = 30) => timelineFrames(storyboard, fps).totalFrames;
