import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, copyFile, rm, stat, open, rename } from 'node:fs/promises';
import { resolve, join, relative, sep, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PER_JOB_VIDEO, SHARED_VIDEO, sharedVideoOwner } from './job-video';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from './db';
import { StoryboardSchema } from '@m2v/schema';

const repo = resolve(process.cwd(), '../..');
const root = join(repo, 'data/backups');
const publicRoot = join(repo, 'apps/web/public');
const safeId = (id: string) => { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('无效 ID'); return id; };
const inside = (base: string, path: string) => { if (typeof path !== 'string' || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new Error('备份路径无效'); const target = resolve(base, path); const rel = relative(base, target); if (!rel || rel.startsWith('..') || rel.includes(':') || rel.startsWith(sep)) throw new Error('备份路径无效'); return target; };
// Windows reports EPERM for a directory rename while a scanner or editor still holds
// a handle on a freshly written file inside it, so a snapshot used to fail intermittently.
const renameWithRetry = async (from: string, to: string) => {
  for (let attempt = 1; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (attempt >= 5 || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await new Promise(done => setTimeout(done, attempt * 100));
    }
  }
};
// Automatic snapshots rotate out after RETAIN_UNLOCKED newer unlocked copies.
// Locked snapshots are never deleted, so their own count is capped instead.
const RETAIN_UNLOCKED = 10;
const LOCKED_LIMIT = 30;
const jobKinds = ['storyboard', 'render', 'tts'];
type Entry = { path: string; size: number; sha256: string };
type Manifest = { version: 1; id: string; createdAt: string; locked: boolean; project: { id: string; name: string; sourceText: string; sourcePath: string | null; styleId: string; aspectRatio: string; importMode: string; assetsJson: string; storyboardJson: string | null; voiceId: string | null }; jobs: { kind: string; status: string; stage: string; outputPath: string | null; inputJson: string | null; error: string | null; createdAt: string }[]; files: Entry[] };
const digest = async (path: string) => { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); };
async function tree(directory: string, prefix: string): Promise<{ source: string; path: string }[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const result: { source: string; path: string }[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('备份不支持符号链接');
    if (entry.name.endsWith('.partial.mp4')) continue;
    const source = join(directory, entry.name), path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await tree(source, path)); else if (entry.isFile()) result.push({ source, path });
  }
  return result;
}
export async function listSnapshots(projectId: string) {
  const directory = join(root, safeId(projectId));
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const result: { id: string; createdAt: string; locked: boolean; bytes: number }[] = [];
  for (const entry of entries.filter(item => item.isDirectory() && !item.name.startsWith('.'))) {
    const manifest = JSON.parse(await readFile(join(directory, entry.name, 'manifest.json'), 'utf8')) as Manifest;
    result.push({ id: entry.name, createdAt: manifest.createdAt, locked: manifest.locked, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0) });
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
const pending = new Map<string, Promise<string | null>>();
export function createSnapshot(projectId: string, automatic = false): Promise<string | null> {
  const existing = pending.get(projectId); if (existing) return existing;
  const task = snapshot(projectId, automatic).finally(() => pending.delete(projectId)); pending.set(projectId, task); return task;
}
async function snapshot(projectId: string, automatic: boolean) {
  safeId(projectId);
  const previous = await listSnapshots(projectId);
  // The 5 minute window measures the automatic cadence only: a freshly locked
  // manual snapshot must not postpone the next automatic one.
  const lastUnlocked = previous.find(item => !item.locked);
  if (automatic && lastUnlocked && Date.now() - Date.parse(lastUnlocked.createdAt) < 300_000) return null;
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, include: { jobs: true } });
  if (automatic && previous[0] && project.updatedAt.getTime() <= Date.parse(previous[0].createdAt)) return null;
  if (project.jobs.some(job => ['queued', 'running', 'cancelling'].includes(job.status))) { if (automatic) return null; throw new Error('请等待任务结束后备份'); }
  const id = randomUUID(), directory = join(root, projectId, `.${id}`), final = join(root, projectId, id);
  await mkdir(directory, { recursive: true });
  try {
    const sources = await tree(join(repo, 'data/projects', projectId), 'project');
    const audioFiles = (await readdir(join(publicRoot, 'audio')).catch(() => [])).filter(name => name.startsWith(`${projectId}-`));
    sources.push(...audioFiles.map(name => ({ source: join(publicRoot, 'audio', name), path: `public/audio/${name}` })));
    const storyboard = project.storyboardJson ? StoryboardSchema.parse(JSON.parse(project.storyboardJson)) : null;
    for (const path of new Set(storyboard?.scenes.map(scene => scene.audioSrc).filter((path): path is string => Boolean(path)) ?? [])) {
      if (!/^audio\/[^/\\]+$/.test(path)) throw new Error('项目音频路径无效');
      if (!sources.some(item => item.path === `public/${path}`)) sources.push({ source: inside(publicRoot, path), path: `public/${path}` });
    }
    let voiceId = project.voiceId;
    if (!voiceId) { try { voiceId = JSON.parse(await readFile(join(repo, 'data/settings/general-voice.json'), 'utf8')).voiceId; } catch { /* No voice selected. */ } }
    if (voiceId) sources.push(...await tree(join(repo, 'data/voices', safeId(voiceId)), 'voice'));
    try { await copyFile(join(repo, 'data/settings/pronunciation.json'), join(directory, 'pronunciation.json')); sources.push({ source: join(directory, 'pronunciation.json'), path: 'settings/pronunciation.json' }); } catch { /* No global rules. */ }
    const files: Entry[] = [];
    for (const item of sources) {
      const target = inside(join(directory, 'files'), item.path); await mkdir(resolve(target, '..'), { recursive: true }); await copyFile(item.source, target);
      files.push({ path: item.path, size: (await stat(target)).size, sha256: await digest(target) });
    }
    if ((await db.project.findUniqueOrThrow({ where: { id: projectId } })).revision !== project.revision) throw new Error('备份期间项目发生修改，请重新创建快照');
    const { jobs, ...record } = project;
    // The manifest records who owns a legacy shared final.mp4, so a restored project keeps
    // exactly one downloadable record instead of handing the same file to every record.
    const sharedOwner = files.some(file => file.path === `project/output/${SHARED_VIDEO}`) ? sharedVideoOwner(jobs) : null;
    const manifest: Manifest = { version: 1, id, createdAt: new Date().toISOString(), locked: false, project: { ...record, voiceId: voiceId ?? null }, jobs: jobs.map(job => ({ kind: job.kind, status: job.status, stage: job.stage, outputPath: job.id === sharedOwner ? SHARED_VIDEO : job.outputPath, inputJson: job.inputJson, error: job.error, createdAt: job.createdAt.toISOString() })), files };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest)); await renameWithRetry(directory, final);
    const snapshots = await listSnapshots(projectId);
    for (const old of snapshots.filter(item => !item.locked).slice(RETAIN_UNLOCKED)) await rm(join(root, projectId, safeId(old.id)), { recursive: true, force: true });
    return id;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
export async function lockSnapshot(projectId: string, snapshotId: string, locked: boolean) {
  const path = join(root, safeId(projectId), safeId(snapshotId), 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest;
  if (locked && !manifest.locked && (await listSnapshots(projectId)).filter(item => item.locked).length >= LOCKED_LIMIT) throw new Error(`锁定快照已达上限（${LOCKED_LIMIT} 份），请先解除部分快照的锁定`);
  manifest.locked = locked;
  await writeFile(path + '.tmp', JSON.stringify(manifest)); await rename(path + '.tmp', path);
}
/** Re-reads every file a snapshot claims to hold and reports the ones that no longer match. */
export async function verifySnapshot(projectId: string, snapshotId: string) {
  const directory = join(root, safeId(projectId), safeId(snapshotId));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest;
  const missing: string[] = [], mismatched: string[] = [];
  let bytes = 0;
  for (const file of manifest.files) {
    let target: string;
    try { target = inside(join(directory, 'files'), file.path); } catch { missing.push(file.path); continue; }
    let size: number;
    try { size = (await stat(target)).size; } catch { missing.push(file.path); continue; }
    if (size !== file.size) { mismatched.push(file.path); continue; }
    if (await digest(target) !== file.sha256) mismatched.push(file.path); else bytes += file.size;
  }
  return { id: snapshotId, ok: !missing.length && !mismatched.length, checked: manifest.files.length, bytes, missing, mismatched };
}

export async function snapshotResponse(projectId: string, snapshotId: string) {
  const directory = join(root, safeId(projectId), safeId(snapshotId));
  const raw = await readFile(join(directory, 'manifest.json'));
  const manifest = JSON.parse(raw.toString()) as Manifest;
  const prefix = Buffer.alloc(12); prefix.write('M2VBK001'); prefix.writeUInt32BE(raw.length, 8);
  async function* content() { yield prefix; yield raw; for (const file of manifest.files) { for await (const chunk of createReadStream(inside(join(directory, 'files'), file.path))) yield chunk; } }
  return new Response(Readable.toWeb(Readable.from(content())) as ReadableStream, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="project-${projectId}.m2v"` } });
}
export async function importBackup(request: Request) {
  if (!request.body) throw new Error('备份文件为空');
  const staging = join(root, `.import-${randomUUID()}`); await mkdir(staging, { recursive: true });
  const archive = join(staging, 'upload.m2v');
  try {
    await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), createWriteStream(archive));
    const handle = await open(archive, 'r');
    try {
      const prefix = Buffer.alloc(12); await handle.read(prefix, 0, 12, 0);
      if (prefix.subarray(0, 8).toString() !== 'M2VBK001') throw new Error('不是知影 V1.1 项目包');
      const length = prefix.readUInt32BE(8); if (length > 20 * 1024 * 1024) throw new Error('备份清单过大');
      const raw = Buffer.alloc(length); if ((await handle.read(raw, 0, length, 12)).bytesRead !== length) throw new Error('备份不完整');
      const manifest = JSON.parse(raw.toString()) as Manifest;
      if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 100_000) throw new Error('不支持的备份格式');
      let offset = 12 + length; const names = new Set<string>();
      for (const file of manifest.files) {
        if (typeof file.path !== 'string' || names.has(file.path.toLowerCase()) || !/^(project|public\/audio|voice|settings)\//.test(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('备份清单无效');
        names.add(file.path.toLowerCase()); const target = inside(join(staging, 'files'), file.path); await mkdir(resolve(target, '..'), { recursive: true });
        if (file.size) await pipeline(createReadStream(archive, { start: offset, end: offset + file.size - 1 }), createWriteStream(target)); else await writeFile(target, '');
        if ((await stat(target)).size !== file.size || await digest(target) !== file.sha256) throw new Error(`备份损坏：${file.path}`);
        offset += file.size;
      }
      if (offset !== (await stat(archive)).size) throw new Error('备份长度不匹配');
      return await restoreManifest(manifest, join(staging, 'files'));
    } finally { await handle.close(); }
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function restoreSnapshot(projectId: string, snapshotId: string) {
  const directory = join(root, safeId(projectId), safeId(snapshotId));
  return restoreManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), join(directory, 'files'));
}
async function restoreManifest(manifest: Manifest, filesRoot: string) {
  if (manifest.version !== 1 || !Array.isArray(manifest.jobs) || !Array.isArray(manifest.files)) throw new Error('项目包清单无效');
  const oldId = safeId(manifest.project.id), newId = randomUUID();
  if (manifest.project.sourcePath && !new RegExp(`^data/projects/${oldId}/source\\.(pdf|pptx|md|markdown)$`).test(manifest.project.sourcePath)) throw new Error('项目源文件路径无效');
  const filePaths = new Set(manifest.files.map(file => file.path));
  if (manifest.project.sourcePath && !filePaths.has(`project/${manifest.project.sourcePath.split('/').at(-1)}`)) throw new Error('备份缺少项目源文件，请重新下载项目包');
  const projectRoot = join(repo, 'data/projects', newId);
  const remap = new Map<string, string>();
  // Restored audio gets a bounded name. Prefixing the archived filename made every
  // restore generation grow it by the new project id, until the copy hit the 255
  // character filename limit and the restore failed with a bare ENOENT.
  for (const file of manifest.files) {
    if (!file.path.startsWith('public/audio/')) continue;
    const name = file.path.split('/').at(-1)!;
    remap.set(`audio/${name}`, `audio/${newId}-${createHash('sha256').update(name).digest('hex').slice(0, 12)}${extname(name)}`);
  }
  const rewrite = (value: unknown): unknown => typeof value === 'string' ? remap.get(value) ?? value.replaceAll(`projects/${oldId}/`, `projects/${newId}/`) : Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)])) : value;
  const board = manifest.project.storyboardJson ? StoryboardSchema.parse(rewrite(JSON.parse(manifest.project.storyboardJson))) : null;
  const assets = JSON.parse(manifest.project.assetsJson) as { path: string; name: string }[];
  for (const asset of assets) { if (asset.path !== `projects/${oldId}/assets/${asset.name}` || !manifest.files.some(file => file.path === `project/assets/${asset.name}`)) throw new Error('素材引用不完整'); inside(filesRoot, `project/assets/${asset.name}`); }
  if (board) for (const scene of board.scenes) if (scene.audioSrc && ![...remap.values()].includes(scene.audioSrc)) throw new Error('旁白音频引用不完整');
  if (board) board.scenes.forEach(scene => { scene.id = randomUUID(); });
  const voiceId = manifest.files.some(file => file.path.startsWith('voice/')) ? `backup-${newId}` : null;
  const copied: string[] = [];
  try {
    for (const file of manifest.files) {
      const source = inside(filesRoot, file.path); if (await digest(source) !== file.sha256) throw new Error(`快照损坏：${file.path}`);
      let target: string;
      if (file.path.startsWith('project/')) { if (file.path.endsWith('storyboard-checkpoint.json')) continue; target = inside(projectRoot, file.path.slice(8)); }
      else if (file.path.startsWith('public/audio/')) target = inside(publicRoot, remap.get(file.path.slice(7))!);
      else if (file.path.startsWith('voice/') && voiceId) target = inside(join(repo, 'data/voices', voiceId), file.path.slice(6));
      else continue;
      await mkdir(resolve(target, '..'), { recursive: true }); await copyFile(source, target); copied.push(target);
      if (file.path.startsWith('project/assets/')) { const pub = inside(join(publicRoot, 'projects', newId), file.path.slice(8)); await mkdir(resolve(pub, '..'), { recursive: true }); await copyFile(target, pub); copied.push(pub); }
    }
    if (board) {
      const rulesFile = manifest.files.find(file => file.path === 'settings/pronunciation.json');
      if (rulesFile) { const raw = JSON.parse(await readFile(inside(filesRoot, rulesFile.path), 'utf8')); const rules = Array.isArray(raw) ? raw : raw.rules ?? []; board.pronunciationRules = [...rules.filter((rule: { text: string }) => !board.pronunciationRules?.some(item => item.text === rule.text)), ...(board.pronunciationRules ?? [])]; }
    }
    if (board) StoryboardSchema.parse(board);
    await db.$transaction(async tx => {
      await tx.project.create({ data: { id: newId, name: `${manifest.project.name}（恢复）`, sourceText: manifest.project.sourceText, sourcePath: manifest.project.sourcePath ? String(rewrite(manifest.project.sourcePath)) : null, styleId: manifest.project.styleId, aspectRatio: manifest.project.aspectRatio, importMode: manifest.project.importMode, assetsJson: JSON.stringify(rewrite(JSON.parse(manifest.project.assetsJson))), voiceId, storyboardJson: board ? JSON.stringify(board) : null, status: board ? 'awaiting_review' : manifest.project.sourceText.trim().length >= 30 ? 'awaiting_source_review' : 'failed' } });
      if (!board && manifest.project.sourceText.trim().length < 30) await tx.job.create({ data: { projectId: newId, kind: 'storyboard', status: 'failed', stage: 'extracting', error: '已恢复源文件，请从读取资料步骤继续' } });
      if (board) for (const [index, scene] of board.scenes.entries()) await tx.scene.create({ data: { id: scene.id, projectId: newId, orderIndex: index, type: scene.type, title: scene.title, narration: scene.narration, visualJson: JSON.stringify(scene.visual), duration: scene.duration, audioPath: scene.audioSrc, animationJson: scene.animation, styleOverrideJson: JSON.stringify(scene.styleOverride ?? {}) } });
      for (const job of manifest.jobs) {
        const kind = jobKinds.includes(job.kind) ? job.kind : 'render';
        // A render job whose video is missing from the archive must not come back
        // as a completed export that cannot be downloaded.
        const outputPath = job.outputPath && PER_JOB_VIDEO.test(job.outputPath) && filePaths.has(`project/output/${job.outputPath}`) ? job.outputPath : null;
        const lostOutput = kind === 'render' && Boolean(job.outputPath) && !outputPath;
        await tx.job.create({ data: { projectId: newId, kind, status: lostOutput ? 'failed' : ['completed', 'failed', 'cancelled'].includes(job.status) ? job.status : 'failed', stage: job.stage, outputPath, inputJson: job.inputJson ? JSON.stringify(rewrite(JSON.parse(job.inputJson))) : null, error: lostOutput ? '备份中缺少对应的导出视频，请重新导出项目包。' : job.error, createdAt: new Date(job.createdAt) } });
      }
    });
    return newId;
  } catch (error) { await Promise.all(copied.map(path => rm(path, { force: true }))); throw error; }
}
