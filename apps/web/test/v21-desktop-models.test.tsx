/**
 * #105 D web「设置 → 模型」入口：只读状态读取、纯展示组件渲染与 XSS 转义、API 路由契约。
 * 真实文件系统（临时 InstallRoot），组件用 react-dom/server 静态渲染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { readDesktopModelStatus, defaultDesktopInstallRoot } from '../src/lib/desktop-models';
import { DesktopModels } from '../src/components/desktop-models';
import type { DesktopModelStatusResult } from '../src/lib/desktop-models';
import { makeTempRoot, cleanupRegisteredTempDirs } from '../../desktop/test/_helpers/temp';
import { makeManifest, makeHttpEntry } from '../../desktop/test/_helpers/fixtures';
import { deterministicBytes, writeFileDeep } from '../../desktop/test/_helpers/fsx';
import { GET as modelsRouteGet } from '../src/app/api/models/route';

function makeInstallRoot(t: test.TestContext, label: string, opts: { states?: Record<string, unknown>; managerPort?: number } = {}): string {
  const root = makeTempRoot(label);
  t.after(() => cleanupRegisteredTempDirs());
  const modelsRoot = path.join(root, 'models');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(modelsRoot, '.downloads'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'install.json'),
    JSON.stringify({
      schemaVersion: 1,
      product: 'zhiying',
      version: '1.8.0',
      installRoot: root,
      installedAt: new Date().toISOString(),
      perUser: true,
      payloadProfile: 'lite',
      runtime: { node: 'runtime\\node\\node.exe' },
      ports: { web: 3000, python: 8000, ollama: 11434, manager: opts.managerPort ?? 8899 },
      managedProcesses: { ollama: true },
      modelManifest: 'models/.downloads/manifest.json',
      firstRunCompleted: true,
    }),
  );
  const good = makeHttpEntry({ id: 'good-model', name: '已装模型', purpose: 'tts', files: [{ path: 'model.bin', data: deterministicBytes(16, 'good') }], baseUrl: 'http://fixture.invalid/dl' });
  const bad = makeHttpEntry({
    id: 'restricted-model',
    name: '受限模型 <x>',
    purpose: 'alignment',
    required: false,
    files: [{ path: 'model.bin', data: deterministicBytes(8, 'bad') }],
    baseUrl: 'http://fixture.invalid/dl',
    license: { name: 'CC BY-NC 4.0', commercialUse: 'restricted', notes: '非商业' },
  });
  fs.writeFileSync(
    path.join(modelsRoot, '.downloads', 'manifest.json'),
    JSON.stringify(makeManifest([good.entry, bad.entry]), null, 2),
  );
  if (opts.states) {
    fs.writeFileSync(
      path.join(modelsRoot, '.downloads', 'state.json'),
      JSON.stringify({ schemaVersion: 1, models: opts.states }),
    );
  }
  return root;
}

test('[#105 D] readDesktopModelStatus：开发模式/目录缺失/配置损坏/清单损坏 → available:false 不抛错', async (t) => {
  t.after(() => cleanupRegisteredTempDirs());
  // 开发模式
  const dev = await readDesktopModelStatus({ env: { M2V_DEV_MODE: '1' } as unknown as NodeJS.ProcessEnv });
  assert.equal(dev.available, false);
  assert.match(dev.reason ?? '', /开发模式/);
  assert.deepEqual(dev.models, []);
  // 目录不存在
  const missing = await readDesktopModelStatus({ installRoot: path.join(makeTempRoot('web-missing'), 'no-such'), env: {} as unknown as NodeJS.ProcessEnv });
  assert.equal(missing.available, false);
  assert.match(missing.reason ?? '', /未检测到|安装版目录/);
  // 无 config
  const noConfig = makeTempRoot('web-noconfig');
  const noConfigResult = await readDesktopModelStatus({ installRoot: noConfig, env: {} as unknown as NodeJS.ProcessEnv });
  assert.equal(noConfigResult.available, false);
  assert.match(noConfigResult.reason ?? '', /install\.json/);
  // config 损坏
  const corruptConfig = makeTempRoot('web-corrupt-config');
  fs.mkdirSync(path.join(corruptConfig, 'config'), { recursive: true });
  fs.writeFileSync(path.join(corruptConfig, 'config', 'install.json'), '{ bad json');
  const corruptResult = await readDesktopModelStatus({ installRoot: corruptConfig, env: {} as unknown as NodeJS.ProcessEnv });
  assert.equal(corruptResult.available, false);
  assert.match(corruptResult.reason ?? '', /损坏|无法读取/);
  // 清单缺失
  const noManifest = makeTempRoot('web-nomanifest');
  fs.mkdirSync(path.join(noManifest, 'config'), { recursive: true });
  fs.writeFileSync(path.join(noManifest, 'config', 'install.json'), JSON.stringify({ installRoot: noManifest, modelManifest: 'models/.downloads/manifest.json' }));
  const noManifestResult = await readDesktopModelStatus({ installRoot: noManifest, env: {} as unknown as NodeJS.ProcessEnv });
  assert.equal(noManifestResult.available, false);
  assert.match(noManifestResult.reason ?? '', /清单/);
  // 清单损坏
  const corruptManifestRoot = makeInstallRoot(t, 'web-corrupt-manifest');
  fs.writeFileSync(path.join(corruptManifestRoot, 'models', '.downloads', 'manifest.json'), '{ not-json');
  const corruptManifest = await readDesktopModelStatus({ installRoot: corruptManifestRoot, env: {} as unknown as NodeJS.ProcessEnv });
  assert.equal(corruptManifest.available, false);
  assert.match(corruptManifest.reason ?? '', /清单已损坏|损坏/);
});

test('[#105 D] readDesktopModelStatus：有效安装 → 模型行/路径/进度/许可/管理器 URL 正确', async (t) => {
  const root = makeInstallRoot(t, 'web-valid', {
    managerPort: 8899,
    states: {
      'good-model': { status: 'installed', receivedBytes: 16, totalBytes: 16, percent: 100 },
      'restricted-model': { status: 'downloading', receivedBytes: 4, totalBytes: 8, percent: 50 },
    },
  });
  const result = await readDesktopModelStatus({ installRoot: root, env: {} as unknown as NodeJS.ProcessEnv });
  assert.equal(result.available, true, result.reason);
  assert.equal(path.resolve(result.installRoot!).toLowerCase(), path.resolve(root).toLowerCase());
  assert.equal(path.resolve(result.modelsRoot!).toLowerCase(), path.resolve(path.join(root, 'models')).toLowerCase());
  assert.equal(result.managerUrl, 'http://127.0.0.1:8899');
  assert.equal(result.models.length, 2);
  const good = result.models.find((m) => m.id === 'good-model')!;
  assert.equal(good.status, 'installed');
  assert.equal(good.name, '已装模型');
  assert.equal(good.required, true);
  assert.equal(good.purpose, 'tts');
  assert.equal(good.sizeBytes, 16);
  assert.equal(good.licenseName, 'Fixture License');
  assert.equal(good.commercialUse, 'allowed');
  assert.ok(path.resolve(good.installPath).toLowerCase().startsWith(path.resolve(result.modelsRoot!).toLowerCase()));
  const restricted = result.models.find((m) => m.id === 'restricted-model')!;
  assert.equal(restricted.status, 'downloading');
  assert.equal(restricted.percent, 50);
  assert.equal(restricted.receivedBytes, 4);
  assert.equal(restricted.required, false);
  assert.equal(restricted.licenseName, 'CC BY-NC 4.0');
  assert.equal(restricted.commercialUse, 'restricted');
  // 总体进度按字节加权：4+16=20 / 24
  assert.equal(result.overall?.receivedBytes, 20);
  assert.equal(result.overall?.totalBytes, 24);
  assert.ok(Math.abs((result.overall?.percent ?? 0) - 83.3) < 0.2);
  assert.deepEqual(result.overall?.indeterminate, false);
  // 无凭据
  assert.ok(!JSON.stringify(result).toLowerCase().includes('password'));
  assert.ok(!JSON.stringify(result).toLowerCase().includes('apikey'));
});

test('[#105 D] readDesktopModelStatus：支持 M2V_INSTALL_ROOT 环境变量与默认 per-user 路径', async (t) => {
  const root = makeInstallRoot(t, 'web-env-root');
  const viaEnv = await readDesktopModelStatus({ env: { M2V_INSTALL_ROOT: root } as unknown as NodeJS.ProcessEnv });
  assert.equal(viaEnv.available, true, viaEnv.reason);
  const defaultRoot = defaultDesktopInstallRoot({ LOCALAPPDATA: 'D:\\Users\\X\\AppData\\Local' } as unknown as NodeJS.ProcessEnv);
  assert.equal(defaultRoot, path.join('D:\\Users\\X\\AppData\\Local', 'Programs', 'Zhiying'));
});

test('[#105-19] DesktopModels 组件：可用时渲染保存位置/名称/用途/大小/状态/许可/管理器链接', () => {
  const status: DesktopModelStatusResult = {
    available: true,
    installRoot: 'D:\\Zhiying',
    modelsRoot: 'D:\\Zhiying\\models',
    managerUrl: 'http://127.0.0.1:8790',
    overall: { receivedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024, percent: 25, indeterminate: false },
    models: [
      {
        id: 'qwen3-4b',
        name: 'Qwen3 4B',
        purpose: 'llm',
        required: true,
        sizeBytes: 2 * 1024 * 1024 * 1024,
        status: 'installed',
        receivedBytes: 2 * 1024 * 1024 * 1024,
        installPath: 'D:\\Zhiying\\models\\ollama',
        licenseName: 'Apache-2.0',
        commercialUse: 'allowed',
      },
      {
        id: 'f5-tts-base',
        name: 'F5-TTS',
        purpose: 'tts',
        required: true,
        sizeBytes: 1024 * 1024 * 1024,
        status: 'downloading',
        percent: 25,
        receivedBytes: 256 * 1024 * 1024,
        installPath: 'D:\\Zhiying\\models\\f5-tts\\F5TTS_v1_Base',
        licenseName: 'CC BY-NC 4.0',
        commercialUse: 'restricted',
        errorMessage: '',
      },
    ],
  };
  const html = renderToStaticMarkup(<DesktopModels status={status} />);
  for (const expected of ['模型管理', '保存位置', 'D:\\Zhiying\\models', 'Qwen3 4B', 'F5-TTS', '本地大模型', '语音合成', '已安装', '下载中', '25%', '2 GB', '1 GB', 'Apache-2.0', 'CC BY-NC 4.0', '非商业', '打开模型管理器', 'http://127.0.0.1:8790']) {
    assert.ok(html.includes(expected), `组件缺少内容: ${expected}`);
  }
});

test('[#105-19] DesktopModels 组件：不可用时说明原因与安装/下载入口提示', () => {
  const html = renderToStaticMarkup(
    <DesktopModels status={{ available: false, reason: '未检测到知影安装版目录：D:\\Zhiying。请先运行 Zhiying-Setup.exe 完成安装。', models: [] }} />,
  );
  assert.ok(html.includes('未检测到知影安装版目录'), '组件未展示不可用原因');
  assert.ok(html.includes('立即下载 AI 模型') || html.includes('稍后下载'), '应提示下载入口/安装版说明');
});

test('[#105-19] DesktopModels 组件：恶意模型文案经 React 转义（无 XSS）', () => {
  const malicious = '<img src=x onerror=alert(1)><script>alert("x")</script>';
  const html = renderToStaticMarkup(
    <DesktopModels
      status={{
        available: true,
        modelsRoot: 'D:\\Zhiying\\models',
        models: [
          {
            id: 'evil',
            name: malicious,
            purpose: 'tts',
            required: true,
            sizeBytes: 10,
            status: 'failed',
            receivedBytes: 0,
            installPath: 'D:\\Zhiying\\models\\evil',
            licenseName: `<b>${malicious}</b>`,
            commercialUse: 'unknown',
            errorMessage: malicious,
          },
        ],
      }}
    />,
  );
  assert.ok(!html.includes('<img src=x'), '模型名称未转义，存在 XSS');
  assert.ok(!html.includes('<script>alert'), '错误信息未转义，存在 XSS');
  assert.ok(html.includes('&lt;img'), '恶意文案应被 HTML 转义');
  assert.ok(html.includes('&lt;b&gt;'), '许可证名称应被 HTML 转义');
});

test('[#105 D] /api/models 路由：GET 返回 JSON + nodejs/force-dynamic + no-store，安装版状态可读', async (t) => {
  const root = makeInstallRoot(t, 'web-api', { states: { 'good-model': { status: 'installed', receivedBytes: 16, totalBytes: 16, percent: 100 } } });
  const saved = process.env.M2V_INSTALL_ROOT;
  process.env.M2V_INSTALL_ROOT = root;
  try {
    const response = await modelsRouteGet();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const payload = (await response.json()) as DesktopModelStatusResult;
    assert.equal(payload.available, true, payload.reason);
    assert.equal(payload.models.length, 2);
    assert.equal(payload.models.find((m) => m.id === 'good-model')?.status, 'installed');
  } finally {
    if (saved === undefined) delete process.env.M2V_INSTALL_ROOT;
    else process.env.M2V_INSTALL_ROOT = saved;
  }
  const routeSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'app', 'api', 'models', 'route.ts'), 'utf8');
  assert.match(routeSource, /export const runtime = 'nodejs'/, 'API 路由必须使用 nodejs runtime');
  assert.match(routeSource, /export const dynamic = 'force-dynamic'/, 'API 路由必须 force-dynamic');
  const pageSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'app', 'settings', 'models', 'page.tsx'), 'utf8');
  assert.match(pageSource, /readDesktopModelStatus/, '设置页必须读取安装版模型状态');
  assert.match(pageSource, /DesktopModels/, '设置页必须渲染 DesktopModels 组件');
  assert.match(pageSource, /返回设置/, '设置页应提供返回设置链接');
  const settingsSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'app', 'settings', 'page.tsx'), 'utf8');
  assert.match(settingsSource, /href="\/settings\/models"/, '设置页缺少“模型管理”入口链接');
  assert.match(settingsSource, /模型管理/, '设置页缺少模型管理区块');
  assert.match(settingsSource, /GeneralSettings/, '设置页既有区块不得被破坏');
  assert.match(settingsSource, /BrandKits/, '设置页既有品牌套件区块不得被破坏');
});
