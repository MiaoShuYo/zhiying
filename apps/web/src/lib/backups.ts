import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, copyFile, rm, stat, open, rename } from 'node:fs/promises';
import { resolve, join, relative, sep, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PER_JOB_VIDEO, SHARED_VIDEO, sharedVideoOwner } from './job-video';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from './db';
import { StoryboardSchema, type Storyboard } from '@m2v/schema';

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

export type RestoreStep = 'read' | 'validate' | 'files' | 'database';

export class RestoreError extends Error {
  readonly step: RestoreStep;
  readonly missing: string[];
  constructor(step: RestoreStep, message: string, missing: string[] = []) {
    super(message);
    this.name = 'RestoreError';
    this.step = step;
    this.missing = missing;
  }
}

export function restoreErrorBody(error: unknown) {
  if (error instanceof RestoreError) return { error: error.message, step: error.step, missing: error.missing };
  return { error: error instanceof Error ? error.message : '恢复失败', step: 'validate' as RestoreStep, missing: [] as string[] };
}

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
    try {
      const manifest = JSON.parse(await readFile(join(directory, entry.name, 'manifest.json'), 'utf8')) as Manifest;
      result.push({ id: entry.name, createdAt: manifest.createdAt, locked: manifest.locked, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0) });
    } catch {
      // A damaged snapshot stays on disk for inspection but must not break the list.
    }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Delivery packages and QC sidecars are derived data; they never belong in a backup. */
const DERIVED_PROJECT_PATH = /^project\/(delivery\/|qc-report\.json$)/;
/** Every file a project owns outside the database: its folder, audio and templates. */
async function collectSources(projectId: string, storyboard: Storyboard | null, includeOutput: boolean) {
  const sources = (await tree(join(repo, 'data/projects', projectId), 'project'))
    .filter(item => (includeOutput || !item.path.startsWith('project/output/')) && !DERIVED_PROJECT_PATH.test(item.path));
  const audioFiles = (await readdir(join(publicRoot, 'audio')).catch(() => [])).filter(name => name.startsWith(`${projectId}-`));
  sources.push(...audioFiles.map(name => ({ source: join(publicRoot, 'audio', name), path: `public/audio/${name}` })));
  for (const path of new Set(storyboard?.scenes.map(scene => scene.audioSrc).filter((path): path is string => Boolean(path)) ?? [])) {
    if (!/^audio\/[^/\\]+$/.test(path)) throw new Error('项目音频路径无效');
    if (!sources.some(item => item.path === `public/${path}`)) sources.push({ source: inside(publicRoot, path), path: `public/${path}` });
  }
  return sources;
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
    const storyboard = project.storyboardJson ? StoryboardSchema.parse(JSON.parse(project.storyboardJson)) : null;
    const sources = await collectSources(projectId, storyboard, true);
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
  if (!request.body) throw new RestoreError('read', '备份文件为空');
  const staging = join(root, `.import-${randomUUID()}`); await mkdir(staging, { recursive: true });
  const archive = join(staging, 'upload.m2v');
  try {
    await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), createWriteStream(archive));
    const handle = await open(archive, 'r');
    try {
      const prefix = Buffer.alloc(12); await handle.read(prefix, 0, 12, 0);
      if (prefix.subarray(0, 8).toString() !== 'M2VBK001') throw new RestoreError('validate', '不是知影 V1.1 项目包');
      const length = prefix.readUInt32BE(8); if (length > 20 * 1024 * 1024) throw new RestoreError('validate', '备份清单过大');
      const raw = Buffer.alloc(length); if ((await handle.read(raw, 0, length, 12)).bytesRead !== length) throw new RestoreError('validate', '备份不完整');
      let manifest: Manifest;
      try {
        manifest = JSON.parse(raw.toString()) as Manifest;
      } catch {
        throw new RestoreError('validate', '备份清单损坏');
      }
      if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 100_000) throw new RestoreError('validate', '不支持的备份格式');
      let offset = 12 + length; const names = new Set<string>();
      for (const file of manifest.files) {
        if (typeof file.path !== 'string' || names.has(file.path.toLowerCase()) || !/^(project|public\/audio|voice|settings)\//.test(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) throw new RestoreError('validate', '备份清单无效', [String(file.path ?? '')]);
        names.add(file.path.toLowerCase()); const target = inside(join(staging, 'files'), file.path); await mkdir(resolve(target, '..'), { recursive: true });
        if (file.size) await pipeline(createReadStream(archive, { start: offset, end: offset + file.size - 1 }), createWriteStream(target)); else await writeFile(target, '');
        if ((await stat(target)).size !== file.size || await digest(target) !== file.sha256) throw new RestoreError('files', `备份损坏：${file.path}`, [file.path]);
        offset += file.size;
      }
      if (offset !== (await stat(archive)).size) throw new RestoreError('validate', '备份长度不匹配');
      return await restoreManifest(manifest, join(staging, 'files'));
    } finally { await handle.close(); }
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function restoreSnapshot(projectId: string, snapshotId: string) {
  const directory = join(root, safeId(projectId), safeId(snapshotId));
  return restoreManifest(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), join(directory, 'files'));
}
const activeRestores = new Set<string>();
const restoreMarker = (newId: string) => join(repo, 'data/projects', `.restore-${newId}.json`);

async function cleanupPartialRestore(newId: string) {
  // The database transaction is normally the last restore operation. If the process
  // dies just after it commits, startup cleanup must remove that newly-created record
  // too, or the project list would point at files that cleanup has deleted.
  await db.project.deleteMany({ where: { id: newId } });
  await rm(join(repo, 'data/projects', newId), { recursive: true, force: true });
  await rm(join(repo, 'data/voices', `backup-${newId}`), { recursive: true, force: true });
  await rm(join(publicRoot, 'projects', newId), { recursive: true, force: true });
  const audio = await readdir(join(publicRoot, 'audio')).catch(() => [] as string[]);
  await Promise.all(audio.filter(name => name.startsWith(`${newId}-`)).map(name => rm(join(publicRoot, 'audio', name), { force: true })));
}

type RestoreMarker = {
  projectId: string;
  startedAt: number;
  ownerPid: number;
  step: 'validate' | 'files' | 'database';
  fileIndex?: number;
  fileCount?: number;
};

async function writeRestoreMarker(marker: string, value: RestoreMarker) {
  await writeFile(marker, JSON.stringify(value));
}

function processIsAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Removes project data left by a restore interrupted by process termination. */
export async function cleanupInterruptedRestores() {
  const directory = join(repo, 'data/projects');
  const entries = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(entries.filter(name => name.startsWith('.restore-') && name.endsWith('.json')).map(async name => {
    const marker = join(directory, name);
    const newId = name.slice('.restore-'.length, -'.json'.length);
    if (activeRestores.has(newId)) return;
    try {
      const raw = JSON.parse(await readFile(marker, 'utf8')) as Partial<RestoreMarker>;
      if (Number.isSafeInteger(raw.ownerPid) && raw.ownerPid !== process.pid && processIsAlive(raw.ownerPid!)) return;
      // Old markers predate ownerPid. Keep the original grace period for those so an
      // older app instance can finish its active restore during a rolling restart.
      if (!Number.isSafeInteger(raw.ownerPid) && typeof raw.startedAt === 'number' && Date.now() - raw.startedAt < 60_000) return;
      const step = raw.step ?? 'validate';
      console.warn(`[backup-restore] interrupted restore found; cleaning ${JSON.stringify({ projectId: newId, step, fileIndex: raw.fileIndex, fileCount: raw.fileCount })}`);
    } catch {
      // An unreadable marker is itself stale and its project id comes from its filename.
    }
    try {
      await cleanupPartialRestore(newId);
      await rm(marker, { force: true });
      console.info(`[backup-restore] interrupted restore cleanup completed ${JSON.stringify({ projectId: newId })}`);
    } catch (error) {
      // Keep the marker so a later request or restart can retry cleanup.
      console.error(`[backup-restore] interrupted restore cleanup failed ${JSON.stringify({ projectId: newId, error: error instanceof Error ? error.message : String(error) })}`);
    }
  }));
}

async function nextRestoredName(base: string) {
  const plain = `${base}（恢复）`;
  // 编号形式是（恢复 2），不以（恢复）开头，前缀必须停在“恢复”上，否则会重复出（恢复 2）。
  const existing = new Set((await db.project.findMany({ where: { name: { startsWith: `${base}（恢复` } }, select: { name: true } })).map(project => project.name));
  if (!existing.has(plain)) return plain;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base}（恢复 ${index}）`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}（恢复 ${Date.now()}）`;
}

async function restoreManifest(manifest: Manifest, filesRoot: string) {
  await cleanupInterruptedRestores();
  if (manifest.version !== 1 || !Array.isArray(manifest.jobs) || !Array.isArray(manifest.files)) throw new RestoreError('validate', '项目包清单无效');
  let oldId: string;
  try {
    oldId = safeId(manifest.project.id);
  } catch {
    throw new RestoreError('validate', '项目 ID 无效');
  }
  const newId = randomUUID();
  const projectRoot = join(repo, 'data/projects', newId);
  activeRestores.add(newId);
  const marker = restoreMarker(newId);
  const startedAt = Date.now();
  let completed = false;
  try {
    await mkdir(projectRoot, { recursive: true });
    await writeRestoreMarker(marker, { projectId: newId, startedAt, ownerPid: process.pid, step: 'validate' });
    if (manifest.project.sourcePath && !new RegExp(`^data/projects/${oldId}/source\\.(pdf|pptx|md|markdown)$`).test(manifest.project.sourcePath)) throw new RestoreError('validate', '项目源文件路径无效');
    const filePaths = new Set(manifest.files.map(file => file.path));
    if (manifest.project.sourcePath && !filePaths.has(`project/${manifest.project.sourcePath.split('/').at(-1)}`)) {
      throw new RestoreError('files', '备份缺少项目源文件，请重新下载项目包', [manifest.project.sourcePath.split('/').at(-1)!]);
    }
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
    const audioTargets = new Set(remap.values());
    // Uploaded BGM is stored as a project asset (`projects/<id>/assets/...`),
    // while generated narration is stored under `public/audio`. Both are valid
    // local audio sources after a restore; only the latter needs the audio remap.
    const projectAssetTargets = new Set(manifest.files
      .filter(file => file.path.startsWith('project/assets/'))
      .map(file => `projects/${newId}/assets/${file.path.slice('project/assets/'.length)}`));
    const missingMedia: string[] = [];
    for (const asset of assets) {
      if (asset.path !== `projects/${oldId}/assets/${asset.name}`) throw new RestoreError('validate', '素材引用不完整', [asset.name]);
      let readable = false;
      try {
        inside(filesRoot, `project/assets/${asset.name}`);
        readable = true;
      } catch {
        // Reported below with the same wording as a missing media file.
      }
      if (!readable || !manifest.files.some(file => file.path === `project/assets/${asset.name}`)) missingMedia.push(`素材 ${asset.name}`);
    }
    if (board) for (const scene of board.scenes) if (scene.audioSrc && !audioTargets.has(scene.audioSrc)) missingMedia.push(`旁白音频 ${scene.audioSrc}`);
    if (board?.bgmSrc && !audioTargets.has(board.bgmSrc) && !projectAssetTargets.has(board.bgmSrc)) missingMedia.push(`背景音乐 ${board.bgmSrc}`);
    if (missingMedia.length) throw new RestoreError('files', `备份缺少媒体文件：${missingMedia.join('、')}`, missingMedia);
    if (board) board.scenes.forEach(scene => { scene.id = randomUUID(); });
    const voiceId = manifest.files.some(file => file.path.startsWith('voice/')) ? `backup-${newId}` : null;
    const restoredName = await nextRestoredName(manifest.project.name);
    await writeRestoreMarker(marker, { projectId: newId, startedAt, ownerPid: process.pid, step: 'files', fileIndex: 0, fileCount: manifest.files.length });
    console.info(`[backup-restore] entering files ${JSON.stringify({ projectId: newId, fileCount: manifest.files.length })}`);
    for (const [fileIndex, file] of manifest.files.entries()) {
      await writeRestoreMarker(marker, { projectId: newId, startedAt, ownerPid: process.pid, step: 'files', fileIndex, fileCount: manifest.files.length });
      let source: string;
      try {
        source = inside(filesRoot, file.path);
        if (await digest(source) !== file.sha256) throw new Error('checksum');
      } catch {
        throw new RestoreError('files', `快照损坏：${file.path}`, [file.path]);
      }
      let target: string;
      if (file.path.startsWith('project/')) {
        if (file.path.endsWith('storyboard-checkpoint.json') || DERIVED_PROJECT_PATH.test(file.path)) continue;
        target = inside(projectRoot, file.path.slice(8));
      } else if (file.path.startsWith('public/audio/')) target = inside(publicRoot, remap.get(file.path.slice(7))!);
      else if (file.path.startsWith('voice/') && voiceId) target = inside(join(repo, 'data/voices', voiceId), file.path.slice(6));
      else continue;
      try {
        await mkdir(resolve(target, '..'), { recursive: true });
        await copyFile(source, target);
        if (file.path.startsWith('project/assets/')) {
          const pub = inside(join(publicRoot, 'projects', newId), file.path.slice(8));
          await mkdir(resolve(pub, '..'), { recursive: true });
          await copyFile(target, pub);
        }
      } catch {
        throw new RestoreError('files', `写入恢复文件失败：${file.path}`, [file.path]);
      }
    }
    console.info(`[backup-restore] files completed ${JSON.stringify({ projectId: newId, fileCount: manifest.files.length })}`);
    if (board) {
      const rulesFile = manifest.files.find(file => file.path === 'settings/pronunciation.json');
      if (rulesFile) { const raw = JSON.parse(await readFile(inside(filesRoot, rulesFile.path), 'utf8')); const rules = Array.isArray(raw) ? raw : raw.rules ?? []; board.pronunciationRules = [...rules.filter((rule: { text: string }) => !board.pronunciationRules?.some(item => item.text === rule.text)), ...(board.pronunciationRules ?? [])]; }
    }
    if (board) StoryboardSchema.parse(board);
    try {
      await writeRestoreMarker(marker, { projectId: newId, startedAt, ownerPid: process.pid, step: 'database' });
      console.info(`[backup-restore] entering database ${JSON.stringify({ projectId: newId })}`);
      await db.$transaction(async tx => {
        await tx.project.create({ data: { id: newId, name: restoredName, sourceText: manifest.project.sourceText, sourcePath: manifest.project.sourcePath ? String(rewrite(manifest.project.sourcePath)) : null, styleId: manifest.project.styleId, aspectRatio: manifest.project.aspectRatio, importMode: manifest.project.importMode, assetsJson: JSON.stringify(rewrite(JSON.parse(manifest.project.assetsJson))), voiceId, storyboardJson: board ? JSON.stringify(board) : null, status: board ? 'awaiting_review' : manifest.project.sourceText.trim().length >= 30 ? 'awaiting_source_review' : 'failed' } });
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
    } catch (error) {
      throw new RestoreError('database', `写入项目数据失败：${error instanceof Error ? error.message : String(error)}`);
    }
    completed = true;
    console.info(`[backup-restore] completed ${JSON.stringify({ projectId: newId })}`);
    return newId;
  } catch (error) {
    try {
      await cleanupPartialRestore(newId);
      await rm(marker, { force: true });
    } catch (cleanupError) {
      console.error(`[backup-restore] failed restore cleanup deferred ${JSON.stringify({ projectId: newId, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) })}`);
    }
    if (error instanceof RestoreError) throw error;
    throw new RestoreError('validate', error instanceof Error ? error.message : '恢复失败');
  } finally {
    activeRestores.delete(newId);
    if (completed) await rm(marker, { force: true }).catch(() => {});
  }
}

/**
 * Writes the V1.1 container straight from the live project for the delivery package.
 * The output folder is skipped by default because the MP4 already travels as its own
 * file, and the manifest keeps `outputPath` so a restore still explains the gap.
 */
export async function writeProjectArchive(projectId: string, target: string, options: { includeOutput?: boolean } = {}) {
  safeId(projectId);
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, include: { jobs: true } });
  const storyboard = project.storyboardJson ? StoryboardSchema.parse(JSON.parse(project.storyboardJson)) : null;
  const sources = await collectSources(projectId, storyboard, options.includeOutput ?? false);
  let voiceId = project.voiceId;
  if (!voiceId) { try { voiceId = JSON.parse(await readFile(join(repo, 'data/settings/general-voice.json'), 'utf8')).voiceId; } catch { /* No voice selected. */ } }
  if (voiceId) sources.push(...await tree(join(repo, 'data/voices', safeId(voiceId)), 'voice'));
  let pronunciation: Buffer | null = null;
  try { pronunciation = await readFile(join(repo, 'data/settings/pronunciation.json')); } catch { /* No global rules. */ }
  const files: Entry[] = [];
  for (const item of sources) files.push({ path: item.path, size: (await stat(item.source)).size, sha256: await digest(item.source) });
  if (pronunciation) files.push({ path: 'settings/pronunciation.json', size: pronunciation.length, sha256: createHash('sha256').update(pronunciation).digest('hex') });
  const { jobs, ...record } = project;
  // Only the newest record may claim a legacy shared final.mp4; with the output folder
  // excluded this is null, and every record keeps the name it was stored with.
  const sharedOwner = sources.some(item => item.path === `project/output/${SHARED_VIDEO}`) ? sharedVideoOwner(jobs) : null;
  const manifest: Manifest = { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), locked: false, project: { ...record, voiceId: voiceId ?? null }, jobs: jobs.map(job => ({ kind: job.kind, status: job.status, stage: job.stage, outputPath: job.id === sharedOwner ? SHARED_VIDEO : job.outputPath, inputJson: job.inputJson, error: job.error, createdAt: job.createdAt.toISOString() })), files };
  const raw = Buffer.from(JSON.stringify(manifest));
  const prefix = Buffer.alloc(12);
  prefix.write('M2VBK001');
  prefix.writeUInt32BE(raw.length, 8);
  const handle = await open(target, 'w');
  let offset = 0;
  const write = async (chunk: Buffer) => {
    let done = 0;
    while (done < chunk.length) {
      const { bytesWritten } = await handle.write(chunk, done, chunk.length - done, offset);
      offset += bytesWritten;
      done += bytesWritten;
    }
  };
  try {
    await write(prefix);
    await write(raw);
    for (const item of sources) for await (const chunk of createReadStream(item.source)) await write(chunk as Buffer);
    if (pronunciation) await write(pronunciation);
  } finally {
    await handle.close();
  }
  const expected = 12 + raw.length + files.reduce((sum, file) => sum + file.size, 0);
  if ((await stat(target)).size !== expected) throw new Error('项目备份写入不完整，请重试');
}
