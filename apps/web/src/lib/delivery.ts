import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { StoryboardSchema, renderValidationLabels, timelineFor, type RenderValidation, type Storyboard } from '@m2v/schema';
import { exportSubtitles, validateSubtitleTimeline } from '@m2v/video/subtitles';
import { qcCodeLabels } from '@m2v/video/qc';
import { db } from '@/lib/db';
import { ffmpegPath } from '@/lib/audio-qc';
import { boundedFileBaseName, fileStamp, outputDirFor, ownedVideoPath } from '@/lib/job-video';
import { validateExport } from '@/lib/render-validation';
import { currentQcView } from '@/lib/qc-report';
import {
  deliveryDirFor,
  nextDeliveryRecord,
  readDeliveryRecord,
  writeDeliveryRecord,
  type DeliveryMissing,
  type DeliveryRecord,
} from '@/lib/delivery-records';
import { writeProjectArchive } from '@/lib/backups';
import { resolvePublicPath } from '@/lib/public-paths';
import { ZipWriter } from '@/lib/zip';

const run = promisify(execFile);
const KEEP = 5;
const IMAGE = /\.(png|jpe?g|webp)$/i;
const building = new Set<string>();

export type DeliveryResult =
  | { ok: true; file: string; name: string; stamp: string; bytes: number; files: string[]; record: DeliveryRecord }
  | { ok: false; status: number; error: string; missing: DeliveryMissing[]; record?: DeliveryRecord };

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

async function failDelivery(input: {
  projectId: string;
  jobId: string;
  stamp: string;
  previous: DeliveryRecord | null;
  status: number;
  missing: DeliveryMissing[];
  error: string;
}): Promise<DeliveryResult> {
  const record = nextDeliveryRecord({
    previous: input.previous,
    projectId: input.projectId,
    jobId: input.jobId,
    stamp: input.stamp,
    status: 'failed',
    missing: input.missing,
    error: input.error,
  });
  await writeDeliveryRecord(record).catch(() => {});
  return { ok: false, status: input.status, error: input.error, missing: input.missing, record };
}


/** The exact board that produced the video, so subtitles share its timeline. */
/**
 * #261: the project revision the render was made from. The package's MP4 and subtitles come from
 * this render, so the delivery record must carry its revision, not the project's current one;
 * otherwise repackaging an old render after an edit made the old film look current. Renders
 * queued before this field existed are dated by comparing their storyboard with the current one.
 */
function renderRevision(inputJson: string | null, project: { revision: number; storyboardJson: string | null }): number | undefined {
  if (!inputJson) return undefined;
  try {
    const input = JSON.parse(inputJson) as { revision?: unknown; storyboard?: unknown };
    if (typeof input.revision === 'number' && Number.isInteger(input.revision)) return input.revision;
    if (input.storyboard && project.storyboardJson) {
      const same = JSON.stringify(StoryboardSchema.parse(input.storyboard)) === JSON.stringify(StoryboardSchema.parse(JSON.parse(project.storyboardJson)));
      return same ? project.revision : -1;
    }
  } catch {
    return -1;
  }
  return undefined;
}

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

/**
 * Removes `.partial.zip` files left by an interrupted or failed attempt (#285). They hold up to
 * the whole MP4 and the retention pass below ignores hidden files, so they used to pile up.
 * Callers hold the project's `building` slot, so no partial in this directory is in use.
 */
async function removeStalePartials(directory: string, keep?: string) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('.') || !entry.name.endsWith('.partial.zip')) continue;
    const path = join(directory, entry.name);
    if (path !== keep) await rm(path, { force: true }).catch(() => {});
  }
}

async function trim(directory: string) {
  await removeStalePartials(directory);
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
  if (building.has(projectId)) {
    return { ok: false, status: 409, error: '正在打包交付包，请稍候再试', missing: [{ step: 'package', message: '已有打包任务正在进行' }] };
  }
  building.add(projectId);
  const stamp = fileStamp(new Date());
  const previous = await readDeliveryRecord(projectId, jobId).catch(() => null);
  let temp: string | null = null;
  try {
    const job = await db.job.findFirst({ where: { id: jobId, projectId, kind: 'render' } });
    if (!job) {
      return failDelivery({ projectId, jobId, stamp, previous, status: 404, error: '找不到这条导出记录', missing: [{ step: 'render', message: '导出记录不存在' }] });
    }
    if (job.status !== 'completed') {
      return failDelivery({ projectId, jobId, stamp, previous, status: 409, error: '成片还没有渲染完成，暂时无法打包交付', missing: [{ step: 'render', message: `导出任务状态为 ${job.status}` }] });
    }
    // #272: the file is re-read every time a package is built. A stored verdict can be stale (the
    // MP4 may have been truncated or replaced since), and packaging trusted it blindly.
    const outcome = await validateExport(projectId, jobId);
    if (!outcome) {
      return failDelivery({ projectId, jobId, stamp, previous, status: 404, error: '找不到这条导出记录', missing: [{ step: 'render', message: '导出记录不存在' }] });
    }
    if (!outcome.ok) {
      return failDelivery({ projectId, jobId, stamp, previous, status: outcome.status, error: outcome.error, missing: [{ step: 'validation', message: outcome.error }] });
    }
    const validation = outcome.validation;
    const blocking = validation.issues.filter(issue => issue.blocking);
    if (blocking.length) {
      const reasons = blocking.map(issue => renderValidationLabels[issue.code]).join('、');
      return failDelivery({
        projectId,
        jobId,
        stamp,
        previous,
        status: 409,
        error: `成片文件校验未通过（${reasons}），无法生成交付包。请重新导出成片后再打包。`,
        missing: blocking.map(issue => ({ step: 'validation', message: `${renderValidationLabels[issue.code]}：${issue.message}` })),
      });
    }
    const renders = await db.job.findMany({
      where: { projectId, kind: 'render' },
      select: { id: true, kind: true, status: true, outputPath: true, createdAt: true },
    });
    const owned = ownedVideoPath(job, renders);
    if (!owned) {
      return failDelivery({ projectId, jobId, stamp, previous, status: 409, error: '这条导出记录的视频已被后续导出覆盖，只有最近一次导出可以打包，请重新导出后再试', missing: [{ step: 'video', message: '成片文件已被后续导出覆盖' }] });
    }
    const video = resolve(outputDirFor(projectId), owned);
    try {
      if ((await stat(video)).size === 0) throw new Error('empty');
    } catch {
      return failDelivery({ projectId, jobId, stamp, previous, status: 409, error: '成片文件不存在或为空，无法生成交付包。请重新导出成片后再打包。', missing: [{ step: 'video', message: `缺少成片文件 ${owned}` }] });
    }
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return failDelivery({ projectId, jobId, stamp, previous, status: 404, error: '项目不存在', missing: [{ step: 'package', message: '项目不存在' }] });
    }
    // A current QC report with blocking issues stops packaging; a missing or stale
    // report stays permissive so projects that never ran QC keep working.
    const qc = await currentQcView(projectId, project.revision);
    if (qc.status === 'blocking' && qc.report) {
      const errors = [qc.report.subtitles.issues, qc.report.audio.issues, qc.report.render?.issue ? [qc.report.render.issue] : []]
        .flat()
        .filter(issue => issue.severity === 'error');
      const reasons = [...new Set(errors.map(issue => qcCodeLabels[issue.code]))].join('、');
      return failDelivery({
        projectId,
        jobId,
        stamp,
        previous,
        status: 409,
        error: `质检还有 ${qc.report.summary.errors} 项阻断问题${reasons ? `（${reasons}）` : ''}，无法生成交付包。请在「质检交付」修复后重新检查，通过或只剩提醒时再打包。`,
        missing: errors.slice(0, 5).map(issue => ({ step: 'qc', message: `${qcCodeLabels[issue.code]}：${issue.message}` })),
      });
    }
    // #273: subtitles must come from the storyboard this MP4 was rendered from. The current storyboard
    // may have different narration, order, timing or intro, so it is never used as a stand-in.
    const board = renderStoryboard(job.inputJson);
    if (!board) {
      return failDelivery({ projectId, jobId, stamp, previous, status: 409, error: '这条导出记录没有保存渲染时的分镜，无法生成与成片同步的字幕。请重新渲染后再打包。', missing: [{ step: 'subtitles', message: '缺少渲染时的分镜快照，需要重新渲染' }] });
    }

    const duration = validation.duration ?? timelineFor(board).totalSeconds;
    const timeline = validateSubtitleTimeline(board, duration);
    if (!timeline.ok) {
      const first = timeline.issues[0];
      return failDelivery({
        projectId,
        jobId,
        stamp,
        previous,
        status: 409,
        error: `字幕时间轴校验未通过：${first.message}。请调整字幕后重新导出成片。`,
        missing: timeline.issues.slice(0, 5).map(issue => ({ step: 'subtitles', message: issue.message })),
      });
    }

    const base = boundedFileBaseName(project.name);
    const directory = deliveryDirFor(projectId);
    await mkdir(directory, { recursive: true });
    const partial = join(directory, `.${stamp}-${jobId}.partial.zip`);
    const final = join(directory, `${stamp}-${jobId}.zip`);
    await removeStalePartials(directory);
    temp = await mkdtemp(join(tmpdir(), 'm2v-delivery-'));
    const cover = await resolveCover({
      video,
      seconds: Math.min(1, Math.max(0, duration / 2)),
      projectId,
      assetsJson: project.assetsJson,
      temp,
    });
    if (!cover) {
      return failDelivery({ projectId, jobId, stamp, previous, status: 409, error: '封面生成失败：本机缺少 FFmpeg，项目里也没有可用图片素材。请安装 FFmpeg 或先添加素材后再打包', missing: [{ step: 'cover', message: '无法从成片截帧，且项目中没有可用图片素材' }] });
    }

    const videoName = `${base}-成片-${stamp}.mp4`;
    const coverName = `${base}-封面-${stamp}${extname(cover).toLowerCase()}`;
    const backupName = `${base}-项目备份-${stamp}.m2v`;
    const noteName = `${base}-交付说明.txt`;
    const subtitleNames = (['srt', 'vtt', 'ass'] as const).map(format => `${base}-字幕-${stamp}.${format}`);
    const archive = join(temp, 'backup.m2v');
    try {
      await writeProjectArchive(projectId, archive, { includeOutput: false });
    } catch (error) {
      return failDelivery({ projectId, jobId, stamp, previous, status: 500, error: `项目备份生成失败：${errorText(error)}`, missing: [{ step: 'backup', message: errorText(error) }] });
    }
    let writer: ZipWriter;
    try {
      writer = await ZipWriter.create(partial);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      return failDelivery({ projectId, jobId, stamp, previous, status: 500, error: `交付包写入失败：${errorText(error)}`, missing: [{ step: 'package', message: errorText(error) }] });
    }
    try {
      await writer.addFile(videoName, video);
      for (const [index, format] of (['srt', 'vtt', 'ass'] as const).entries()) {
        await writer.addText(subtitleNames[index], exportSubtitles(board, format));
      }
      await writer.addFile(coverName, cover);
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
      // abort() can itself fail; the partial archive must be removed either way.
      await writer.abort().catch(() => {});
      await rm(partial, { force: true }).catch(() => {});
      return failDelivery({ projectId, jobId, stamp, previous, status: 500, error: `交付包写入失败：${errorText(error)}`, missing: [{ step: 'package', message: errorText(error) }] });
    }
    try {
      await rename(partial, final);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => {});
      return failDelivery({ projectId, jobId, stamp, previous, status: 500, error: `交付包写入失败：${errorText(error)}`, missing: [{ step: 'package', message: errorText(error) }] });
    }
    await trim(directory);
    const files = [videoName, ...subtitleNames, coverName, backupName, noteName];
    const bytes = (await stat(final)).size;
    const record = nextDeliveryRecord({
      previous,
      projectId,
      jobId,
      stamp,
      status: 'ready',
      name: `${base}-交付包-${stamp}.zip`,
      file: basename(final),
      bytes,
      files: files.length,
      // Provenance: the archive only vouches for this revision under this verdict.
      revision: renderRevision(job.inputJson, project),
      qc: {
        status: qc.status,
        errors: qc.report?.summary.errors ?? 0,
        warnings: qc.report?.summary.warnings ?? 0,
      },
    });
    // #263: downloads find the ZIP only through this record. If it cannot be written, the new
    // package is not downloadable (the download would 404 or serve the previous ZIP), so this is a
    // failure: the new ZIP is removed and the caller is told why.
    try {
      await writeDeliveryRecord(record);
    } catch (error) {
      await rm(final, { force: true }).catch(() => {});
      const message = `交付包已生成，但交付记录写入失败（${errorText(error)}），新包无法下载。请检查磁盘空间或文件权限后重新打包。`;
      return { ok: false, status: 500, error: message, missing: [{ step: 'package', message }] };
    }
    return { ok: true, file: final, name: record.name ?? `${base}-交付包-${stamp}.zip`, stamp, bytes, files, record };
  } finally {
    building.delete(projectId);
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
