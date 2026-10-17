import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, statfs } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { db } from '@/lib/db';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const exec = promisify(execFile);
const pnpmBinary = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
type Raw = { name: string; ok: boolean; detail: string; fix: string; warn?: boolean };
type Check = { name: string; status: 'ok' | 'warn' | 'fail'; ok: boolean; detail: string; fix: string };
const repoRoot = resolve(process.cwd(), '../..');
const gb = (bytes: number) => Math.round(bytes / 1024 / 1024 / 1024 * 10) / 10;
function portOpen(port: number, host = '127.0.0.1', timeout = 1500) {
  return new Promise<boolean>(open => {
    const socket = createConnection({ port, host });
    const done = (value: boolean) => { socket.destroy(); open(value); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
function processAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
export async function GET() {
  const checks: Raw[] = [];
  const tasks = await Promise.allSettled([
    fetch(`${process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000'}/health`, { signal: AbortSignal.timeout(20_000), cache: 'no-store' }).then(async response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }),
    fetch(`${process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'}/api/tags`, { signal: AbortSignal.timeout(5000), cache: 'no-store' }).then(async response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }),
    exec('ffmpeg', ['-version'], { windowsHide: true, timeout: 5000 }),
    exec('ffprobe', ['-version'], { windowsHide: true, timeout: 5000 }),
    readFile(resolve(process.cwd(), '../../data/worker-heartbeat.json'), 'utf8').then(raw => JSON.parse(raw) as { time: number; pid: number }),
  ]);
  const python = tasks[0];
  checks.push({ name: 'Python 服务', ok: python.status === 'fulfilled', detail: python.status === 'fulfilled' ? `Python ${python.value.python}` : String(python.reason), fix: '在 services/python 执行 uv run uvicorn app.main:app --host 127.0.0.1 --port 8000' });
  if (python.status === 'fulfilled') for (const [key, name, fix] of [
    ['tts', 'F5-TTS 依赖', '在 services/python 执行 uv sync --extra tts'], ['ttsModels', 'TTS 模型文件', '检查 data/models/f5-tts 内模型和声码器文件是否完整'],
    ['torchcodec', 'TorchCodec', '检查 FFmpeg 8 full-shared、PyTorch 与 TorchCodec 兼容性后重启 Python 服务'], ['ffmpegCompatible', 'Python FFmpeg 兼容性', '将 FFmpeg 8 full-shared/bin 加入 Python 服务的 PATH 并重启'], ['ocr', '扫描 PDF OCR', '安装 Tesseract 及 chi_sim、eng 语言包；标准安装路径会自动识别，其他安装路径可设置 TESSDATA_PREFIX 后重启 Python 服务'],
  ]) checks.push({ name, ok: python.value[key] === true, detail: python.value[key] === true ? '可用' : key === 'torchcodec' ? String(python.value.torchcodecError ?? '不可用') : '缺失或不可用', fix });
  const ollama = tasks[1], model = process.env.OLLAMA_MODEL ?? 'qwen3:4b';
  checks.push({ name: 'Ollama 服务', ok: ollama.status === 'fulfilled', detail: ollama.status === 'fulfilled' ? '已连接' : String(ollama.reason), fix: '启动 Ollama，并检查 OLLAMA_BASE_URL' });
  checks.push({ name: `分镜模型 ${model}`, ok: ollama.status === 'fulfilled' && ollama.value.models?.some((item: { name: string }) => item.name === model || item.name === `${model}:latest`), detail: ollama.status === 'fulfilled' ? ollama.value.models?.map((item: { name: string }) => item.name).join('、') || '未安装模型' : '服务不可用，无法检测', fix: `执行 ollama pull ${model}` });
  for (const [index, name] of [[2, 'FFmpeg'], [3, 'ffprobe']] as const) { const result = tasks[index]; checks.push({ name, ok: result.status === 'fulfilled', detail: result.status === 'fulfilled' ? result.value.stdout.split('\n')[0] : String(result.reason), fix: '将 FFmpeg 8 full-shared/bin 加入 Web/Worker 进程 PATH 后重启' }); }
  const worker = tasks[4];
  let workerStatus: 'ok' | 'warn' | 'fail' = 'fail';
  let workerDetail = '未检测到 Worker 心跳，渲染任务不会被执行';
  if (worker.status === 'fulfilled') {
    const age = Math.round((Date.now() - worker.value.time) / 1000);
    const alive = typeof worker.value.pid === 'number' && processAlive(worker.value.pid);
    if (age >= 20_000) { workerStatus = 'fail'; workerDetail = `心跳已过期（${age} 秒前）`; }
    else if (!alive) { workerStatus = 'warn'; workerDetail = `心跳文件时间较新（${age} 秒前），但记录的进程 PID ${worker.value.pid ?? '未知'} 已不存在，多半是上次运行遗留的旧心跳；请启动 Worker 后重新检查`; }
    else { workerStatus = 'ok'; workerDetail = `心跳正常（PID ${worker.value.pid}，${age} 秒前）`; }
  } else if (!/ENOENT/.test(String(worker.reason))) workerDetail = `无法读取心跳文件：${String(worker.reason)}`;
  checks.push({ name: '渲染 Worker', ok: workerStatus !== 'fail', warn: workerStatus === 'warn', detail: workerDetail, fix: '启动 .\u005cstart.ps1 或 pnpm --filter @m2v/worker dev' });
  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'Node.js 运行时', ok: major >= 20, detail: `当前 ${process.version}`, fix: '安装 Node.js 20 或更高版本后重启 Web 与 Worker 服务' });
  let pnpmVersion = '';
  try { pnpmVersion = (await exec(pnpmBinary, ['--version'], { windowsHide: true, timeout: 15_000, shell: process.platform === 'win32' })).stdout.trim(); } catch { pnpmVersion = ''; }
  checks.push({ name: 'pnpm 包管理器', ok: Boolean(pnpmVersion), warn: !pnpmVersion, detail: pnpmVersion ? `pnpm ${pnpmVersion}` : '未检测到 pnpm 命令', fix: '执行 npm install -g pnpm 后重新打开终端（若你使用 npm 安装依赖可忽略此项）' });
  let databaseOk = true; let databaseDetail = '';
  try { const projectCount = await db.project.count(); databaseDetail = `SQLite 可读写，现有 ${projectCount} 个项目`; } catch (error) { databaseOk = false; databaseDetail = `数据库不可用：${String(error)}`; }
  checks.push({ name: '数据库', ok: databaseOk, detail: databaseDetail, fix: '确认进程对仓库 data 目录有写权限，并执行 pnpm db:push 重建数据库结构' });
  let diskOk = true; let diskWarn = false; let diskDetail = '';
  try {
    const stats = await statfs(repoRoot);
    const freeGb = gb(stats.bfree * stats.bsize), totalGb = gb(stats.blocks * stats.bsize);
    diskOk = freeGb >= 1; diskWarn = freeGb >= 1 && freeGb < 5;
    diskDetail = `数据盘剩余 ${freeGb} GB / 共 ${totalGb} GB${diskWarn ? '，空间偏紧' : ''}`;
  } catch (error) { diskDetail = `无法读取磁盘信息：${String(error)}`; }
  checks.push({ name: '磁盘空间', ok: diskOk, warn: diskWarn, detail: diskDetail, fix: '清理 data/projects 下不再需要的项目与导出文件后重新检查（渲染和语音合成都需要数 GB 临时空间）' });
  const pythonPort = Number(new URL(process.env.PYTHON_SERVICE_URL ?? 'http://127.0.0.1:8000').port || 8000);
  const ollamaPort = Number(new URL(process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').port || 11434);
  const webPort = Number(process.env.PORT ?? 3000);
  const [webUp, pythonUp, ollamaUp] = await Promise.all([portOpen(webPort), portOpen(pythonPort), portOpen(ollamaPort)]);
  const portRows = [{ port: webPort, name: 'Web', up: webUp }, { port: pythonPort, name: 'Python', up: pythonUp }, { port: ollamaPort, name: 'Ollama', up: ollamaUp }];
  const closedPorts = portRows.filter(row => !row.up).map(row => `${row.name} ${row.port}`);
  const foreignPython = pythonUp && python.status !== 'fulfilled';
  checks.push({
    name: '端口占用', ok: !closedPorts.length && !foreignPython, warn: Boolean(closedPorts.length || foreignPython),
    detail: foreignPython ? `端口 ${pythonPort} 已有程序在监听，但 Python 服务未响应，该端口可能被其他程序占用` : closedPorts.length ? `以下端口未监听：${closedPorts.join('、')}` : `Web ${webPort}、Python ${pythonPort}、Ollama ${ollamaPort} 均在监听`,
    fix: '关闭占用端口的程序，或修改 PYTHON_SERVICE_URL / OLLAMA_BASE_URL 指向正确的端口后重启服务',
  });
  let writable = true; let writableDetail = '数据目录与静态资源目录可写';
  try { await access(join(repoRoot, 'data'), constants.W_OK); await access(join(process.cwd(), 'public'), constants.W_OK); } catch (error) { writable = false; writableDetail = `目录不可写：${String(error)}`; }
  checks.push({ name: 'Web 服务', ok: writable, detail: writable ? `${writableDetail}（运行中，端口 ${webPort}）` : writableDetail, fix: '确认进程对仓库的 data 与 apps/web/public 目录有写权限后重启 Web 服务' });
  const normalised: Check[] = checks.map(check => {
    const status = check.ok ? (check.warn ? 'warn' : 'ok') : 'fail';
    return { name: check.name, status, ok: status === 'ok', detail: check.detail, fix: check.fix };
  });
  return Response.json({
    checkedAt: new Date().toISOString(), checks: normalised,
    summary: { total: normalised.length, ok: normalised.filter(item => item.status === 'ok').length, warn: normalised.filter(item => item.status === 'warn').length, fail: normalised.filter(item => item.status === 'fail').length },
  });
}
