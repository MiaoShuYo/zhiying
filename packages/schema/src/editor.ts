import type { Scene, Storyboard } from './index';

export const sceneSeconds = (scene: Scene) => Math.max(3, scene.duration ?? 6, scene.audioDuration ?? 0) + (scene.sceneGap ?? 0);
export const templates: { name: string; scene: Omit<Scene, 'id'> }[] = [
  { name: '章节标题', scene: { type: 'title', title: '章节标题', narration: '在这里介绍本章内容。', visual: {}, layout: 'auto' } },
  { name: '正文文本', scene: { type: 'text', title: '补充说明', narration: '在这里补充讲解内容。', visual: { text: '在这里填写画面正文。' }, layout: 'auto' } },
  { name: '核心要点', scene: { type: 'bullets', title: '核心要点', narration: '逐一讲解以下要点。', visual: { items: ['要点一', '要点二', '要点三'] }, layout: 'stack' } },
  { name: '两层要点', scene: { type: 'bullets', title: '核心要点', narration: '先说明各个重点，再展开对应细节。', visual: { items: [{ text: '一级要点一', children: ['对应说明一', '对应说明二'] }, { text: '一级要点二', children: ['补充细节'] }] }, layout: 'stack' } },
  { name: '方案对比', scene: { type: 'comparison', title: '方案对比', narration: '比较两个方案的特点。', visual: { columns: [{ title: '方案 A', items: ['特点一'] }, { title: '方案 B', items: ['特点二'] }] }, layout: 'auto' } },
  { name: '时间线', scene: { type: 'timeline', title: '发展历程', narration: '回顾关键节点。', visual: { items: [{ date: '阶段一', label: '起步' }, { date: '阶段二', label: '发展' }] }, layout: 'auto' } },
];

export function layoutMetrics(scene: Scene, portrait: boolean) {
  const text = scene.type === 'title' ? scene.narration : scene.type === 'text' ? String(scene.visual.text ?? '') : JSON.stringify(scene.visual);
  const size = [...text].length;
  const limit = portrait ? 330 : 500;
  const density = Math.max(0.85, Math.min(scene.layout === 'compact' ? .85 : 1, Math.sqrt(limit / Math.max(limit, size))));
  const warnings: string[] = [];
  if (size > limit) warnings.push('画面文字较密，建议拆成多个场景或缩短正文。');
  if ((scene.title?.length ?? 0) > (portrait ? 22 : 36)) warnings.push('标题较长，请检查换行。');
  if (scene.type === 'code' && String(scene.visual.code ?? '').split('\n').length > (portrait ? 24 : 18)) warnings.push('代码行数可能超出画面。');
  if (scene.duration && scene.audioDuration && scene.duration < scene.audioDuration) warnings.push('时长短于旁白，实际播放将延长至旁白结束。');
  return { density, warnings, stacked: scene.layout === 'stack' || (portrait && scene.layout !== 'columns') };
}

export function cloneScene(scene: Scene): Scene { return { ...structuredClone(scene), id: crypto.randomUUID() }; }
export function storyboardWarnings(storyboard: Storyboard) { return storyboard.scenes.flatMap((scene, index) => layoutMetrics(scene, storyboard.aspectRatio === '9:16').warnings.map(message => ({ sceneId: scene.id, index, message }))); }
