import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearCodeDiffCache,
  codeDiffCacheStats,
  computeCodeDiff,
  computeCodeDiffView,
  groupCodeDiffHunks,
  type CodeDiffLine,
} from '../src/index';

/**
 * #26 契约：真实 before/after 的稳定行级 diff、hunk 分组与缓存
 * （doc/V1.7.0_issues.md §2.3）。
 */

const join = (lines: string[]) => lines.join('\n');
const kinds = (lines: CodeDiffLine[]) => lines.map(line => line.kind);
const numbers = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

/** 基准用例：替换第 3 行，其余为上下文。 */
const REPLACE_BEFORE = join(['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;']);
const REPLACE_AFTER = join(['const a = 1;', 'const b = 2;', 'const c = 30;', 'const d = 4;', 'const e = 5;']);

const twoHunkBefore = join(numbers(20).map((line, index) => (index === 1 || index === 11 ? `old ${index + 1}` : line)));
const twoHunkAfter = join(numbers(20).map((line, index) => (index === 1 || index === 11 ? `new ${index + 1}` : line)));

// ═════════════════════════════ #26-1 行 diff 计算 ═════════════════════════════

test('#26-1 computeCodeDiff 行 kind 序列正确、确定性、无差异 hasChanges=false', () => {
  const lines = computeCodeDiff(REPLACE_BEFORE, REPLACE_AFTER);
  assert.deepEqual(kinds(lines), ['context', 'context', 'remove', 'add', 'context', 'context'], '替换：上下文/删除/新增/上下文');
  assert.deepEqual(lines.map(line => line.text), [
    'const a = 1;', 'const b = 2;', 'const c = 3;', 'const c = 30;', 'const d = 4;', 'const e = 5;',
  ], '文本逐字');
  assert.deepEqual(computeCodeDiff(REPLACE_BEFORE, REPLACE_AFTER), lines, '相同输入 deepEqual（确定性）');
  assert.deepEqual(computeCodeDiff(REPLACE_BEFORE, REPLACE_AFTER), computeCodeDiff(REPLACE_BEFORE, REPLACE_AFTER), '重复调用结果一致');

  // 纯新增：before 前缀 + after 中间插入 + before 后缀
  const inserted = computeCodeDiff(join(['a', 'b']), join(['a', 'new', 'b']));
  assert.deepEqual(kinds(inserted), ['context', 'add', 'context']);
  assert.equal(inserted[1].text, 'new');

  // 纯删除
  const removed = computeCodeDiff(join(['a', 'gone', 'b']), join(['a', 'b']));
  assert.deepEqual(kinds(removed), ['context', 'remove', 'context']);
  assert.equal(removed[1].text, 'gone');

  // 无差异：全部 context
  const same = computeCodeDiff(REPLACE_BEFORE, REPLACE_BEFORE);
  assert.deepEqual(kinds(same), ['context', 'context', 'context', 'context', 'context']);
  const sameView = computeCodeDiffView(REPLACE_BEFORE, REPLACE_BEFORE);
  assert.equal(sameView.hasChanges, false);
  assert.deepEqual(sameView.hunks, [], '无变更 hunks=[]');
  const changedView = computeCodeDiffView(REPLACE_BEFORE, REPLACE_AFTER);
  assert.equal(changedView.hasChanges, true);
});

// ═════════════════════════════ #26-2 行号 ═════════════════════════════════════

test('#26-2 context 同时有 oldLine/newLine；add 只有 newLine；remove 只有 oldLine；行号 1-based 连续', () => {
  const lines = computeCodeDiff(REPLACE_BEFORE, REPLACE_AFTER);
  const byKind = (kind: CodeDiffLine['kind']) => lines.filter(line => line.kind === kind);
  for (const line of byKind('context')) {
    assert.ok(Number.isInteger(line.oldLine) && line.oldLine! >= 1, `context oldLine 合法：${line.oldLine}`);
    assert.ok(Number.isInteger(line.newLine) && line.newLine! >= 1, `context newLine 合法：${line.newLine}`);
  }
  for (const line of byKind('add')) {
    assert.equal(line.oldLine, undefined, `add 无 oldLine：${JSON.stringify(line)}`);
    assert.ok(Number.isInteger(line.newLine) && line.newLine! >= 1);
  }
  for (const line of byKind('remove')) {
    assert.equal(line.newLine, undefined, `remove 无 newLine：${JSON.stringify(line)}`);
    assert.ok(Number.isInteger(line.oldLine) && line.oldLine! >= 1);
  }
  const removedLine = byKind('remove')[0];
  const addedLine = byKind('add')[0];
  assert.equal(removedLine.oldLine, 3, 'remove 行旧行号 3');
  assert.equal(addedLine.newLine, 3, 'add 行新行号 3');

  // 插入一行后，after 侧行号偏移：newLine 与 after 原文逐行对应，oldLine 与 before 原文对应
  const before = join(['a', 'b', 'c']);
  const after = join(['a', 'X', 'b', 'c']);
  const inserted = computeCodeDiff(before, after);
  const afterLines = after.split('\n');
  const beforeLines = before.split('\n');
  let expectedNew = 1;
  let expectedOld = 1;
  for (const line of inserted) {
    if (line.kind === 'context' || line.kind === 'add') {
      assert.equal(line.newLine, expectedNew, `${line.kind} 行新行号连续：${line.text}`);
      assert.equal(afterLines[line.newLine! - 1], line.text, `newLine 与 after 原文对应：${line.text}`);
      expectedNew += 1;
    }
    if (line.kind === 'context' || line.kind === 'remove') {
      assert.equal(line.oldLine, expectedOld, `${line.kind} 行旧行号连续：${line.text}`);
      assert.equal(beforeLines[line.oldLine! - 1], line.text, `oldLine 与 before 原文对应：${line.text}`);
      expectedOld += 1;
    }
  }
  assert.equal(expectedNew, afterLines.length + 1, 'newLine 覆盖 after 全部行');
  assert.equal(expectedOld, beforeLines.length + 1, 'oldLine 覆盖 before 全部行');

  // 删除场景：remove 行 oldLine 连续
  const deleted = computeCodeDiff(join(['a', 'b', 'c']), join(['a', 'c']));
  assert.deepEqual(kinds(deleted), ['context', 'remove', 'context']);
  assert.equal(deleted[1].oldLine, 2);
  assert.equal(deleted[2].oldLine, 3);
  assert.equal(deleted[2].newLine, 2);
});

// ═════════════════════════════ #26-3 边界输入 ═════════════════════════════════

test('#26-3 空串/单行替换/全等/CRLF/末尾换行/非字符串输入不抛错且语义正确', () => {
  // before 空串 = 新文件：全部 add
  const newFile = computeCodeDiff('', join(['a', 'b']));
  assert.deepEqual(kinds(newFile), ['add', 'add']);
  assert.deepEqual(newFile.map(line => line.newLine), [1, 2]);
  assert.ok(newFile.every(line => line.oldLine === undefined));

  // after 空串 = 删除文件：全部 remove
  const deletedFile = computeCodeDiff(join(['a', 'b']), '');
  assert.deepEqual(kinds(deletedFile), ['remove', 'remove']);
  assert.deepEqual(deletedFile.map(line => line.oldLine), [1, 2]);
  assert.ok(deletedFile.every(line => line.newLine === undefined));

  // 两边都空
  assert.deepEqual(computeCodeDiff('', ''), []);
  assert.equal(computeCodeDiffView('', '').hasChanges, false);

  // 单行替换
  const single = computeCodeDiff('const x = 1;', 'const x = 2;');
  assert.deepEqual(kinds(single), ['remove', 'add']);

  // 全等
  assert.equal(computeCodeDiffView(join(['a', 'b', 'c']), join(['a', 'b', 'c'])).hasChanges, false);

  // CRLF：按 codeLines 归一，不产生幽灵行
  const crlf = computeCodeDiff('a\r\nb\r\nc', 'a\r\nB\r\nc');
  assert.deepEqual(kinds(crlf), ['context', 'remove', 'add', 'context']);
  assert.equal(crlf.length, 4, 'CRLF 不产生空行/幽灵行');
  assert.deepEqual(crlf.filter(line => line.kind === 'context').map(line => line.text), ['a', 'c']);

  // 末尾换行不产生差异
  assert.equal(computeCodeDiff('a\nb\n', 'a\nb').length, 2);
  assert.equal(computeCodeDiffView('a\nb\n', 'a\nb').hasChanges, false);

  // 非字符串输入按空串处理、不抛错
  assert.doesNotThrow(() => computeCodeDiff(null as unknown as string, undefined as unknown as string));
  assert.deepEqual(computeCodeDiff(null as unknown as string, undefined as unknown as string), []);
  const removedByNonString = computeCodeDiff('a', 42 as unknown as string);
  assert.deepEqual(kinds(removedByNonString), ['remove'], 'after 非字符串按空串 → 全 remove');
  const noThrowView = computeCodeDiffView(42 as unknown as string, null as unknown as string);
  assert.equal(noThrowView.hasChanges, false);
  assert.deepEqual(noThrowView.lines, []);
  assert.deepEqual(noThrowView.hunks, []);

  // 空行是真实行
  const withEmpty = computeCodeDiff('a\n\nb', 'a\n\nb');
  assert.deepEqual(withEmpty.map(line => line.text), ['a', '', 'b']);
});

// ═════════════════════════════ #26-4 hunk 分组 ════════════════════════════════

test('#26-4 hunk 分组：context=3 默认、间隔 >2×context 才拆分、首尾上下文 ≤context、id/下标/计数/起点正确', () => {
  // 两个变更块之间 9 行上下文 > 6 → 拆成 2 个 hunk
  const split = computeCodeDiffView(twoHunkBefore, twoHunkAfter);
  assert.equal(split.hunks.length, 2, `间隔 9 行上下文应拆成 2 个 hunk：${split.hunks.length}`);
  assert.deepEqual(split.hunks.map(hunk => hunk.id), ['h1', 'h2'], 'id 顺序 h1..hN');
  for (const hunk of split.hunks) {
    assert.deepEqual(hunk.lines, split.lines.slice(hunk.startIndex, hunk.endIndex + 1), `${hunk.id} lines 与 startIndex..endIndex 切片一致`);
    const firstChange = hunk.lines.findIndex(line => line.kind !== 'context');
    const lastChange = hunk.lines.reduce((last, line, index) => (line.kind !== 'context' ? index : last), -1);
    assert.ok(firstChange <= 3, `${hunk.id} 首部上下文 ≤3（实际 ${firstChange}）`);
    assert.ok(hunk.lines.length - 1 - lastChange <= 3, `${hunk.id} 尾部上下文 ≤3（实际 ${hunk.lines.length - 1 - lastChange}）`);
    assert.equal(hunk.addCount, hunk.lines.filter(line => line.kind === 'add').length, `${hunk.id} addCount`);
    assert.equal(hunk.removeCount, hunk.lines.filter(line => line.kind === 'remove').length, `${hunk.id} removeCount`);
    const firstOld = hunk.lines.find(line => line.oldLine !== undefined);
    const firstNew = hunk.lines.find(line => line.newLine !== undefined);
    assert.equal(hunk.oldStart, firstOld?.oldLine ?? 0, `${hunk.id} oldStart`);
    assert.equal(hunk.newStart, firstNew?.newLine ?? 0, `${hunk.id} newStart`);
  }
  assert.equal(split.hunks[0].oldStart, 1);
  assert.equal(split.hunks[0].newStart, 1);
  assert.equal(split.hunks[1].oldStart, 9, '第二 hunk 从旧行 9 的上下文开始');
  assert.equal(split.hunks[1].newStart, 9);

  // 两个变更块之间仅 5 行上下文 ≤ 6 → 合并为 1 个 hunk
  const closeBefore = join(numbers(12).map((line, index) => (index === 1 || index === 7 ? `old ${index + 1}` : line)));
  const closeAfter = join(numbers(12).map((line, index) => (index === 1 || index === 7 ? `new ${index + 1}` : line)));
  const merged = computeCodeDiffView(closeBefore, closeAfter);
  assert.equal(merged.hunks.length, 1, '间隔 5 行上下文应合并为 1 个 hunk');
  assert.equal(merged.hunks[0].addCount, 2);
  assert.equal(merged.hunks[0].removeCount, 2);

  // 无变更 → hunks=[]
  assert.deepEqual(groupCodeDiffHunks(computeCodeDiff(REPLACE_BEFORE, REPLACE_BEFORE)), []);

  // context=0：只保留变更行
  const zero = computeCodeDiffView(twoHunkBefore, twoHunkAfter, 0);
  assert.equal(zero.hunks.length, 2, 'context=0 仍按间隔拆分');
  for (const hunk of zero.hunks) {
    assert.equal(hunk.lines.every(line => line.kind !== 'context'), true, `context=0 的 ${hunk.id} 不含上下文行`);
    assert.ok(hunk.addCount + hunk.removeCount === hunk.lines.length);
  }

  // 纯插入在文件头：oldStart=0、newStart=1
  const insertHead = computeCodeDiffView(join(['a', 'b']), join(['X', 'a', 'b']), 0);
  assert.equal(insertHead.hunks.length, 1);
  assert.equal(insertHead.hunks[0].oldStart, 0, '无旧行时 oldStart=0');
  assert.equal(insertHead.hunks[0].newStart, 1);
  assert.equal(insertHead.hunks[0].removeCount, 0);
  assert.equal(insertHead.hunks[0].addCount, 1);

  // 删除文件：newStart=0
  const deleteAll = computeCodeDiffView(join(['a', 'b']), '', 0);
  assert.equal(deleteAll.hunks.length, 1);
  assert.equal(deleteAll.hunks[0].oldStart, 1);
  assert.equal(deleteAll.hunks[0].newStart, 0, '无新行时 newStart=0');

  // 相邻变更块（无上下文间隔）合并
  const adjacent = computeCodeDiffView(join(['a', 'b', 'c']), join(['A', 'b', 'C']));
  assert.equal(adjacent.hunks.length, 1, '相邻变更合并为一个 hunk');

  // 非法 context 回退 3；0..10 合法
  const baseline = computeCodeDiffView(twoHunkBefore, twoHunkAfter, 3);
  for (const bad of [11, -1, Number.NaN, 3.5, 100]) {
    assert.deepEqual(computeCodeDiffView(twoHunkBefore, twoHunkAfter, bad), baseline, `context=${bad} 回退 3`);
  }
  for (const value of [0, 1, 2, 10]) {
    assert.doesNotThrow(() => computeCodeDiffView(twoHunkBefore, twoHunkAfter, value), `context=${value} 合法`);
  }
  // context=10 时两个变更块合并
  assert.equal(computeCodeDiffView(twoHunkBefore, twoHunkAfter, 10).hunks.length, 1, 'context=10 时 9 行间隔合并');
});

// ═════════════════════════════ #26-1 缓存（key/命中/FIFO/容量） ═══════════════

test('#26-1 computeCodeDiffView 缓存：首次 miss 后 hit、key 含 context、容量 32 FIFO、size≤capacity、clear 清空', () => {
  clearCodeDiffCache();
  const initial = codeDiffCacheStats();
  assert.deepEqual(initial, { hits: 0, misses: 0, size: 0, capacity: 32 }, '初始缓存统计');

  computeCodeDiffView(REPLACE_BEFORE, REPLACE_AFTER);
  assert.deepEqual(codeDiffCacheStats(), { hits: 0, misses: 1, size: 1, capacity: 32 }, '首次 miss');
  computeCodeDiffView(REPLACE_BEFORE, REPLACE_AFTER);
  assert.deepEqual(codeDiffCacheStats(), { hits: 1, misses: 1, size: 1, capacity: 32 }, '重复 hit');

  computeCodeDiffView(REPLACE_BEFORE, REPLACE_AFTER, 1);
  assert.deepEqual(codeDiffCacheStats(), { hits: 1, misses: 2, size: 2, capacity: 32 }, 'context 参与 key，重新 miss');
  computeCodeDiffView(REPLACE_BEFORE, REPLACE_AFTER, 1);
  assert.equal(codeDiffCacheStats().hits, 2, '同 context 再次 hit');

  clearCodeDiffCache();
  assert.deepEqual(codeDiffCacheStats(), { hits: 0, misses: 0, size: 0, capacity: 32 }, 'clear 清空');

  // 33 个不同 key：容量 32，最早插入的 key 被 FIFO 淘汰
  const pairs: { before: string; after: string }[] = [];
  for (let index = 0; index < 33; index += 1) {
    pairs.push({ before: `before ${index}`, after: `after ${index}` });
    computeCodeDiffView(pairs[index].before, pairs[index].after);
    assert.ok(codeDiffCacheStats().size <= codeDiffCacheStats().capacity, `size ≤ capacity（第 ${index + 1} 次）`);
  }
  assert.equal(codeDiffCacheStats().misses, 33);
  assert.equal(codeDiffCacheStats().size, 32, '容量上限 32');

  const last = pairs[pairs.length - 1];
  computeCodeDiffView(last.before, last.after);
  assert.equal(codeDiffCacheStats().hits, 1, '最近插入的 key 仍在缓存');
  const first = pairs[0];
  computeCodeDiffView(first.before, first.after);
  assert.equal(codeDiffCacheStats().misses, 34, '最早插入的 key 已被 FIFO 淘汰');
  assert.ok(codeDiffCacheStats().size <= 32);

  // computeCodeDiff 纯计算不受缓存影响
  assert.deepEqual(computeCodeDiff(REPLACE_BEFORE, REPLACE_AFTER), computeCodeDiff(REPLACE_BEFORE, REPLACE_AFTER));
});
