import test from 'node:test';
import assert from 'node:assert/strict';
import { qcStatusCountLabel, qcStatusFor, qcStatusHints, qcStatusLabels } from '../src/index';

test('the four QC states have distinct Chinese labels and hints', () => {
  assert.deepEqual(Object.values(qcStatusLabels), ['待检查', '通过', '提醒', '阻断']);
  assert.equal(new Set(Object.values(qcStatusHints)).size, 4);
});

test('an unchecked or missing report is always pending', () => {
  assert.equal(qcStatusFor(null), 'pending');
  assert.equal(qcStatusFor(undefined), 'pending');
  assert.equal(qcStatusFor({ errors: 3 }), 'blocking', '已检查的报告按计数判定');
  assert.equal(qcStatusFor({ errors: 0, warnings: 0 }, false), 'pending', '分镜已改动时旧报告不再有效');
  assert.equal(qcStatusFor({ errors: 3 }, false), 'pending');
});

test('checked reports map errors to blocking and warnings to warning', () => {
  assert.equal(qcStatusFor({ errors: 0, warnings: 0 }), 'passed');
  assert.equal(qcStatusFor({ errors: 0, warnings: 2 }), 'warning');
  assert.equal(qcStatusFor({ errors: 1, warnings: 0 }), 'blocking');
  assert.equal(qcStatusFor({ errors: 1, warnings: 5 }), 'blocking', '阻断优先于提醒');
  assert.equal(qcStatusFor({}), 'passed', '缺少计数字段视为没有缺陷');
});

test('counts are only shown for warning and blocking states', () => {
  assert.equal(qcStatusCountLabel('pending'), '待检查');
  assert.equal(qcStatusCountLabel('passed', 0), '通过');
  assert.equal(qcStatusCountLabel('warning', 3), '提醒 3');
  assert.equal(qcStatusCountLabel('blocking', 1), '阻断 1');
});
