import React from 'react';
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Scene, Storyboard } from '@m2v/schema';
import { styles } from '@m2v/styles';

const palette = (dark: boolean) => dark ? { bg: '#0b1020', fg: '#f8fafc', muted: '#a7b4cc', accent: '#57d7c2', card: '#151e32' } : { bg: '#f6f8fc', fg: '#111827', muted: '#596579', accent: '#3267e8', card: '#ffffff' };

function SceneView({ scene, dark }: { scene: Scene; dark: boolean }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const colors = palette(dark);
  const opacity = interpolate(frame, [0, Math.min(16, fps / 2)], [0, 1], { extrapolateRight: 'clamp' });
  const box: React.CSSProperties = { borderRadius: 24, padding: 42, background: colors.card, border: `1px solid ${dark ? '#26334c' : '#e1e7f0'}` };
  const title = <h1 style={{ fontSize: 55, lineHeight: 1.12, margin: '0 0 24px', color: colors.fg }}>{scene.title ?? scene.type.toUpperCase()}</h1>;
  let content: React.ReactNode;
  switch (scene.type) {
    case 'title': content = <div style={{ textAlign: 'center' }}>{title}<p style={{ color: colors.muted, fontSize: 32 }}>{scene.narration}</p></div>; break;
    case 'bullets': content = <div>{title}<ul style={{ color: colors.fg, fontSize: 34, lineHeight: 1.7 }}>{(scene.visual.items as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul></div>; break;
    case 'comparison': content = <div>{title}<div style={{ display: 'flex', gap: 24 }}>{(scene.visual.columns as { title?: string; items?: string[] }[]).map((col, i) => <div key={i} style={{ ...box, flex: 1 }}><h2>{col.title ?? `选项 ${i + 1}`}</h2>{(col.items ?? []).map((x, j) => <p key={j} style={{ fontSize: 25 }}>{x}</p>)}</div>)}</div></div>; break;
    case 'chart': { const data = scene.visual.data as { label: string; value: number }[]; const max = Math.max(...data.map(x => x.value), 1); content = <div>{title}<div style={{ display: 'flex', alignItems: 'end', gap: 22, height: 340 }}>{data.map((x, i) => <div key={i} style={{ flex: 1, textAlign: 'center', color: colors.muted }}><div style={{ height: `${Math.max(8, 280 * x.value / max)}px`, background: colors.accent, borderRadius: '12px 12px 0 0' }} /><b style={{ color: colors.fg }}>{x.label}</b></div>)}</div></div>; break; }
    case 'code': content = <div>{title}<pre style={{ ...box, whiteSpace: 'pre-wrap', fontSize: 26, color: colors.accent }}>{String(scene.visual.code ?? scene.narration)}</pre></div>; break;
    case 'diagram': { const nodes = (scene.visual.nodes as { id: string; label: string }[] | undefined) ?? []; content = <div>{title}<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, flexWrap: 'wrap' }}>{nodes.map((node, i) => <React.Fragment key={node.id}><div style={{ ...box, color: colors.fg, fontSize: 28 }}>{node.label}</div>{i < nodes.length - 1 && <span style={{ color: colors.accent, fontSize: 40 }}>→</span>}</React.Fragment>)}</div></div>; break; }
  }
  return <AbsoluteFill style={{ opacity, backgroundColor: colors.bg, color: colors.fg, padding: 92, justifyContent: 'center', fontFamily: 'Arial, sans-serif' }}><div style={{ position: 'absolute', top: 38, left: 92, color: colors.accent, fontSize: 18, letterSpacing: 3 }}>LOCAL AI EXPLAINER</div>{content}<p style={{ position: 'absolute', bottom: 38, color: colors.muted, fontSize: 18 }}>{scene.narration}</p>{scene.audioSrc && <Audio src={staticFile(scene.audioSrc)} />}</AbsoluteFill>;
}

export function ExplainerVideo({ storyboard }: { storyboard: Storyboard }) {
  const { fps } = useVideoConfig();
  const style = styles[storyboard.styleId];
  let cursor = 0;
  return <AbsoluteFill>{storyboard.scenes.map((scene) => { const duration = Math.max(90, Math.round((scene.duration ?? 6) * fps)); const from = cursor; cursor += duration; return <Sequence key={scene.id} from={from} durationInFrames={duration}><SceneView scene={scene} dark={style.visual.mode === 'dark'} /></Sequence>; })}</AbsoluteFill>;
}

export const getDurationInFrames = (storyboard: Storyboard, fps = 30) => storyboard.scenes.reduce((sum, scene) => sum + Math.max(90, Math.round((scene.duration ?? 6) * fps)), 0);
