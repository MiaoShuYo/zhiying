import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportDelivery, deliveryMissingText, deliveryState, type DeliveryRecord } from '../src/components/production-tools';

const record = (patch: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  status: 'ready',
  name: '启航-交付包-20250501-1200.zip',
  bytes: 8 * 1024 * 1024,
  files: 7,
  missing: [],
  attempts: 1,
  updatedAt: '2025-05-01T12:00:00.000Z',
  fileExists: true,
  ...patch,
});

const render = (delivery?: DeliveryRecord | null, busy = false) => renderToStaticMarkup(createElement(ExportDelivery, {
  delivery,
  busy,
  onDownload: () => {},
  onRegenerate: () => {},
}));

// 五态：未生成 / 生成失败 / 已生成 / 文件已过期 / 包已过期。
assert.equal(deliveryState(null), 'missing');
assert.equal(deliveryState(record({ status: 'failed', fileExists: false })), 'failed');
assert.equal(deliveryState(record()), 'ready');
assert.equal(deliveryState(record({ fileExists: false })), 'expired');
assert.equal(deliveryState(record({ stale: 'qc-blocking' })), 'stale', '在阻断结论下生成的包不能显示为已生成');
assert.equal(deliveryState(record({ stale: 'project-changed' })), 'stale', '落后于项目的包不能显示为已生成');

const missing = render(null);
assert.ok(missing.includes('交付包：未生成'), '未生成时要明确显示状态');
assert.ok(missing.includes('生成交付包'), '未生成时给出生成入口');
assert.ok(!missing.includes('再次下载'), '未生成时不能出现再次下载');
assert.ok(!missing.includes('文件中缺少'), '未生成时不应提示缺失环节');

const failed = render(record({
  status: 'failed',
  fileExists: false,
  bytes: undefined,
  files: undefined,
  error: '交付包生成失败',
  missing: [
    { step: 'render', message: '没有可用的成片文件' },
    { step: 'cover', message: '封面图未生成' },
  ],
  attempts: 2,
}));
assert.ok(failed.includes('交付包：生成失败'), '失败要明确显示');
assert.ok(failed.includes('第 2 次生成'), '失败要显示重试次数');
assert.ok(failed.includes('成片渲染（没有可用的成片文件）'), '缺失环节要用人话说明');
assert.ok(failed.includes('封面图（封面图未生成）'), '缺失环节要逐条列出');
assert.ok(failed.includes('重新生成交付包'), '失败后要能重试');
assert.ok(!failed.includes('再次下载'), '失败时不能提供下载');

const ready = render(record());
assert.ok(ready.includes('交付包：已生成'), '成功要显示已生成');
assert.ok(ready.includes('启航-交付包-20250501-1200.zip'), '要显示交付包文件名');
assert.ok(ready.includes('8.0 MB'), '要显示体积');
assert.ok(ready.includes('7 个文件'), '要显示文件数');
assert.ok(ready.includes('再次下载'), '已生成后要能再次下载');
assert.ok(ready.includes('重新生成交付包'), '已生成后仍可重新生成');

const expired = render(record({ fileExists: false }));
assert.ok(expired.includes('交付包：文件已过期'), '包被清理后要提示过期');
assert.ok(expired.includes('交付包文件已被清理，需要重新生成。'), '过期要给可操作提示');
assert.ok(!expired.includes('再次下载'), '过期后不能给失效的下载入口');
assert.ok(expired.includes('重新生成交付包'));

// 旧包：文件还在，但结论或版本已经过时 —— 必须写明原因，且不能继续提供下载。
const qcStale = render(record({ stale: 'qc-blocking', revision: 3, qc: { status: 'passed', errors: 0, warnings: 0 } }));
assert.ok(qcStale.includes('交付包：已过期'), '阻断后旧包要标为已过期，而不是已生成');
assert.ok(qcStale.includes('生成时质检未通过'), '要说明这个包是在阻断状态下生成的');
assert.ok(!qcStale.includes('再次下载'), '过期的包不能再给下载入口');
assert.ok(qcStale.includes('重新生成交付包'), '过期后要能重新生成');

const movedStale = render(record({ stale: 'project-changed', revision: 2 }));
assert.ok(movedStale.includes('交付包：已过期'));
assert.ok(movedStale.includes('生成之后项目又有修改'), '要说明包落后于项目');
assert.ok(!movedStale.includes('再次下载'));

const busy = render(record(), true);
assert.ok(busy.includes('下载中…'), '下载中要有进行中反馈');
assert.ok(!busy.includes('再次下载'));

assert.equal(deliveryMissingText(record({ missing: [{ step: 'subtitles', message: '字幕时间轴不合法' }] })), '字幕时间轴（字幕时间轴不合法）');
assert.equal(deliveryMissingText(record({ missing: [{ step: 'mystery', message: '未知原因' }] })), 'mystery（未知原因）', '未知环节回退到原始 step');

// 源码层面确认：导出记录不再自己复制一份交付包文案，且不再有误导性的成功判定。
const source = readFileSync(new URL('../src/components/production-tools.tsx', import.meta.url), 'utf8');
assert.ok(source.includes('<ExportDelivery'), '导出记录必须复用统一交付包组件');
assert.equal(source.match(/交付包：/g)?.length, 1, '交付包状态文案只能有一处');
assert.ok(!source.includes("delivery.status === 'ready' && delivery.fileExists &&"), '不应保留旧的重复交付包分支');

console.log('export-history-render: 通过');
