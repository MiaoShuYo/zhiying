/**
 * 端口助手：临时端口分配（127.0.0.1 回环）、HTTP 等待、端口占用模拟。
 */
import net from 'node:net';
import http from 'node:http';

export const LOOPBACK = '127.0.0.1';

/** 取一个当前空闲的回环端口。 */
export function getFreePort(host = LOOPBACK): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no address')));
      }
    });
  });
}

/** 一次性取 n 个不同空闲端口（分配后立刻释放可能导致复用，调用方应尽快使用）。 */
export async function getFreePorts(n: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < n) {
    const p = await getFreePort();
    if (!ports.has(p)) ports.add(p);
  }
  return [...ports];
}

/** 判定端口是否可连接（connect 成功 = 有进程监听）。 */
export function isPortOpen(port: number, host = LOOPBACK, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (open: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 在指定端口占坑（模拟外部进程端口冲突），返回 close()。 */
export function occupyPort(port: number, host = LOOPBACK): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      sock.end('busy');
    });
    srv.once('error', reject);
    srv.listen(port, host, () => {
      resolve({
        close: () => new Promise<void>((res) => srv.close(() => res())),
      });
    });
  });
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  expectStatus?: number;
}

/** 轮询 URL 直到返回期望状态码；返回最后一次响应。用于健康检查等待。 */
export async function waitForHttp(url: string, opts: WaitOptions = {}): Promise<{ status: number; body: string; headers: Headers }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 150;
  const expect = opts.expectStatus ?? 200;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const body = await res.text();
      if (res.status === expect || (typeof expect === 'function' && expect(res.status))) {
        return { status: res.status, body, headers: res.headers };
      }
      lastErr = new Error(`status ${res.status} for ${url}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitForHttp timeout after ${timeoutMs}ms url=${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** 轮询端口直到打开/关闭。 */
export async function waitForPort(port: number, open: boolean, opts: { timeoutMs?: number; intervalMs?: number; host?: string } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await isPortOpen(port, opts.host ?? LOOPBACK, 500);
    if (current === open) return;
    await sleep(opts.intervalMs ?? 100);
  }
  throw new Error(`waitForPort timeout: port ${port} expected open=${open}`);
}

/** 监听并记录一次 HTTP 请求的最小服务器（用于 openBrowser / 健康探测旁路）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface SimpleServer {
  port: number;
  url: string;
  requests: Array<{ method: string; url: string; headers: Record<string, string | string[] | undefined> }>;
  close: () => Promise<void>;
}

/** 启动一个测试用 HTTP 服务器，handler 可自定义；默认对所有请求 200。 */
export async function startSimpleServer(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<SimpleServer> {
  const requests: SimpleServer['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (handler) handler(req, res);
    else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('listen failed');
  return {
    port: addr.port,
    url: `http://${LOOPBACK}:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
