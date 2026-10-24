import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipWriter, crc32 } from '../src/lib/zip';
import { readZip } from './zip-reader';

const withSandbox = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'm2v-zip-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

test('crc32 matches the reference vector and chains across chunks', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  const whole = crc32(Buffer.from('交付包校验'));
  const chained = crc32(Buffer.from('包校验'), crc32(Buffer.from('交付')));
  assert.equal(chained, whole, '分块计算结果必须与整体一致');
});

test('entries keep insertion order, UTF-8 names and stored bytes', async () => {
  await withSandbox(async dir => {
    const file = join(dir, '交付包.zip');
    const source = join(dir, '成片.txt');
    await writeFile(source, '来自磁盘的文件');
    const zip = await ZipWriter.create(file);
    await zip.addText('说明.txt', '字幕与成片使用同一时间轴');
    await zip.addBuffer('视频/成片.mp4', Buffer.from([0, 1, 2, 250, 255]));
    await zip.addFile('备份/项目.m2v', source);
    await zip.addBuffer('空文件.txt', Buffer.alloc(0));
    await zip.finish();

    const entries = readZip(await readFile(file));
    assert.deepEqual(entries.map(entry => entry.name), ['说明.txt', '视频/成片.mp4', '备份/项目.m2v', '空文件.txt']);
    for (const entry of entries) assert.equal(entry.method, 0, '交付包使用存储模式');
    assert.equal(entries[0].data.toString('utf8'), '字幕与成片使用同一时间轴');
    assert.equal(entries[0].crc, crc32(entries[0].data));
    assert.equal(entries[0].size, Buffer.byteLength('字幕与成片使用同一时间轴'));
    assert.deepEqual([...entries[1].data], [0, 1, 2, 250, 255]);
    assert.equal(entries[2].data.toString('utf8'), '来自磁盘的文件');
    assert.equal(entries[2].crc, crc32(Buffer.from('来自磁盘的文件')));
    assert.equal(entries[3].size, 0);
    assert.equal(entries[3].crc, 0);
  });
});

test('unsafe or empty entry names are rejected', async () => {
  await withSandbox(async dir => {
    const zip = await ZipWriter.create(join(dir, 'bad.zip'));
    for (const name of ['', '../逃出.txt', 'a\\b.txt', '/绝对.txt', 'a//b.txt', 'a/../b.txt', '结尾点.', '结尾空格 ', 'x'.repeat(201)]) {
      await assert.rejects(zip.addBuffer(name, Buffer.from('x')), /文件名/, `${name} 必须被拒绝`);
    }
    await assert.rejects(zip.addText('中'.repeat(90), '内容'), /文件名过长/);
    await assert.rejects(zip.addFile('目录.txt', dir), /不是文件/);
    await zip.addText('正常.txt', 'ok');
    await zip.finish();
    assert.deepEqual(readZip(await readFile(join(dir, 'bad.zip'))).map(entry => entry.name), ['正常.txt'], '被拒绝的条目不能写进交付包');
  });
});

test('a finished archive is closed and finish is idempotent', async () => {
  await withSandbox(async dir => {
    const file = join(dir, 'closed.zip');
    const zip = await ZipWriter.create(file);
    await zip.addText('a.txt', 'a');
    await zip.finish();
    await zip.finish();
    await assert.rejects(zip.addBuffer('b.txt', Buffer.from('b')), /交付包已经关闭/);
    await assert.rejects(zip.addText('c.txt', 'c'), /交付包已经关闭/);
    const entries = readZip(await readFile(file));
    assert.deepEqual(entries.map(entry => entry.name), ['a.txt'], '关闭后不能再追加条目');
  });
});

test('abort leaves no central directory', async () => {
  await withSandbox(async dir => {
    const file = join(dir, 'aborted.zip');
    const zip = await ZipWriter.create(file);
    await zip.addText('半成品.txt', '中断');
    await zip.abort();
    await zip.abort();
    const buffer = await readFile(file);
    assert.equal(buffer.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), false, '中断的交付包不能以结束记录收尾');
    assert.ok(buffer.length > 0, '已写入的条目数据留在磁盘上，由调用方删除临时文件');
  });
});

test('addFile rejects a source that vanished mid-package', async () => {
  await withSandbox(async dir => {
    const source = join(dir, '临时.bin');
    await writeFile(source, 'data');
    const zip = await ZipWriter.create(join(dir, 'gone.zip'));
    await zip.addFile('临时.bin', source);
    await rm(source);
    await assert.rejects(zip.addFile('临时.bin', source), /ENOENT|no such file/);
    await zip.finish();
    assert.equal(readZip(await readFile(join(dir, 'gone.zip'))).length, 1);
  });
});

test('a missing target directory fails before writing entries', async () => {
  await withSandbox(async dir => {
    await assert.rejects(ZipWriter.create(join(dir, 'missing', 'new.zip')), /ENOENT/);
    await mkdir(join(dir, 'exists'));
    const zip = await ZipWriter.create(join(dir, 'exists', 'ok.zip'));
    await zip.addText('a.txt', 'a');
    await zip.finish();
  });
});
