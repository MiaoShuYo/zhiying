/**
 * #105-1 / #105-2 模型 manifest 类型、校验、默认清单（§2.5）。
 * 对抗非法输入：重复 id、非法 id、installDir 穿越/重叠、sha256 格式、totalBytes 不一致、许可证缺失。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRoot, cleanupRegisteredTempDirs } from './_helpers/temp';
import { makeManifest, makeHttpEntry, F5_LICENSE, ModelManifestLike } from './_helpers/fixtures';
import { writeJson, sha256Buffer, deterministicBytes } from './_helpers/fsx';
import {
  validateModelManifest,
  loadModelManifest,
  defaultModelManifest,
  manifestEntryById,
  requiredModelIds,
} from '../src/model-manifest';

function validManifest(): ModelManifestLike {
  const { entry } = makeHttpEntry({ id: 'f5-tts-base', files: [{ path: 'model.bin', data: deterministicBytes(128, 'x') }] });
  return makeManifest([entry]);
}

function expectInvalid(input: unknown, label: string): void {
  const result = validateModelManifest(input);
  assert.equal(result.ok, false, `非法 manifest 被接受: ${label}`);
  if (!result.ok) {
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0, `${label}: 缺少可读 errors`);
    assert.ok(
      result.errors.every((e) => typeof e === 'string' && e.trim().length > 0),
      `${label}: errors 含空串`,
    );
  }
}

test('[#105-1] validateModelManifest 接受合法清单', () => {
  const result = validateModelManifest(validManifest());
  assert.equal(result.ok, true, `合法清单被拒绝: ${JSON.stringify(result)}`);
  if (result.ok) {
    assert.equal(result.manifest.schemaVersion, 1);
    assert.equal(result.manifest.models.length, 1);
    assert.equal(result.manifest.models[0].id, 'f5-tts-base');
  }
});

test('[#105-1] validateModelManifest 拒绝结构/唯一 id/非法 id/非法 installDir/许可证缺失', () => {
  expectInvalid(null, 'null');
  expectInvalid('str', '字符串');
  expectInvalid({}, '空对象');
  expectInvalid({ schemaVersion: 2, version: '1', generatedAt: 'x', models: [] }, 'schemaVersion=2');
  expectInvalid({ schemaVersion: 1, version: '1', generatedAt: 'x', models: 'nope' }, 'models 非数组');

  const base = validManifest();
  const dup = makeManifest([base.models[0], { ...base.models[0], installDir: 'other' }]);
  expectInvalid(dup, '重复 id');

  for (const badId of ['Qwen3', 'a b', '_leading', '', 'a/b', 'a:b']) {
    const m = validManifest();
    m.models[0].id = badId;
    expectInvalid(m, `非法 id=${JSON.stringify(badId)}`);
  }

  for (const badDir of ['../evil', 'a/../../evil', 'C:\\evil', '', ':ads', 'CON']) {
    const m = validManifest();
    m.models[0].installDir = badDir;
    expectInvalid(m, `非法 installDir=${JSON.stringify(badDir)}`);
  }

  const overlap = makeManifest([
    base.models[0],
    { ...makeHttpEntry({ id: 'vocos', files: [{ path: 'm.bin', data: deterministicBytes(16, 'y') }], installDir: `${base.models[0].installDir}/nested` }).entry },
  ]);
  expectInvalid(overlap, 'installDir 互相重叠');

  const noLicense = validManifest() as unknown as { models: Array<Record<string, unknown>> };
  delete noLicense.models[0].license;
  expectInvalid(noLicense, '许可证缺失');

  const badLicense = validManifest();
  (badLicense.models[0].license as unknown as Record<string, unknown>).commercialUse = 'maybe';
  expectInvalid(badLicense, 'commercialUse 非法');

  const badPurpose = validManifest();
  (badPurpose.models[0] as unknown as Record<string, unknown>).purpose = 'image';
  expectInvalid(badPurpose, 'purpose 非法');

  const badSource = validManifest();
  (badSource.models[0].source as unknown as Record<string, unknown>).kind = 'ftp';
  expectInvalid(badSource, 'source.kind 非法');
});

test('[#105-1] sha256 完整性校验：必须有 64 位小写 hex，totalBytes 必须等于文件求和', () => {
  for (const badHash of ['abc', '', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)] as string[]) {
    const m = validManifest();
    m.models[0].files[0].sha256 = badHash;
    expectInvalid(m, `非法 sha256=${JSON.stringify(badHash)}`);
  }

  const missingHash = validManifest() as unknown as { models: Array<{ files: Array<Record<string, unknown>> }> };
  delete missingHash.models[0].files[0].sha256;
  expectInvalid(missingHash, 'integrity=sha256 但缺 sha256');

  const wrongTotal = validManifest();
  wrongTotal.models[0].totalBytes = wrongTotal.models[0].totalBytes + 1;
  expectInvalid(wrongTotal, 'totalBytes 与 files 求和不一致');

  const zeroTotal = validManifest();
  zeroTotal.models[0].totalBytes = 0;
  expectInvalid(zeroTotal, 'totalBytes=0');

  // size 完整性允许无 sha256（仅在无法取得官方哈希时使用）
  const sizeIntegrity = validManifest();
  sizeIntegrity.models[0].integrity = 'size';
  for (const f of sizeIntegrity.models[0].files) delete f.sha256;
  const ok = validateModelManifest(sizeIntegrity);
  assert.equal(ok.ok, true, `integrity=size 且无 sha256 应合法: ${JSON.stringify(ok)}`);
});

test('[#105-1] loadModelManifest 对缺失/损坏文件返回可读错误', async (t) => {
  const dir = makeTempRoot('manifest-load');
  t.after(() => cleanupRegisteredTempDirs());

  await assert.rejects(() => loadModelManifest(path.join(dir, 'missing.json')), (err: unknown) => {
    assert.ok(err instanceof Error && err.message.trim().length > 0);
    return true;
  });

  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{ broken json');
  await assert.rejects(() => loadModelManifest(corrupt), (err: unknown) => {
    assert.ok(err instanceof Error && /json|解析|parse|invalid|损坏/i.test(err.message), `损坏错误不可读: ${err instanceof Error ? err.message : err}`);
    return true;
  });

  const invalid = path.join(dir, 'invalid.json');
  await writeJson(invalid, { schemaVersion: 1, models: [{ id: 'BAD' }] });
  await assert.rejects(() => loadModelManifest(invalid), (err: unknown) => {
    assert.ok(err instanceof Error && err.message.trim().length > 0);
    return true;
  });

  // 合法文件可读取
  const good = path.join(dir, 'good.json');
  await writeJson(good, validManifest());
  const loaded = await loadModelManifest(good);
  assert.equal(loaded.models[0].id, 'f5-tts-base');
});

test('[#105-2] 默认清单四类模型齐全、许可/完整性/来源合法', () => {
  const manifest = defaultModelManifest();
  const byId = new Map(manifest.models.map((m) => [m.id, m]));
  const expected: Array<{ id: string; purpose: string }> = [
    { id: 'qwen3-4b', purpose: 'llm' },
    { id: 'f5-tts-base', purpose: 'tts' },
    { id: 'vocos-mel-24khz', purpose: 'vocoder' },
    { id: 'align-zh-xlsr', purpose: 'alignment' },
  ];
  for (const exp of expected) {
    const entry = byId.get(exp.id);
    assert.ok(entry, `默认清单缺少模型 ${exp.id}`);
    assert.equal(entry.purpose, exp.purpose, `${exp.id} purpose 错误`);
    assert.equal(entry.required, true, `${exp.id} 应为必需模型`);
    assert.ok(entry.totalBytes > 0, `${exp.id} totalBytes 必须 > 0`);
    assert.ok(entry.license && entry.license.name && entry.license.notes, `${exp.id} 许可证字段不完整`);
    assert.ok(['allowed', 'restricted', 'unknown'].includes(entry.license.commercialUse), `${exp.id} commercialUse 非法`);
  }

  // Qwen 走 Ollama 源
  const qwen = byId.get('qwen3-4b')!;
  assert.equal(qwen.source.kind, 'ollama');
  assert.equal(qwen.source.ollamaModel, 'qwen3:4b');
  assert.equal(qwen.integrity, 'ollama-digest');

  // F5-TTS 必须标注 CC BY-NC 4.0 且 restricted
  const f5 = byId.get('f5-tts-base')!;
  assert.equal(f5.source.kind, 'huggingface');
  assert.equal(f5.source.repo, 'SWivid/F5-TTS');
  assert.equal(f5.license.commercialUse, 'restricted');
  assert.match(f5.license.name, /CC BY-NC 4\.0/i, `F5-TTS 许可必须是 CC BY-NC 4.0，实际 ${f5.license.name}`);

  // 对齐模型固定 revision
  const align = byId.get('align-zh-xlsr')!;
  assert.equal(align.source.kind, 'huggingface');
  assert.equal(align.source.repo, 'jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn');
  assert.ok(typeof align.source.revision === 'string' && align.source.revision.length >= 7, '对齐模型必须固定 revision');

  // 全量再校验通过 + 文件哈希格式合法
  const result = validateModelManifest(manifest);
  assert.equal(result.ok, true, `默认清单自身校验失败: ${JSON.stringify(result)}`);
  for (const model of manifest.models) {
    if (model.integrity === 'sha256') {
      assert.ok(model.files.length > 0);
      for (const file of model.files) assert.match(file.sha256 ?? '', /^[0-9a-f]{64}$/, `${model.id}/${file.path} sha256 非法`);
    }
    assert.ok(model.installDir.length > 0 && !model.installDir.startsWith('..'), `${model.id} installDir 非法`);
  }
});

test('[#105-2] 默认清单源文件存在、确定性 JSON 且 requiredModelIds/manifestEntryById 可用', async () => {
  const jsonPath = path.resolve(import.meta.dirname, '..', 'src', 'model-manifest.default.json');
  assert.ok(fs.existsSync(jsonPath), `默认清单文件必须存在: ${jsonPath}`);
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const parsed = JSON.parse(raw) as ModelManifestLike;
  assert.equal(validateModelManifest(parsed).ok, true);
  assert.ok(sha256Buffer(Buffer.from(raw, 'utf8')).length === 64);

  const manifest = defaultModelManifest();
  const required = requiredModelIds(manifest);
  assert.ok(required.includes('qwen3-4b'));
  assert.ok(required.includes('f5-tts-base'));
  assert.equal(manifestEntryById(manifest, 'qwen3-4b')?.id, 'qwen3-4b');
  assert.equal(manifestEntryById(manifest, 'no-such-model'), undefined);
});
