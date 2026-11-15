/**
 * Fake managed services（web/python/worker/ollama）真实子进程：
 * - 监听回环端口，提供健康端点；
 * - 支持延迟就绪 / 提前退出 / 指定健康状态码 / 环境记录；
 * - 响应 SIGTERM/SIGINT 优雅退出，供 launcher 的 tree-kill / stop 测试使用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { NODE_EXE } from './temp';

/** fake 服务脚本源码：参数解析用简单手写，避免依赖。 */
export function fakeServiceScriptSource(): string {
  return `#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const prefix = name + '=';
  const inline = argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const port = Number(getArg('--port', process.env.FAKE_PORT || 0));
const healthPath = getArg('--health-path', '/health');
const healthDelay = Number(getArg('--health-delay', '0'));
const healthStatus = Number(getArg('--health-status', '200'));
const exitAfter = Number(getArg('--exit-after', '0'));
const exitCode = Number(getArg('--exit-code', '3'));
const pidFile = getArg('--pid-file', '');
const recordFile = getArg('--record-file', '');
const role = getArg('--role', 'service');
if (pidFile) { try { fs.writeFileSync(pidFile, String(process.pid)); } catch {} }
if (recordFile) {
  try {
    const keys = Object.keys(process.env).filter((k) => /^(M2V_|OLLAMA_|HF_|F5TTS_|PYTHON_|DATABASE_URL|TRANSFORMERS_CACHE|PORT$|TMP$|TEMP$|NODE_ENV$|REMOTION_)/.test(k));
    const snapshot = {};
    for (const k of keys) snapshot[k] = process.env[k];
    fs.writeFileSync(recordFile, JSON.stringify({ role, argv, env: snapshot, pid: process.pid, cwd: process.cwd() }, null, 2));
  } catch {}
}
let started = Date.now();
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === healthPath) {
    const ready = Date.now() - started >= healthDelay;
    const status = ready ? healthStatus : 503;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: ready, role, pid: process.pid, uptimeMs: Date.now() - started }));
    return;
  }
  if (url === '/' || url === '/api/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ role, ok: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
server.listen(port, '127.0.0.1', () => {
  const listeningPort = server.address().port;
  process.stdout.write('[fake-service] role=' + role + ' listening on 127.0.0.1:' + listeningPort + ' healthPath=' + healthPath + '\\n');
  if (recordFile) {
    try {
      const data = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      data.listeningPort = server.address().port;
      fs.writeFileSync(recordFile, JSON.stringify(data, null, 2));
    } catch {}
  }
});
if (exitAfter > 0) {
  setTimeout(() => {
    process.stderr.write('[fake-service] exiting early role=' + role + ' code=' + exitCode + '\\n');
    process.exit(exitCode);
  }, exitAfter);
}
const shutdown = () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } setTimeout(() => process.exit(0), 500); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (exitAfter > 0) setTimeout(() => process.exit(exitCode), exitAfter);
`;
}

export function writeFakeServiceScript(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'fake-service.mjs');
  fs.writeFileSync(file, fakeServiceScriptSource(), 'utf8');
  return file;
}

export interface FakeServiceOptions {
  port: number;
  role?: string;
  healthPath?: string;
  healthDelayMs?: number;
  healthStatus?: number;
  exitAfterMs?: number;
  exitCode?: number;
  workDir: string;
  env?: NodeJS.ProcessEnv;
  recordFile?: string;
  pidFile?: string;
}

/** 组装 fake 服务的命令/参数（用于 ManagedServiceSpec）。 */
export function fakeServiceCommand(dir: string): string {
  return NODE_EXE;
}

export function fakeServiceArgs(scriptPath: string, options: FakeServiceOptions): string[] {
  const args = [scriptPath, '--port', String(options.port), '--role', options.role ?? 'service'];
  if (options.healthPath) args.push('--health-path', options.healthPath);
  if (options.healthDelayMs) args.push('--health-delay', String(options.healthDelayMs));
  if (options.healthStatus !== undefined) args.push('--health-status', String(options.healthStatus));
  if (options.exitAfterMs) args.push('--exit-after', String(options.exitAfterMs));
  if (options.exitCode !== undefined) args.push('--exit-code', String(options.exitCode));
  if (options.recordFile) args.push('--record-file', options.recordFile);
  if (options.pidFile) args.push('--pid-file', options.pidFile);
  return args;
}

export interface ServiceRecord {
  role: string;
  argv: string[];
  env: Record<string, string>;
  pid: number;
  cwd: string;
  listeningPort?: number;
}

export function readServiceRecord(file: string): ServiceRecord | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ServiceRecord;
  } catch {
    return null;
  }
}
