import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { StoryboardSchema, type Scene, type Storyboard } from '@m2v/schema';
import { db } from './db';

function fallbackStoryboard(title: string, text: string, styleId: string): Storyboard {
  const chunks = text.split(/(?<=[。！？.!?])\s*/).map(x => x.trim()).filter(Boolean);
  const intro: Scene = { id: randomUUID(), type: 'title', title, narration: chunks[0] ?? title, duration: 6, visual: {} };
  const bullets = chunks.slice(1, 6).length ? chunks.slice(1, 6) : [text.slice(0, 100)];
  return StoryboardSchema.parse({ title, styleId, aspectRatio: '16:9', scenes: [intro, { id: randomUUID(), type: 'bullets', title: '核心内容', narration: bullets.join('。'), duration: Math.max(8, bullets.length * 3), visual: { items: bullets } }] });
}

async function extractText(file: File | null, rawText: string) {
  if (!file) return { text: rawText, path: null as string | null };
  const fileName = file.name.toLowerCase();
  if (fileName.endsWith('.md') || fileName.endsWith('.markdown')) {
    if (file.size > 5 * 1024 * 1024) throw new Error('Markdown 文件不能超过 5 MB');
    const text = (await file.text()).replace(/^\uFEFF/, '');
    if (!text.trim()) throw new Error('Markdown 文件内容为空');
    return { text, path: null as string | null };
  }
  if (!fileName.endsWith('.pdf')) throw new Error('目前支持 PDF、Markdown 文件或直接输入文本');
  const form = new FormData(); form.set('file', file);
  const service = process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000';
  try {
    const response = await fetch(`${service}/extract/pdf`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json() as { text: string };
    if (result.text.trim()) return { text: result.text, path: null };
  } catch { /* Use PyMuPDF through Python when available; report fallback below. */ }
  throw new Error('PDF 解析服务不可用。请先启动 services/python，或暂时使用文本输入。');
}

async function ollamaStoryboard(title: string, text: string, styleId: string): Promise<Storyboard> {
  const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL ?? 'qwen3:4b';
  const prompt = `根据资料生成简体中文知识视频分镜。仅返回符合 JSON Schema 的 JSON 对象，不输出 Markdown。顶层字段 title,aspectRatio="16:9",styleId="${styleId}",scenes。scene type 只能是 title,bullets,diagram,comparison,chart,code；每场有 id,type,title,narration,duration,visual。bullets visual.items 为 1-5 条；comparison visual.columns 恰好两列；chart visual.data 为 label/value 数组；diagram visual.nodes 为 id/label 数组；code visual.code 为字符串。最多 10 场。主题：${title}\n资料：${text.slice(0, 18000)}\n/no_think`;
  const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: false, format: 'json', options: { num_predict: 4096 }, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`Ollama 请求失败 (${response.status})`);
  const result = await response.json() as { message?: { content?: string } };
  if (!result.message?.content) throw new Error('Ollama 返回内容为空');
  const parsed = StoryboardSchema.safeParse(JSON.parse(result.message.content));
  if (!parsed.success) throw new Error(`模型生成的分镜未通过校验：${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export async function createProject(input: { name: string; text: string; styleId: string; file: File | null; preferLocalAI?: boolean }) {
  const extension = input.file ? extname(input.file.name).toLowerCase() : '';
  if (input.file && !['.pdf', '.md', '.markdown'].includes(extension)) throw new Error('目前支持 PDF、Markdown 文件或直接输入文本');
  const project = await db.project.create({ data: { name: input.name || '未命名视频', sourceText: input.file ? '' : input.text, styleId: input.styleId, status: 'extracting' } });
  let sourcePath: string | null = null;
  if (input.file) {
    const relativePath = `data/projects/${project.id}/source${extension}`;
    const sourceRoot = resolve(process.cwd(), '../..');
    const targetPath = resolve(sourceRoot, relativePath);
    await mkdir(resolve(targetPath, '..'), { recursive: true });
    await writeFile(targetPath, new Uint8Array(await input.file.arrayBuffer()));
    sourcePath = relativePath;
    await db.project.update({ where: { id: project.id }, data: { sourcePath } });
  }
  await db.job.create({ data: { projectId: project.id, kind: 'storyboard', status: 'queued', stage: 'extracting' } });
  return { ...project, sourcePath };
}

export type ProjectStage = 'extracting' | 'analyzing' | 'storyboarding';

export async function processProject(projectId: string, startAt: ProjectStage = 'extracting', preferLocalAI = false) {
  const job = await db.job.findFirstOrThrow({ where: { projectId, kind: 'storyboard' }, orderBy: { createdAt: 'desc' } });
  try {
    const current = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    await db.job.update({ where: { id: job.id }, data: { status: 'running', stage: startAt } });
    let sourceText = current.sourceText;
    if (startAt === 'extracting') {
      let sourceFile: File | null = null;
      if (current.sourcePath) {
        const sourcePath = resolve(process.cwd(), '../..', current.sourcePath);
        const bytes = await readFile(sourcePath);
        const fileName = basename(sourcePath);
        sourceFile = new File([new Uint8Array(bytes)], fileName, { type: fileName.endsWith('.pdf') ? 'application/pdf' : 'text/markdown' });
      }
      const extracted = await extractText(sourceFile, sourceText);
      sourceText = extracted.text;
      await db.project.update({ where: { id: projectId }, data: { sourceText, status: 'analyzing' } });
      await db.job.update({ where: { id: job.id }, data: { stage: 'analyzing' } });
    }
    if (sourceText.trim().length < 30) throw new Error('没有可用于继续处理的源文本，请从头重新执行或重新导入资料');
    const project = await db.project.update({ where: { id: projectId }, data: { status: startAt === 'storyboarding' ? 'storyboarding' : 'analyzing' } });
    if (startAt === 'storyboarding') await db.job.update({ where: { id: job.id }, data: { stage: 'storyboarding' } });
    let storyboard: Storyboard;
    try { storyboard = await ollamaStoryboard(project.name, sourceText, project.styleId); }
    catch (error) {
      if (preferLocalAI) throw error;
      storyboard = fallbackStoryboard(project.name, sourceText, project.styleId);
    }
    await db.project.update({ where: { id: projectId }, data: { status: 'storyboarding' } });
    await db.job.update({ where: { id: job.id }, data: { stage: 'storyboarding' } });
    storyboard = StoryboardSchema.parse(storyboard);
    await db.$transaction([
      db.scene.deleteMany({ where: { projectId: project.id } }),
      ...storyboard.scenes.map((s, i) => db.scene.create({ data: { id: s.id, projectId: project.id, orderIndex: i, type: s.type, title: s.title, narration: s.narration, duration: s.duration, visualJson: JSON.stringify(s.visual), animationJson: s.animation, styleOverrideJson: s.styleOverride ? JSON.stringify(s.styleOverride) : null } })),
      db.project.update({ where: { id: projectId }, data: { status: 'awaiting_review', storyboardJson: JSON.stringify(storyboard) } }),
      db.job.update({ where: { id: job.id }, data: { status: 'completed', stage: 'awaiting_review' } }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成失败';
    await db.$transaction([db.project.update({ where: { id: projectId }, data: { status: 'failed' } }), db.job.update({ where: { id: job.id }, data: { status: 'failed', error: message } })]);
  }
}

export function toPublicAudioSrc(audioPath: string | null | undefined) {
  if (!audioPath) return undefined;
  if (/^audio[\\/]/i.test(audioPath)) return audioPath.replace(/\\/g, '/');
  const audioRoot = resolve(process.cwd(), 'public', 'audio');
  const resolvedAudioPath = resolve(audioPath);
  const relativeAudioPath = relative(audioRoot, resolvedAudioPath);
  if (!relativeAudioPath || isAbsolute(relativeAudioPath) || relativeAudioPath === '..' || relativeAudioPath.startsWith(`..${sep}`)) return undefined;
  return `audio/${relativeAudioPath.split(sep).join('/')}`;
}

export function parseProject<T extends { storyboardJson: string | null; scenes: { id: string; type: string; title: string | null; narration: string; visualJson: string; duration: number | null; animationJson: string | null; styleOverrideJson: string | null; orderIndex: number; audioPath?: string | null }[] }>(project: T) {
  const storyboard = project.storyboardJson ? JSON.parse(project.storyboardJson) as Storyboard : null;
    return { ...project, storyboard: storyboard ? { ...storyboard, scenes: project.scenes.map(s => ({ id: s.id, type: s.type, title: s.title ?? undefined, narration: s.narration, duration: s.duration ?? undefined, audioSrc: toPublicAudioSrc(s.audioPath), visual: JSON.parse(s.visualJson), animation: s.animationJson ?? undefined, styleOverride: s.styleOverrideJson ? JSON.parse(s.styleOverrideJson) : undefined })) } : null };
}

export async function saveStoryboard(projectId: string, storyboard: unknown) {
  const parsed = StoryboardSchema.parse(storyboard);
  await db.$transaction([
    db.scene.deleteMany({ where: { projectId } }),
    ...parsed.scenes.map((s, i) => db.scene.upsert({ where: { id: s.id }, create: { id: s.id, projectId, orderIndex: i, type: s.type, title: s.title, narration: s.narration, duration: s.duration, visualJson: JSON.stringify(s.visual), animationJson: s.animation, styleOverrideJson: s.styleOverride ? JSON.stringify(s.styleOverride) : null, audioPath: s.audioSrc }, update: { orderIndex: i, type: s.type, title: s.title, narration: s.narration, duration: s.duration, visualJson: JSON.stringify(s.visual), animationJson: s.animation, styleOverrideJson: s.styleOverride ? JSON.stringify(s.styleOverride) : null, audioPath: s.audioSrc } })),
    db.project.update({ where: { id: projectId }, data: { styleId: parsed.styleId, storyboardJson: JSON.stringify(parsed), status: 'awaiting_review' } }),
  ]);
  return parsed;
}

export async function regenerateScene(projectId: string, sceneId: string) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const storyboard = StoryboardSchema.parse(JSON.parse(project.storyboardJson ?? '{}'));
  const old = storyboard.scenes.find(s => s.id === sceneId);
  if (!old) throw new Error('场景不存在');
  const prompt = `请重新设计这一个讲解视频场景，只返回 JSON，不要 Markdown。JSON 对象必须包含 id,type,title,narration,duration,visual，字段约束 type=${old.type}。保持主题和事实准确，旁白简洁。旧场景：${JSON.stringify(old)}\n参考资料：${project.sourceText.slice(0, 6000)}\n/no_think`;
  const response = await fetch(`${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.OLLAMA_MODEL ?? 'qwen3:4b', stream: false, format: 'json', options: { num_predict: 2048 }, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`Ollama 请求失败 (${response.status})`);
  const result = await response.json() as { message?: { content?: string } };
  const candidate = JSON.parse(result.message?.content ?? '{}');
  const next = { ...old, ...candidate, id: old.id, type: old.type, audioSrc: undefined };
  const updated = StoryboardSchema.parse({ ...storyboard, scenes: storyboard.scenes.map(s => s.id === old.id ? next : s) });
  return saveStoryboard(projectId, updated);
}
