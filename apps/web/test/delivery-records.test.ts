import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deliveryDirFor, deliveryRecordView, deliveryStaleReason, nextDeliveryRecord, readDeliveryRecord, readDeliveryRecords, writeDeliveryRecord,
  type DeliveryRecord,
} from '../src/lib/delivery-records';

const projectId = 'proj-1';
let sandbox = '';
let previousCwd = '';

before(async () => {
  previousCwd = process.cwd();
  sandbox = await mkdtemp(join(tmpdir(), 'm2v-delivery-'));
  await mkdir(join(sandbox, 'apps', 'web'), { recursive: true });
  process.chdir(join(sandbox, 'apps', 'web'));
});

after(async () => {
  process.chdir(previousCwd);
  await rm(sandbox, { recursive: true, force: true });
});

const record = (patch: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  version: 1, projectId, jobId: 'job-1', status: 'ready', stamp: '20260101-000000',
  name: '例子-交付包.zip', file: 'job-1-20260101-000000.zip', bytes: 2048, files: 5,
  missing: [], attempts: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

test('delivery records round-trip and are scoped to their own job', async () => {
  await writeDeliveryRecord(record());
  const stored = await readDeliveryRecord(projectId, 'job-1');
  assert.equal(stored?.name, '例子-交付包.zip');
  assert.equal(await readDeliveryRecord(projectId, 'job-2'), null);
  assert.equal(await readDeliveryRecord('proj-2', 'job-1'), null, '不能跨项目读取');
  const raw = JSON.parse(await readFile(join(deliveryDirFor(projectId), 'job-1.json'), 'utf8')) as DeliveryRecord;
  assert.equal(raw.jobId, 'job-1');
});

test('unsafe ids are rejected instead of escaping the data directory', async () => {
  for (const id of ['../escape', 'a/b', '', 'x'.repeat(65)]) {
    assert.throws(() => deliveryDirFor(id), /不合法/);
    assert.equal(await readDeliveryRecord(id, 'job-1'), null, '非法 ID 只返回 null，不抛给调用方');
  }
});

test('a corrupt or foreign record is ignored rather than trusted', async () => {
  await mkdir(deliveryDirFor(projectId), { recursive: true });
  await writeFile(join(deliveryDirFor(projectId), 'job-bad.json'), '{not json', 'utf8');
  await writeFile(join(deliveryDirFor(projectId), 'job-other.json'), JSON.stringify(record({ jobId: 'job-other', projectId: 'proj-2' })), 'utf8');
  const records = await readDeliveryRecords(projectId);
  assert.deepEqual([...records.keys()], ['job-1']);
});

test('a new attempt bumps the counter but keeps the first creation time', () => {
  const previous = record({ status: 'failed', missing: [{ step: 'validation', message: '成片校验未通过' }], error: '成片校验未通过' });
  const next = nextDeliveryRecord({ previous, projectId, jobId: 'job-1', stamp: '20260101-010000', status: 'ready', name: '新包.zip', file: 'job-1-20260101-010000.zip', bytes: 4096, files: 6 });
  assert.equal(next.attempts, 2);
  assert.equal(next.createdAt, previous.createdAt);
  assert.equal(next.updatedAt !== previous.updatedAt, true);
  assert.deepEqual(next.missing, [], '成功重试要清空上一次的缺失项');
  assert.equal(next.file, 'job-1-20260101-010000.zip');

  const first = nextDeliveryRecord({ previous: null, projectId, jobId: 'job-3', stamp: 's', status: 'failed', missing: [{ step: 'render', message: '未完成' }], error: '未完成' });
  assert.equal(first.attempts, 1);
  assert.equal(first.missing[0].step, 'render');
});

test('a ready record whose zip disappeared is reported as missing file', async () => {
  const view = await deliveryRecordView(record({ file: 'gone.zip' }));
  assert.equal(view.fileExists, false, '记录存在但文件已被清理时不能显示可下载');
  const failed = await deliveryRecordView(record({ status: 'failed' }));
  assert.equal(failed.fileExists, false);
});

test('a new attempt stores the revision and qc verdict it was built under', () => {
  const next = nextDeliveryRecord({
    previous: null, projectId, jobId: 'job-9', stamp: 's', status: 'ready',
    revision: 7, qc: { status: 'warning', errors: 0, warnings: 1 },
  });
  assert.equal(next.revision, 7);
  assert.deepEqual(next.qc, { status: 'warning', errors: 0, warnings: 1 });
  const legacy = nextDeliveryRecord({ previous: null, projectId, jobId: 'job-9', stamp: 's', status: 'ready' });
  assert.equal(legacy.revision, undefined, '没有来源信息时不编造版本');
});

test('an archive expires when the QC verdict blocks or the project moved on', () => {
  const built = record({ revision: 4, qc: { status: 'passed', errors: 0, warnings: 0 } });
  assert.equal(deliveryStaleReason(built, { revision: 4, qcStatus: 'passed' }), null, '同一版本同一结论仍然有效');
  assert.equal(deliveryStaleReason(built, { revision: 4, qcStatus: 'warning' }), null, '之后出现提醒不算过期');
  assert.equal(deliveryStaleReason(built, { revision: 4, qcStatus: 'blocking' }), 'qc-blocking', '阻断结论让旧包过期');
  assert.equal(deliveryStaleReason(built, { revision: 5, qcStatus: 'passed' }), 'project-changed', '项目有新修改时旧包过期');
  assert.equal(deliveryStaleReason(built, undefined), null, '拿不到当前状态时不误报过期');
  assert.equal(deliveryStaleReason(record({ status: 'failed', revision: 4 }), { revision: 5, qcStatus: 'blocking' }), null, '失败记录不叠加过期状态');
  // Records written before provenance existed can only be judged by the QC gate.
  const legacy = record();
  assert.equal(deliveryStaleReason(legacy, { revision: 99, qcStatus: 'passed' }), null);
  assert.equal(deliveryStaleReason(legacy, { revision: 99, qcStatus: 'blocking' }), 'qc-blocking');
});

test('the record view carries the staleness of the stored archive', async () => {
  const stale = await deliveryRecordView(record({ revision: 3 }), { revision: 3, qcStatus: 'blocking' });
  assert.equal(stale.stale, 'qc-blocking');
  assert.equal(stale.status, 'ready', '过期不等于生成失败，记录本身仍是成功');
  const fresh = await deliveryRecordView(record({ revision: 3 }), { revision: 3, qcStatus: 'passed' });
  assert.equal(fresh.stale, null);
});

test('records written before provenance existed still load', async () => {
  const legacy = record({ jobId: 'job-legacy' });
  delete legacy.revision;
  delete legacy.qc;
  await writeDeliveryRecord(legacy);
  const stored = await readDeliveryRecord(projectId, 'job-legacy');
  assert.equal(stored?.jobId, 'job-legacy', '旧记录缺少新字段也要能读取');
  assert.equal(stored?.revision, undefined);
});
