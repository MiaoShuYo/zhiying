/**
 * P2 #311: GFDL is reviewed like other licences, not treated as public domain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLicense, readCredit } from '../src/lib/commons-license';

test('[#311] GFDL is not public domain', () => {
  assert.equal(classifyLicense('GFDL'), 'other');
  assert.equal(classifyLicense('CC0'), 'public-domain');
  const credit = readCredit({ LicenseShortName: { value: 'GFDL' } }, 'https://commons.wikimedia.org/wiki/File:x.png');
  assert.equal(credit.licenseClass, 'other');
  assert.ok(credit.warnings.some(warning => /人工确认/.test(warning)));
  assert.ok(credit.warnings.some(warning => /署名/.test(warning)), '缺少署名时同样提示');
});

test('[#140] overall model progress uses the saved download totals', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readDesktopModelStatus } = await import('../src/lib/desktop-models');
  const root = mkdtempSync(join(tmpdir(), 'm2v-desktop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'models', '.downloads'), { recursive: true });
  writeFileSync(join(root, 'config', 'install.json'), JSON.stringify({ version: '1.8.0', installRoot: root, modelManifest: 'models/.downloads/manifest.json', ports: { manager: 8790 } }));
  writeFileSync(join(root, 'models', '.downloads', 'manifest.json'), JSON.stringify({ schemaVersion: 1, models: [
    { id: 'qwen', name: 'Qwen', totalBytes: 2_600_000_000, installDir: 'ollama/qwen' },
    { id: 'tts', name: 'TTS', totalBytes: 1000, installDir: 'tts' },
  ] }));
  writeFileSync(join(root, 'models', '.downloads', 'state.json'), JSON.stringify({ models: {
    qwen: { status: 'installed', receivedBytes: 2_500_000_000, totalBytes: 2_500_000_000, percent: 100 },
    tts: { status: 'installed', receivedBytes: 1000, totalBytes: 1000, percent: 100 },
  } }));
  const result = await readDesktopModelStatus({ installRoot: root, env: {} as NodeJS.ProcessEnv });
  assert.equal(result.overall?.percent, 100, JSON.stringify(result.overall));
  writeFileSync(join(root, 'models', '.downloads', 'state.json'), JSON.stringify({ models: {
    qwen: { status: 'downloading', receivedBytes: 10 },
    tts: { status: 'installed', receivedBytes: 1000, totalBytes: 1000 },
  } }));
  assert.equal((await readDesktopModelStatus({ installRoot: root, env: {} as NodeJS.ProcessEnv })).overall?.indeterminate, true, '总大小未知的下载显示为不确定');
});
