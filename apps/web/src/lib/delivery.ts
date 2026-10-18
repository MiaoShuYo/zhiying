import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { StoryboardSchema, renderValidationLabels, timelineFor, type RenderValidation, type Storyboard } from '@m2v/schema';
import { exportSubtitles } from '@m2v/video/subtitles';
import { db } from '@/lib/db';
import { ffmpegPath } from '@/lib/audio-qc';
import { fileStamp, outputDirFor, ownedVideoPath, safeFileBaseName } from '@/lib/job-video';
import { parseValidation, validateExport } from '@/lib/render-validation';
import { writeProjectArchive } from '@/lib/backups';
import { resolvePublicPath } from '@/lib/public-paths';
import { ZipWriter } from '@/lib/zip';

const run = promisify(execFile);
const repo = resolve(process.cwd(), '..', '..');
const KEEP = 5;
const IMAGE = /\.(png|jpe?g|webp)$/i;
const building = new Set<string>();

export type DeliveryResult =
  | { ok: true; file: string; name: string; stamp: string; bytes: number; files: string[] }
  | { ok: false; status: number; error: string };

/** The exact board that produced the video, so subtitles share its timeline. */
function renderStoryboard(inputJson: string | null): Storyboard | null {
  try {
    const parsed = StoryboardSchema.safeParse((JSON.parse(inputJson ?? '{}') as { storyboard?: unknown }).storyboard);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function deliveryNote(options: {
  project: string;
  video: string;
  subtitles: string[];
  cover: string;
  backup: string;
  validation: RenderValidation;
  duration: number;
}) {
  const { validation } = options;
  const picture = [
    validation.width && validation.height ? `${validation.width} × ${validation.height}` : '分辨率未知',
    `时长 ${options.duration.toFixed(1)} 秒`,
    validation.videoCodec ? `视频 ${validation.videoCodec}` : '视频编码未知',
    validation.hasAudio ? (validation.audioCodec ? `音频 ${validation.audioCodec}` : '含音频') : '无音频轨道',
  ].join('，');
  const issues = validation.issues.length
    ? validation.issues.map(issue => `- ${renderValidationLabels[issue.code]}：${issue.message}`).join('\n')
    : '未发现问题。';
  return [
    '交付说明',
    `项目：${options.project}`,
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '一、成片',
    `文件：${options.video}`,
    `规格：${picture}`,
    `文件校验：${validation.ok ? '通过' : `有 ${validation.issues.length} 项提醒`}`,
    '',
    '二、字幕',
    `文件：${options.subtitles.join('、')}`,
    '字幕与成片使用同一时间轴，可直接导入播放器或剪辑软件。',
    '',
    '三、封面',
    `文件：${options.cover}`,
    '',
    '四、项目备份',
    `文件：${options.backup}`,
    '在项目列表的「导入项目包」中选择这个文件即可恢复分镜、素材、语音和配音规则。',
    '备份不包含成片视频，恢复后如需视频请重新导出。',
    '',
    '五、质检结果',
    issues,
    '',
  ].join('\n');
}

/** A frame from the video, or the first usable project image when FFmpeg is unavailable. */
async function resolveCover(options: { video: string; seconds: number; projectId: string; assetsJson: string; temp: string }) {
  const target = join(options.temp, 'cover.jpg');
  try {
    await run(
      ffmpegPath(),
      ['-hide_banner', '-v', 'error', '-y', '-ss', options.seconds.toFixed(2), '-i', options.video, '-frames:v', '1', '-q:v', '3', target],
      { timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
    );
    if ((await stat(target)).size > 0) return target;
  } catch { /* Fall back to a project image below. */ }
  let assets: { name?: string }[] = [];
  try {
    assets = JSON.parse(options.assetsJson || '[]') as { name?: string }[];
  } catch {
    return null;
  }
  for (const asset of assets) {
    if (!asset.name || !IMAGE.test(asset.name)) continue;
    const file = resolvePublicPath(`projects/${options.projectId}/assets/${asset.name}`);
    if (!file) continue;
    try {
      if ((await stat(file)).isFile()) return file;
    } catch { /* Try the next asset. */ }
  }
  return null;
}

async function trim(directory: string) {
  const entries = (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && entry.name.endsWith('.zip') && !entry.name.startsWith('.'))
    .map(entry => entry.name);
  const stamped: { name: string; mtime: number }[] = [];
  for (const name of entries) stamped.push({ name, mtime: (await stat(join(directory, name))).mtimeMs });
  stamped.sort((a, b) => b.mtime - a.mtime);
  for (const old of stamped.slice(KEEP)) await rm(join(directory, old.name), { force: true });
}

/** Collects the finished video, matching subtitles, a cover and a project backup into one ZIP. */
export async function buildDelivery(projectId: string, jobId: string): Promise<DeliveryResult> {
  if (building.has(projectId)) return { ok: false, status: 409, error: '正在打包交付包，请稍候再试' };
  building.add(projectId);
  let temp: string | null = null;
  try {
    const job = await db.job.findFirst({ where: { id: jobId, projectId, kind: 'render' } });
    if (!job) return { ok: false, status: 404, error: '找不到这条导出记录' };
    if (job.status !== 'completed') return { ok: false, status: 409, error: '成片还没有渲染完成，暂时无法打包交付' };
    let validation = parseValidation(job.validationJson);
    if (!validation) {
      const outcome = await validateExport(projectId, jobId);
      if (!outcome) return { ok: false, status: 404, error: '找不到这条导出记录' };
      if (!outcome.ok) return { ok: false, status: outcome.status, error: outcome.error };
      validation = outcome.validation;
    }
    const blocking = validation.issues.filter(issue => issue.blocking);
    if (blocking.length) {
      const reasons = blocking.map(issue => renderValidationLabels[issue.code]).join('、');
      return { ok: false, status: 409, error: `成片文件校验未通过（${reasons}），无法生成交付包。请重新导出成片后再打包。` };
    }
    const renders = await db.job.findMany({
      where: { projectId, kind: 'render' },
      select: { id: true, kind: true, status: true, outputPath: true, createdAt: true },
    });
    const owned = ownedVideoPath(job, renders);
    if (!owned) return { ok: false, status: 409, error: '这条导出记录的视频已被后续导出覆盖，只有最近一次导出可以打包，请重新导出后再试' };
    const video = resolve(outputDirFor(projectId), owned);
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) return { ok: false, status: 404, error: '项目不存在' };
    const board = renderStoryboard(job.inputJson)
      ?? (project.storyboardJson ? StoryboardSchema.parse(JSON.parse(project.storyboardJson)) : null);
    if (!board) return { ok: false, status: 409, error: '项目还没有分镜，无法生成与成片同时轴的字幕' };

    const stamp = fileStamp(new Date());
    const base = safeFileBaseName(project.name);
    const directory = resolve(repo, 'data/projects', projectId, 'delivery');
    await mkdir(directory, { recursive: true });
    const partial = join(directory, `.${stamp}-${jobId}.partial.zip`);
    const final = join(directory, `${stamp}-${jobId}.zip`);
    temp = await mkdtemp(join(tmpdir(), 'm2v-delivery-'));
    const duration = validation.duration ?? timelineFor(board).totalSeconds;
    const cover = await resolveCover({
      video,
      seconds: Math.min(1, Math.max(0, duration / 2)),
      projectId,
      assetsJson: project.assetsJson,
      temp,
    });
    if (!cover) return { ok: false, status: 409, error: '封面生成失败：本机缺少 FFmpeg，项目里也没有可用图片素材。请安装 FFmpeg 或先添加素材后再打包' };

    const videoName = `${base}-成片-${stamp}.mp4`;
    const coverName = `${base}-封面-${stamp}${extname(cover).toLowerCase()}`;
    const backupName = `${base}-项目备份-${stamp}.m2v`;
    const noteName = `${base}-交付说明.txt`;
    const subtitleNames = (['srt', 'vtt', 'ass'] as const).map(format => `${base}-字幕-${stamp}.${format}`);
    const writer = await ZipWriter.create(partial);
    try {
      await writer.addFile(videoName, video);
      for (const [index, format] of (['srt', 'vtt', 'ass'] as const).entries()) {
        await writer.addText(subtitleNames[index], exportSubtitles(board, format));
      }
      await writer.addFile(coverName, cover);
      const archive = join(temp, 'backup.m2v');
      await writeProjectArchive(projectId, archive, { includeOutput: false });
      await writer.addFile(backupName, archive);
      await writer.addText(noteName, deliveryNote({
        project: project.name,
        video: videoName,
        subtitles: subtitleNames,
        cover: coverName,
        backup: backupName,
        validation,
        duration,
      }));
      await writer.finish();
    } catch (error) {
      await writer.abort();
      throw error;
    }
    await rename(partial, final);
    await trim(directory);
    return {
      ok: true,
      file: final,
      name: `${base}-交付包-${stamp}.zip`,
      stamp,
      bytes: (await stat(final)).size,
      files: [videoName, ...subtitleNames, coverName, backupName, noteName],
    };
  } finally {
    building.delete(projectId);
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
