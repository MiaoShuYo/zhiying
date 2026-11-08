import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCodeScrollKeyframes,
  resolveCodeViewport,
  resolveCodeVisibleLineCount,
  type CodeBeatFrame,
} from '../src/index';

/** #19 契约：可读字号保护与自动 viewport 滚动（doc/V1.6.8_issues.md §2.3）。 */

const beat = (startFrame: number, endFrame: number, lines: number[]): CodeBeatFrame => ({ startFrame, endFrame, lines });

// ── #19-6 横屏/竖屏可见行数区间与默认值 ─────────────────────────────────────────
test('#19-6 resolveCodeVisibleLineCount 横屏落在 12..16、竖屏落在 7..11，非法尺寸回退默认值', () => {
  const samples = [
    { heightPx: 300, fontSizePx: 34 },
    { heightPx: 765, fontSizePx: 34 },
    { heightPx: 2000, fontSizePx: 34 },
    { heightPx: 765, fontSizePx: 22, lineHeightRatio: 1 },
    { heightPx: 1080, fontSizePx: 40 },
  ];
  for (const sample of samples) {
    const landscape = resolveCodeVisibleLineCount({ ...sample });
    const portrait = resolveCodeVisibleLineCount({ ...sample, portrait: true });
    assert.ok(Number.isInteger(landscape) && landscape >= 12 && landscape <= 16, `landscape ${landscape} for ${JSON.stringify(sample)}`);
    assert.ok(Number.isInteger(portrait) && portrait >= 7 && portrait <= 11, `portrait ${portrait} for ${JSON.stringify(sample)}`);
  }
  // 默认 lineHeightRatio = 1.5：765 / (34*1.5) = 15
  assert.equal(resolveCodeVisibleLineCount({ heightPx: 765, fontSizePx: 34 }), 15);
  assert.equal(resolveCodeVisibleLineCount({ heightPx: 765, fontSizePx: 34, lineHeightRatio: 1.5 }), 15);

  for (const broken of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveCodeVisibleLineCount({ heightPx: broken, fontSizePx: 34 }), 14, `heightPx=${broken} 横屏默认 14`);
    assert.equal(resolveCodeVisibleLineCount({ heightPx: broken, fontSizePx: 34, portrait: true }), 9, `heightPx=${broken} 竖屏默认 9`);
    assert.equal(resolveCodeVisibleLineCount({ heightPx: 765, fontSizePx: broken }), 14, `fontSizePx=${broken} 横屏默认 14`);
    assert.equal(resolveCodeVisibleLineCount({ heightPx: 765, fontSizePx: broken, portrait: true }), 9, `fontSizePx=${broken} 竖屏默认 9`);
  }
  // 正数但过小：算出的可见行数可能 <1，clamp 后仍在画幅区间内（而不是掉出区间）。
  const tinyLandscape = resolveCodeVisibleLineCount({ heightPx: 10, fontSizePx: 34 });
  const tinyPortrait = resolveCodeVisibleLineCount({ heightPx: 10, fontSizePx: 34, portrait: true });
  assert.ok(tinyLandscape >= 12 && tinyLandscape <= 16, `tiny landscape ${tinyLandscape}`);
  assert.ok(tinyPortrait >= 7 && tinyPortrait <= 11, `tiny portrait ${tinyPortrait}`);
});

// ── #19-9 resolveCodeViewport 边界矩阵 ──────────────────────────────────────────
test('#19-9 resolveCodeViewport：空 activeLines、previousStartLine 保持、active 居中、visible 超 totalLines', () => {
  // active 居中：first=last=50、visible=14 → round((50+50-14+1)/2)=44
  assert.deepEqual(
    resolveCodeViewport({ totalLines: 100, visibleLineCount: 14, activeLines: [50] }),
    { startLine: 44, endLine: 57 },
  );
  // 空 activeLines，无 previousStartLine → 从第 1 行开始
  assert.deepEqual(
    resolveCodeViewport({ totalLines: 100, visibleLineCount: 14, activeLines: [] }),
    { startLine: 1, endLine: 14 },
  );
  // 空 activeLines，previousStartLine 保持（clamp 到合法范围）
  assert.deepEqual(
    resolveCodeViewport({ totalLines: 100, visibleLineCount: 14, activeLines: [], previousStartLine: 20 }),
    { startLine: 20, endLine: 33 },
  );
  assert.deepEqual(
    resolveCodeViewport({ totalLines: 100, visibleLineCount: 14, activeLines: [], previousStartLine: 999 }),
    { startLine: 87, endLine: 100 },
    'previousStartLine 超上限被 clamp',
  );
  // active 完全落在上一个 viewport 内：保持原 viewport，不滚动
  assert.deepEqual(
    resolveCodeViewport({ totalLines: 100, visibleLineCount: 14, activeLines: [22, 23], previousStartLine: 20 }),
    { startLine: 20, endLine: 33 },
  );
  // active 越出上一个 viewport：重新居中并包含 active
  const moved = resolveCodeViewport({ totalLines: 100, visibleLineCount: 14, activeLines: [40, 41], previousStartLine: 20 });
  assert.ok(moved.startLine <= 40 && moved.endLine >= 41, `recentered viewport ${moved.startLine}-${moved.endLine} covers 40-41`);
  assert.deepEqual(moved, { startLine: 34, endLine: 47 });
  // visibleLineCount 超过 totalLines → clamp 到 totalLines
  assert.deepEqual(
    resolveCodeViewport({ totalLines: 10, visibleLineCount: 20, activeLines: [5] }),
    { startLine: 1, endLine: 10 },
  );
  // activeLines 中的 0/负数/超范围被过滤；没有有效值时使用 previousStartLine / 1
  assert.deepEqual(
    resolveCodeViewport({ totalLines: 100, visibleLineCount: 14, activeLines: [0, -1, 200], previousStartLine: 30 }),
    { startLine: 30, endLine: 43 },
  );
  assert.deepEqual(
    resolveCodeViewport({ totalLines: 100, visibleLineCount: 14, activeLines: [0, 200] }),
    { startLine: 1, endLine: 14 },
  );
  // visibleLineCount 非法（0/负）→ clamp 到 1
  assert.deepEqual(
    resolveCodeViewport({ totalLines: 10, visibleLineCount: 0, activeLines: [5] }),
    { startLine: 5, endLine: 5 },
  );
  // 单行代码
  assert.deepEqual(resolveCodeViewport({ totalLines: 1, visibleLineCount: 14, activeLines: [1] }), { startLine: 1, endLine: 1 });
});

// ── #19-5 首尾边界 clamp ────────────────────────────────────────────────────────
test('#19-5 active 在第 1 行/最后一行附近时 startLine=1 / endLine=totalLines，不越界', () => {
  assert.deepEqual(resolveCodeViewport({ totalLines: 120, visibleLineCount: 14, activeLines: [1] }), { startLine: 1, endLine: 14 });
  assert.deepEqual(resolveCodeViewport({ totalLines: 120, visibleLineCount: 14, activeLines: [120] }), { startLine: 107, endLine: 120 });
  assert.deepEqual(resolveCodeViewport({ totalLines: 50, visibleLineCount: 14, activeLines: [50] }), { startLine: 37, endLine: 50 });
  const matrix = [
    { totalLines: 30, visibleLineCount: 14, activeLines: [1] },
    { totalLines: 30, visibleLineCount: 14, activeLines: [2] },
    { totalLines: 30, visibleLineCount: 14, activeLines: [29] },
    { totalLines: 30, visibleLineCount: 14, activeLines: [30] },
    { totalLines: 120, visibleLineCount: 7, activeLines: [119, 120] },
    { totalLines: 3, visibleLineCount: 14, activeLines: [1, 2, 3] },
  ];
  for (const input of matrix) {
    const viewport = resolveCodeViewport(input);
    assert.ok(viewport.startLine >= 1, `startLine >= 1 for ${JSON.stringify(input)}`);
    assert.ok(viewport.endLine <= input.totalLines, `endLine <= totalLines for ${JSON.stringify(input)}`);
    assert.ok(viewport.endLine >= viewport.startLine, 'endLine >= startLine');
    assert.ok(Number.isInteger(viewport.startLine) && Number.isInteger(viewport.endLine), '整数行号');
  }
});

// ── #19-2 当前 beat 始终可见 ────────────────────────────────────────────────────
test('#19-2 任意位置的 activeLines 都完整包含在 resolveCodeViewport 返回的窗口内', () => {
  const totalLines = 120;
  const visibleLineCount = 14;
  let previousStartLine: number | undefined;
  for (const activeLines of [[1], [2], [13], [14], [15], [60], [61, 62], [107], [108], [119], [120], [118, 119, 120]]) {
    const viewport = resolveCodeViewport({ totalLines, visibleLineCount, activeLines, previousStartLine });
    for (const line of activeLines) {
      assert.ok(viewport.startLine <= line && viewport.endLine >= line, `active ${line} visible in ${viewport.startLine}-${viewport.endLine}`);
    }
    previousStartLine = viewport.startLine;
  }
});

// ── #19-3 跨区域 beat 产生滚动关键帧 ─────────────────────────────────────────────
test('#19-3 相邻 beat 行距大于 viewport 时产生过渡关键帧，startLine 变化', () => {
  const beats = [beat(0, 60, [1]), beat(60, 120, [100])];
  const keyframes = resolveCodeScrollKeyframes({ beats, totalLines: 120, visibleLineCount: 14 });
  assert.deepEqual(keyframes, [
    { frame: 0, startLine: 1 },
    { frame: 48, startLine: 1 },
    { frame: 60, startLine: 94 },
  ]);
  assert.equal(keyframes[1].frame, beats[1].startFrame - 12, '默认 12 帧内完成滚动');
  assert.equal(keyframes[2].frame, beats[1].startFrame, '滚动在高亮切换帧前完成');
});

// ── #19-4 同一 viewport 的连续 beat 不产生滚动 ──────────────────────────────────
test('#19-4 同一 viewport 内的连续 beat 只保留首个关键帧，不产生无意义滚动', () => {
  const beats = [beat(0, 40, [5]), beat(40, 80, [6]), beat(80, 120, [7])];
  const keyframes = resolveCodeScrollKeyframes({ beats, totalLines: 120, visibleLineCount: 14 });
  assert.deepEqual(keyframes, [{ frame: 0, startLine: 1 }]);
  assert.equal(resolveCodeScrollKeyframes({ beats: [], totalLines: 120, visibleLineCount: 14 }).length, 0, '空 beats → []');
  const delayed = [beat(30, 60, [5]), beat(60, 90, [6])];
  assert.deepEqual(resolveCodeScrollKeyframes({ beats: delayed, totalLines: 120, visibleLineCount: 14 }), [{ frame: 30, startLine: 1 }]);
});

// ── #19-7 过渡帧 8..15 且高亮与滚动同步 ────────────────────────────────────────
test('#19-7 transitionFrames 默认 12、clamp 到 8..15，滚动帧号与 beat.startFrame 同步', () => {
  const beats = [beat(0, 60, [1]), beat(60, 120, [100])];
  const defaulted = resolveCodeScrollKeyframes({ beats, totalLines: 120, visibleLineCount: 14 });
  assert.equal(beats[1].startFrame - defaulted[1].frame, 12);
  const short = resolveCodeScrollKeyframes({ beats, totalLines: 120, visibleLineCount: 14, transitionFrames: 5 });
  assert.equal(beats[1].startFrame - short[1].frame, 8, '下限 8');
  const long = resolveCodeScrollKeyframes({ beats, totalLines: 120, visibleLineCount: 14, transitionFrames: 30 });
  assert.equal(beats[1].startFrame - long[1].frame, 15, '上限 15');
  const custom = resolveCodeScrollKeyframes({ beats, totalLines: 120, visibleLineCount: 14, transitionFrames: 10 });
  assert.equal(beats[1].startFrame - custom[1].frame, 10, '合法自定义值生效');
  for (const keyframes of [defaulted, short, long, custom]) {
    const gap = keyframes[keyframes.length - 1].frame - keyframes[keyframes.length - 2].frame;
    assert.ok(gap >= 8 && gap <= 15, `过渡间隔 ${gap} 在 8..15`);
  }
  // 滚动完成帧 = beat.startFrame：关键帧必须包含 {frame: beat.startFrame, startLine: 新窗口}
  assert.deepEqual([defaulted[0].frame, defaulted[2].frame], [0, 60]);
});

// ── #19-10 关键帧帧号单调、可直接被 interpolate 消费 ────────────────────────────
test('#19-10 滚动关键帧帧号单调不减、首帧覆盖起点、行号合法且末帧语义正确', () => {
  const beats = [beat(0, 60, [1]), beat(60, 90, [60]), beat(120, 150, [110])];
  const keyframes = resolveCodeScrollKeyframes({ beats, totalLines: 120, visibleLineCount: 14 });
  assert.ok(keyframes.length >= 3);
  assert.equal(keyframes[0].frame, beats[0].startFrame, '首帧覆盖起点');
  for (let index = 0; index < keyframes.length; index += 1) {
    const keyframe = keyframes[index];
    assert.ok(Number.isInteger(keyframe.frame) && Number.isInteger(keyframe.startLine), '仅供 interpolate 消费的整数');
    assert.ok(keyframe.frame >= 0, 'frame 非负');
    assert.ok(keyframe.startLine >= 1 && keyframe.startLine <= 120, `startLine ${keyframe.startLine} 在 1..totalLines`);
    if (index > 0) assert.ok(keyframe.frame >= keyframes[index - 1].frame, '帧号单调不减');
  }
  assert.equal(keyframes[keyframes.length - 1].frame, beats[beats.length - 1].startFrame, '末帧落在最后一个变化 beat 的起点');

  // 滚动目标行号与 resolveCodeViewport 一致，可直接被滚动动画使用。
  for (const current of beats) {
    const target = resolveCodeViewport({ totalLines: 120, visibleLineCount: 14, activeLines: current.lines });
    const reached = keyframes.find(keyframe => keyframe.frame === current.startFrame);
    assert.ok(reached, `beat@${current.startFrame} 有完成帧`);
    assert.equal(reached?.startLine, target.startLine);
  }
});
