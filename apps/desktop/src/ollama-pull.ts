import { execFile, spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * #105 受管 Ollama 拉取适配器。
 *
 * 只调用 `ollama pull <model>` 并解析官方 NDJSON 流（status/digest/total/completed）。
 * 暂停/取消时终止本进程，恢复时重新 pull，由 Ollama 官方层复用机制续传。
 */

const execFileAsync = promisify(execFile);

export type OllamaPullPhase = 'download' | 'verify';

export interface OllamaPullEvent {
  status: string;
  phase: OllamaPullPhase;
  digest?: string;
  total?: number;
  completed?: number;
}

export interface OllamaPullOptions {
  /**
   * #136: base URL of the managed Ollama server (`http://127.0.0.1:<port>`). When set, progress is read
   * from the streaming `/api/pull` response, which is the documented NDJSON protocol; the CLI renders
   * progress bars on stderr instead. Without it the legacy `ollama pull` subprocess path is used.
   */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  exe: string;
  model: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onEvent?: (event: OllamaPullEvent) => void;
  spawnImpl?: typeof nodeSpawn;
}

export interface OllamaPullResult {
  ok: boolean;
  aborted: boolean;
  digest?: string;
  exitCode: number | null;
  error?: string;
}

/** 把一行 Ollama NDJSON 状态映射为进度事件（无法识别/非 JSON 返回 undefined）。 */
export function parseOllamaPullLine(line: string): OllamaPullEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status : '';
  if (!status) return undefined;
  const event: OllamaPullEvent = {
    status,
    phase: /verif|writing manifest|success/i.test(status) ? 'verify' : 'download',
  };
  if (typeof record.digest === 'string' && record.digest.trim()) event.digest = record.digest.trim();
  if (typeof record.total === 'number' && Number.isFinite(record.total) && record.total >= 0) event.total = record.total;
  if (typeof record.completed === 'number' && Number.isFinite(record.completed) && record.completed >= 0) {
    event.completed = record.completed;
  }
  return event;
}

async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 20_000 });
    } catch {
      /* 已退出。 */
    }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* 已退出。 */
  }
}

/**
 * 运行一次 `ollama pull`；支持通过 `abort()` 安全终止。
 */
export class OllamaPullRunner {
  private readonly options: OllamaPullOptions;
  private child: ChildProcess | undefined;
  private controller: AbortController | undefined;
  private aborted = false;
  private running = false;

  constructor(options: OllamaPullOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 执行 pull；成功返回 ok=true。`abort()` 后返回 aborted=true。 */
  async pull(): Promise<OllamaPullResult> {
    if (this.running) throw new Error('Ollama pull 已在进行中');
    this.running = true;
    this.aborted = false;
    if (this.options.baseUrl) {
      try {
        return await this.pullOverHttp(this.options.baseUrl);
      } finally {
        this.running = false;
        this.controller = undefined;
      }
    }
    const spawnImpl = this.options.spawnImpl ?? nodeSpawn;
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env) };
    let child: ChildProcess;
    try {
      child = spawnImpl(this.options.exe, ['pull', this.options.model], {
        cwd: this.options.cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.running = false;
      return { ok: false, aborted: false, exitCode: null, error: `启动 ollama pull 失败：${(error as Error).message}` };
    }
    this.child = child;
    let stdoutBuffer = '';
    let stderrTail = '';
    let lastDigest: string | undefined;
    const handleLine = (line: string) => {
      const event = parseOllamaPullLine(line);
      if (!event) return;
      if (event.digest) lastDigest = event.digest;
      try {
        this.options.onEvent?.(event);
      } catch {
        /* 进度回调异常不影响 pull。 */
      }
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4000);
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: string }>(resolvePromise => {
      let settled = false;
      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        resolvePromise({ code, signal });
      });
      child.once('error', (error: Error) => {
        if (settled) return;
        settled = true;
        resolvePromise({ code: null, signal: null, spawnError: error.message });
      });
    });
    if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
    this.running = false;
    this.child = undefined;
    if (this.aborted) {
      return { ok: false, aborted: true, exitCode: exit.code, ...(lastDigest ? { digest: lastDigest } : {}) };
    }
    if (exit.spawnError) {
      return { ok: false, aborted: false, exitCode: null, error: `无法执行 ollama pull：${exit.spawnError}` };
    }
    if (exit.code === 0) {
      return { ok: true, aborted: false, exitCode: 0, ...(lastDigest ? { digest: lastDigest } : {}) };
    }
    let error = `ollama pull 失败（退出码 ${exit.code ?? '未知'}）：${stderrTail.trim() || '未返回错误信息'}`;
    if (/connection refused|failed to connect|无法连接|connect: connection refused/i.test(stderrTail)) {
      error = '无法连接受管 Ollama 服务，请先通过知影启动器启动 Ollama 后再下载模型。';
    } else if (/pull model manifest: file does not exist|not found/i.test(stderrTail)) {
      error = `Ollama 源中不存在模型 ${this.options.model}（请检查网络与模型名称）。`;
    }
    return { ok: false, aborted: false, exitCode: exit.code, error };
  }

  /** #136: stream `/api/pull` from the managed server and map its NDJSON lines to progress events. */
  private async pullOverHttp(baseUrl: string): Promise<OllamaPullResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    this.controller = controller;
    let lastDigest: string | undefined;
    let lastStatus = '';
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.options.model, stream: true }),
        signal: controller.signal,
      });
    } catch (error) {
      if (this.aborted) return { ok: false, aborted: true, exitCode: null };
      return { ok: false, aborted: false, exitCode: null, error: `无法连接受管 Ollama 服务（${(error as Error).message}），请先通过知影启动器启动 Ollama 后再下载模型。` };
    }
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      let message = detail;
      try { message = (JSON.parse(detail) as { error?: string }).error ?? detail; } catch { /* plain text */ }
      return { ok: false, aborted: false, exitCode: null, error: `Ollama 拉取失败（HTTP ${response.status}）：${message.trim() || '未返回错误信息'}` };
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let failure: string | undefined;
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const record = JSON.parse(trimmed) as { error?: unknown };
        if (typeof record.error === 'string' && record.error) { failure = record.error; return; }
      } catch { return; }
      const event = parseOllamaPullLine(trimmed);
      if (!event) return;
      lastStatus = event.status;
      if (event.digest) lastDigest = event.digest;
      try { this.options.onEvent?.(event); } catch { /* 进度回调异常不影响 pull。 */ }
    };
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          handleLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleLine(buffer);
    } catch (error) {
      if (this.aborted) return { ok: false, aborted: true, exitCode: null, ...(lastDigest ? { digest: lastDigest } : {}) };
      return { ok: false, aborted: false, exitCode: null, error: `Ollama 拉取中断：${(error as Error).message}` };
    }
    if (this.aborted) return { ok: false, aborted: true, exitCode: null, ...(lastDigest ? { digest: lastDigest } : {}) };
    if (failure) {
      const error = /file does not exist|not found/i.test(failure)
        ? `Ollama 源中不存在模型 ${this.options.model}（请检查网络与模型名称）。`
        : `Ollama 拉取失败：${failure}`;
      return { ok: false, aborted: false, exitCode: null, error };
    }
    if (!/^success$/i.test(lastStatus)) {
      return { ok: false, aborted: false, exitCode: null, error: 'Ollama 拉取未完成：服务端在返回 success 之前结束了响应。' };
    }
    return { ok: true, aborted: false, exitCode: 0, ...(lastDigest ? { digest: lastDigest } : {}) };
  }

  /** 安全终止当前 pull（不会结束用户其它 Ollama 进程，只结束本次子进程树或 HTTP 请求）。 */
  async abort(): Promise<void> {
    this.aborted = true;
    this.controller?.abort();
    const child = this.child;
    if (!child) return;
    await killTree(child.pid);
  }
}
