import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { manifestEntryById } from './model-manifest.js';
import type { ModelManifest } from './model-manifest.js';
import { ModelDownloadManager } from './downloader.js';
import type { ModelState } from './downloader.js';
import type { ModelDirectoryResolver } from './model-paths.js';
import { renderModelManagerHtml } from './ui/model-manager.js';

/**
 * #105 模型管理器 HTTP 服务（仅绑定 127.0.0.1）。
 *
 * 路由：GET /（HTML）、GET /api/models、GET /api/events（SSE）、
 * POST /api/models/:id/{start|pause|resume|cancel|retry}。
 */

export interface ModelManagerServer {
  url: string;
  close(): Promise<void>;
}

export interface ModelManagerServerInput {
  manager: ModelDownloadManager;
  resolver: ModelDirectoryResolver;
  installRoot: string;
  port: number;
  host?: string;
}

interface ModelsPayload {
  installRoot: string;
  modelsRoot: string;
  disk: { modelsRoot: string; writable: boolean; freeBytes: number };
  overall: ReturnType<typeof ModelDownloadManager.computeOverall>;
  models: Array<ModelState & Record<string, unknown>>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_BODY_BYTES = 64 * 1024;
const ACTIONS = new Set(['start', 'pause', 'resume', 'cancel', 'retry', 'verify']);

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(body);
}

function sendText(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.statusCode = status;
  response.setHeader('content-type', contentType);
  response.setHeader('cache-control', 'no-store');
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

async function buildPayload(
  manager: ModelDownloadManager,
  resolver: ModelDirectoryResolver,
  installRoot: string,
): Promise<ModelsPayload> {
  const manifest: ModelManifest = manager.getManifest();
  const states = manager.list();
  const disk = await resolver.describe();
  const models = states.map(state => {
    const entry = manifestEntryById(manifest, state.id);
    let installPath = '';
    if (entry) {
      try {
        installPath = resolver.resolveModelInstallPath(entry.installDir);
      } catch {
        installPath = '';
      }
    }
    return {
      ...state,
      name: entry?.name ?? state.id,
      purpose: entry?.purpose ?? 'unknown',
      required: entry?.required ?? false,
      sizeBytes: entry?.totalBytes ?? 0,
      installPath,
      license: entry?.license ?? { name: '未知', notes: '', commercialUse: 'unknown' },
    };
  });
  return {
    installRoot,
    modelsRoot: resolver.resolveModelsRoot(),
    disk,
    overall: ModelDownloadManager.computeOverall(states),
    models,
  };
}

/**
 * 启动模型管理器服务；`port: 0` 时由系统分配端口并通过返回的 `url` 暴露。
 */
export async function createModelManagerServer(input: ModelManagerServerInput): Promise<ModelManagerServer> {
  const host = input.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('模型管理器只允许绑定本机回环地址（127.0.0.1）');
  const sseClients = new Set<ServerResponse>();
  let keepAlive: NodeJS.Timeout | undefined;
  let closed = false;

  const sendEvent = (client: ServerResponse, payload: ModelsPayload): void => {
    client.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendJson(response, 500, { ok: false, error: (error as Error).message || '模型管理器内部错误' });
    });
  });

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${host}`);
    const pathname = decodeURIComponent(url.pathname);
    const method = request.method ?? 'GET';
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      sendText(response, 200, 'text/html; charset=utf-8', renderModelManagerHtml());
      return;
    }
    if (method === 'GET' && pathname === '/api/models') {
      sendJson(response, 200, await buildPayload(input.manager, input.resolver, input.installRoot));
      return;
    }
    if (method === 'GET' && pathname === '/api/events') {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/event-stream; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.setHeader('connection', 'keep-alive');
      response.flushHeaders();
      sseClients.add(response);
      try {
        sendEvent(response, await buildPayload(input.manager, input.resolver, input.installRoot));
      } catch {
        /* 初始事件失败不影响后续推送。 */
      }
      request.on('close', () => {
        sseClients.delete(response);
      });
      return;
    }
    const actionMatch = pathname.match(/^\/api\/models\/([^/]+)\/([a-z]+)$/);
    if (method === 'POST' && actionMatch) {
      const modelId = actionMatch[1];
      const action = actionMatch[2];
      if (!ACTIONS.has(action)) {
        sendJson(response, 400, { ok: false, error: `不支持的模型操作：${action}` });
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `请求体无效：${(error as Error).message}` });
        return;
      }
      try {
        if (action === 'start') await input.manager.start([modelId]);
        else if (action === 'pause') await input.manager.pause(modelId);
        else if (action === 'resume') await input.manager.resume(modelId);
        else if (action === 'retry') await input.manager.retry(modelId);
        else if (action === 'verify') await input.manager.verify(modelId);
        else await input.manager.cancel(modelId, { keepPartial: body.keepPartial !== false });
        sendJson(response, 200, { ok: true, model: input.manager.get(modelId) });
      } catch (error) {
        const message = (error as Error).message || '模型操作失败';
        const status = /未知模型 id/.test(message) ? 404 : 400;
        sendJson(response, status, { ok: false, error: message });
      }
      return;
    }
    sendJson(response, 404, { ok: false, error: `未知路由：${method} ${pathname}` });
  };

  const unsubscribe = input.manager.onProgress(states => {
    if (closed) return;
    void buildPayload(input.manager, input.resolver, input.installRoot)
      .then(payload => {
        for (const client of sseClients) {
          try {
            sendEvent(client, payload);
          } catch {
            sseClients.delete(client);
          }
        }
      })
      .catch(() => undefined);
    void states;
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(input.port, host, () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('模型管理器服务未能获得监听端口');
  }
  const actualPort = (address as AddressInfo).port;
  keepAlive = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': keepalive\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, 25_000);
  keepAlive.unref?.();

  return {
    url: `http://${host}:${actualPort}`,
    close: async () => {
      closed = true;
      unsubscribe();
      if (keepAlive) clearInterval(keepAlive);
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          /* 已关闭。 */
        }
      }
      sseClients.clear();
      await new Promise<void>(resolvePromise => {
        server.close(() => resolvePromise());
        setTimeout(() => resolvePromise(), 2000).unref?.();
      });
    },
  };
}
