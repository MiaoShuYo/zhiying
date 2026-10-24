import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAX_TAIL_LINES, clampTail, readJobLog, resolveJobLogPath, tailLines } from '../src/lib/job-logs';

test('clampTail keeps the requested size inside the API limits', () => {
  assert.equal(clampTail(200), 200);
  assert.equal(clampTail('50'), 50, '查询参数是字符串');
  assert.equal(clampTail(MAX_TAIL_LINES + 500), MAX_TAIL_LINES, '不能一次返回整个日志');
  assert.equal(clampTail(0), 200);
  assert.equal(clampTail(-5), 200);
  assert.equal(clampTail(2.5), 200);
  assert.equal(clampTail('abc'), 200);
  assert.equal(clampTail(undefined), 200);
});

test('tailLines keeps the last lines and drops the half read line', () => {
  const text = '1 开始\n2 渲染\n3 编码\n4 完成';
  assert.deepEqual(tailLines(text, 2), ['3 编码', '4 完成']);
  assert.deepEqual(tailLines(text, 99), ['1 开始', '2 渲染', '3 编码', '4 完成']);
  assert.deepEqual(tailLines(text, 2, true), ['3 编码', '4 完成'], '窗口从文件中部开始时只丢掉首行半行');
  assert.deepEqual(tailLines('a\nb\n\n\n', 10), ['a', 'b'], '尾部空行不占位置');
  assert.deepEqual(tailLines('', 10), []);
  assert.deepEqual(tailLines('只有一行', 1), ['只有一行']);
  assert.deepEqual(tailLines('a\r\nb', 5), ['a', 'b'], '同时兼容 CRLF');
});

test('resolveJobLogPath rejects ids that could escape the output directory', () => {
  const root = resolve('/data');
  assert.equal(resolveJobLogPath(root, 'proj-1', 'job-1'), join(root, 'projects', 'proj-1', 'output', 'job-1.log'));
  assert.equal(resolveJobLogPath(root, 'proj-1', '../../etc/passwd'), null);
  assert.equal(resolveJobLogPath(root, '../proj-1', 'job-1'), null);
  assert.equal(resolveJobLogPath(root, 'proj-1', 'job.1'), null, '日志文件名不能带点');
  assert.equal(resolveJobLogPath(root, 'proj-1', 'job 1'), null);
  assert.equal(resolveJobLogPath(root, 'proj-1', ''), null);
  assert.equal(resolveJobLogPath(root, 'proj-1', 'a'.repeat(65)), null, '超长 id 直接拒绝');
  assert.equal(resolveJobLogPath(root, 'proj-1', 'job_1-A2'), join(root, 'projects', 'proj-1', 'output', 'job_1-A2.log'));
});

test('readJobLog reports a missing file instead of throwing', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'm2v-logs-'));
  try {
    const missing = await readJobLog(join(sandbox, 'nope.log'), 20);
    assert.deepEqual(missing, { exists: false, lines: [], bytes: 0, windowed: false });
    const file = join(sandbox, 'job.log');
    await mkdir(join(sandbox, 'nested'), { recursive: true });
    await writeFile(file, '阶段 准备渲染资源\n阶段 渲染画面 40%\n');
    const tail = await readJobLog(file, 20);
    assert.equal(tail.exists, true);
    assert.equal(tail.windowed, false);
    assert.deepEqual(tail.lines, ['阶段 准备渲染资源', '阶段 渲染画面 40%']);
    assert.ok(tail.bytes > 0);
    const short = await readJobLog(file, 1);
    assert.deepEqual(short.lines, ['阶段 渲染画面 40%']);
    const empty = await readJobLog(join(sandbox, 'nested'), 5);
    assert.equal(empty.exists, false, '目录不是日志文件');
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('readJobLog only reads the tail of a large log', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'm2v-logs-'));
  try {
    const file = join(sandbox, 'big.log');
    const line = `${'x'.repeat(99)}\n`;
    await writeFile(file, line.repeat(8000));
    const tail = await readJobLog(file, 3);
    assert.equal(tail.exists, true);
    assert.equal(tail.windowed, true, '超过读取窗口时必须标记为截断');
    assert.equal(tail.lines.length, 3);
    assert.equal(tail.lines[0], 'x'.repeat(99), '首行半行已经丢弃，剩下的都是完整行');
    assert.ok(tail.bytes > 512 * 1024);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
