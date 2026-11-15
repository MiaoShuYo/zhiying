/**
 * 模型源 fixture HTTP 服务器（真实 HTTP 语义，不 mock fetch）：
 * Content-Length / Range / If-Range / ETag / 206 / 429 / 5xx / 无 Content-Length / 中断 / 慢速滴流 / 忽略 Range。
 * 记录每个请求的方法、Range 头、If-Range、是否中止，供断言真实续传语义。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';

export type SourceMode =
  | 'ok'
  | 'no-content-length'
  | 'range-ignored'
  | 'drip'
  | 'abort-mid'
  | 'always-429'
  | 'always-500'
  | '429-then-ok'
  | '500-then-ok'
  | '403'
  | '404';

export interface FixtureFileOptions {
  /** 服务端实际发送的字节。 */
  data: Buffer;
  mode?: SourceMode;
  /** 429-then-ok / 500-then-ok 的失败次数（默认 2）。 */
  failCount?: number;
  /** 自定义 ETag（默认由内容 sha 推导）。 */
  etag?: string;
  /** drip 模式每次写出的块大小（默认 4096）。 */
  chunkSize?: number;
  /** drip 模式块间延迟（默认 30ms）。 */
  chunkDelayMs?: number;
  /** 额外响应头。 */
  headers?: Record<string, string>;
}

interface FixtureFile extends Required<Pick<FixtureFileOptions, 'mode' | 'failCount' | 'chunkSize' | 'chunkDelayMs'>> {
  path: string;
  data: Buffer;
  etag: string;
  headers: Record<string, string>;
  attempts: number;
}

export interface RecordedRequest {
  path: string;
  method: string;
  range?: string;
  ifRange?: string;
  mode: SourceMode;
  status: number;
  bytesSent: number;
  aborted: boolean;
  at: number;
  endedAt?: number;
}

export interface FixtureSourceServer {
  url: string;
  port: number;
  /** 完整 URL：`${baseUrl}${routePath}` */
  fileUrl: (routePath: string) => string;
  requests: RecordedRequest[];
  requestsFor: (routePath: string) => RecordedRequest[];
  /** 观测到的最大并行请求数（用于断言下载并发上限）。 */
  maxConcurrentRequests: () => number;
  setMode: (routePath: string, mode: SourceMode) => void;
  resetAttempts: (routePath?: string) => void;
  close: () => Promise<void>;
}

function normalizeRoute(routePath: string): string {
  return routePath.startsWith('/') ? routePath : `/${routePath}`;
}

function parseRange(rangeHeader: string | undefined, total: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!m) return null;
  const start = m[1] === '' ? -1 : Number(m[1]);
  const end = m[2] === '' ? total - 1 : Number(m[2]);
  if (start === -1) {
    // suffix range: bytes=-N
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  if (!Number.isFinite(start) || start >= total) return null;
  return { start, end: Math.min(end, total - 1) };
}

/**
 * 启动 fixture 模型源。测试中通过 addFile 注册文件，再 start() 获得 URL。
 */
export class FixtureModelSource {
  private readonly files = new Map<string, FixtureFile>();
  private server: http.Server | null = null;
  readonly requests: RecordedRequest[] = [];
  private baseUrl = '';

  constructor(private readonly host = '127.0.0.1') {}

  addFile(routePath: string, options: FixtureFileOptions): this {
    const p = normalizeRoute(routePath);
    this.files.set(p, {
      path: p,
      data: options.data,
      mode: options.mode ?? 'ok',
      failCount: options.failCount ?? 2,
      etag: options.etag ?? `"${crypto.createHash('sha256').update(options.data).digest('hex').slice(0, 16)}"`,
      chunkSize: options.chunkSize ?? 4096,
      chunkDelayMs: options.chunkDelayMs ?? 30,
      headers: options.headers ?? {},
      attempts: 0,
    });
    return this;
  }

  /** 简单 JSON 端点（如 fake HF API / manifest 托管）。 */
  addJson(routePath: string, value: unknown): this {
    return this.addFile(routePath, { data: Buffer.from(JSON.stringify(value), 'utf8'), headers: { 'content-type': 'application/json' } });
  }

  setMode(routePath: string, mode: SourceMode): void {
    const file = this.files.get(normalizeRoute(routePath));
    if (!file) throw new Error(`unknown fixture file ${routePath}`);
    file.mode = mode;
  }

  resetAttempts(routePath?: string): void {
    if (routePath) {
      const file = this.files.get(normalizeRoute(routePath));
      if (file) file.attempts = 0;
      return;
    }
    for (const f of this.files.values()) f.attempts = 0;
  }

  getFile(routePath: string): FixtureFile | undefined {
    return this.files.get(normalizeRoute(routePath));
  }

  fileUrl(routePath: string): string {
    const p = normalizeRoute(routePath);
    if (!this.baseUrl) throw new Error('server not started');
    return `${this.baseUrl}${p}`;
  }

  requestsFor(routePath: string): RecordedRequest[] {
    const p = normalizeRoute(routePath);
    return this.requests.filter((r) => r.path === p);
  }

  async start(): Promise<FixtureSourceServer> {
    const server = http.createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, this.host, () => resolve());
    });
    const addr = server.address() as AddressInfo;
    this.baseUrl = `http://${this.host}:${addr.port}`;
    return {
      url: this.baseUrl,
      port: addr.port,
      fileUrl: (p: string) => this.fileUrl(p),
      requests: this.requests,
      requestsFor: (p: string) => this.requestsFor(p),
      maxConcurrentRequests: () => {
        const now = Date.now();
        const points: Array<{ at: number; delta: number }> = [];
        for (const request of this.requests) {
          points.push({ at: request.at, delta: 1 });
          points.push({ at: request.endedAt ?? now, delta: -1 });
        }
        points.sort((a, b) => a.at - b.at || a.delta - b.delta);
        let current = 0;
        let max = 0;
        for (const point of points) {
          current += point.delta;
          max = Math.max(max, current);
        }
        return max;
      },
      setMode: (p: string, m: SourceMode) => this.setMode(p, m),
      resetAttempts: (p?: string) => this.resetAttempts(p),
      close: async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
        this.server = null;
      },
    };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = (req.url ?? '/').split('?')[0];
    const file = this.files.get(urlPath);
    const record: RecordedRequest = {
      path: urlPath,
      method: req.method ?? 'GET',
      range: typeof req.headers.range === 'string' ? req.headers.range : undefined,
      ifRange: typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined,
      mode: file?.mode ?? 'ok',
      status: 0,
      bytesSent: 0,
      aborted: false,
      at: Date.now(),
    };
    this.requests.push(record);
    res.once('close', () => {
      record.endedAt = Date.now();
      if (!res.writableEnded) record.aborted = true;
    });

    if (!file) {
      record.status = 404;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    file.attempts += 1;
    const attempt = file.attempts;
    const headers: Record<string, string> = { 'cache-control': 'no-store', etag: file.etag, ...file.headers };

    if (file.mode === 'always-429') {
      record.status = 429;
      res.writeHead(429, { ...headers, 'retry-after': '0' });
      res.end('too many requests');
      return;
    }
    if (file.mode === '429-then-ok' && attempt <= file.failCount) {
      record.status = 429;
      res.writeHead(429, { ...headers, 'retry-after': '0' });
      res.end('too many requests');
      return;
    }
    if (file.mode === 'always-500') {
      record.status = 500;
      res.writeHead(500, headers);
      res.end('internal error');
      return;
    }
    if (file.mode === '500-then-ok' && attempt <= file.failCount) {
      record.status = 500;
      res.writeHead(500, headers);
      res.end('internal error');
      return;
    }
    if (file.mode === '403') {
      record.status = 403;
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    if (file.mode === '404') {
      record.status = 404;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    const total = file.data.length;

    if (file.mode === 'no-content-length') {
      record.status = 200;
      res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream' });
      const step = file.chunkDelayMs > 0 ? Math.min(file.chunkSize, 2048) : 4096;
      let offset = 0;
      const pump = () => {
        if (res.writableEnded || res.destroyed) return;
        const chunk = file.data.subarray(offset, offset + step);
        offset += chunk.length;
        record.bytesSent = offset;
        res.write(chunk);
        if (offset >= total) {
          res.end();
          return;
        }
        if (file.chunkDelayMs > 0) setTimeout(pump, file.chunkDelayMs);
        else setImmediate(pump);
      };
      pump();
      return;
    }

    if (file.mode === 'drip') {
      record.status = 200;
      res.writeHead(200, {
        ...headers,
        'content-type': 'application/octet-stream',
        'content-length': String(total),
        'accept-ranges': 'bytes',
      });
      let offset = 0;
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(timer);
          return;
        }
        const chunk = file.data.subarray(offset, offset + file.chunkSize);
        offset += chunk.length;
        record.bytesSent = offset;
        res.write(chunk);
        if (offset >= total) {
          clearInterval(timer);
          res.end();
        }
      }, file.chunkDelayMs);
      return;
    }

    if (file.mode === 'abort-mid') {
      record.status = 200;
      res.writeHead(200, {
        ...headers,
        'content-type': 'application/octet-stream',
        'content-length': String(total),
        'accept-ranges': 'bytes',
      });
      const half = Math.max(1, Math.floor(total / 2));
      res.write(file.data.subarray(0, half));
      record.bytesSent = half;
      setTimeout(() => {
        if (!res.destroyed) {
          res.destroy();
        }
      }, 20);
      return;
    }

    // 正常模式（ok / range-ignored）：支持 Range/If-Range/206
    const honorRange = file.mode !== 'range-ignored';
    const ifRangeOk = !record.ifRange || record.ifRange === file.etag;
    const range = honorRange && ifRangeOk ? parseRange(record.range, total) : null;

    if (record.range && honorRange && !ifRangeOk) {
      // ETag 变化：服务端允许从 0 重下（200 全量）
      record.status = 200;
      res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(total), 'accept-ranges': 'bytes' });
      record.bytesSent = total;
      res.end(file.data);
      return;
    }

    if (range) {
      const body = file.data.subarray(range.start, range.end + 1);
      record.status = 206;
      record.bytesSent = body.length;
      res.writeHead(206, {
        ...headers,
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        'content-range': `bytes ${range.start}-${range.end}/${total}`,
        'accept-ranges': 'bytes',
      });
      res.end(body);
      return;
    }

    record.status = 200;
    record.bytesSent = total;
    res.writeHead(200, {
      ...headers,
      'content-type': 'application/octet-stream',
      'content-length': String(total),
      'accept-ranges': 'bytes',
    });
    res.end(file.data);
  }
}

/** 便捷启动：注册单个文件的源。 */
export async function startFixtureSource(files: Array<{ path: string; options: FixtureFileOptions }> = []): Promise<{ source: FixtureModelSource; server: FixtureSourceServer }> {
  const source = new FixtureModelSource();
  for (const f of files) source.addFile(f.path, f.options);
  const server = await source.start();
  return { source, server };
}
