import test from 'node:test';
import assert from 'node:assert/strict';
import { parseByteRange } from '../src/lib/video-range';

test('没有 Range 头时整段返回', () => {
  assert.equal(parseByteRange(null, 1000), null);
  assert.equal(parseByteRange('   ', 1000), null);
});

test('起点到终点、起点到结尾、末尾若干字节都能解析', () => {
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=100-', 1000), { start: 100, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange(' bytes=0-0 ', 1000), { start: 0, end: 0 });
});

test('超过文件长度的终点收敛到最后一个字节', () => {
  assert.deepEqual(parseByteRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-5000', 1000), { start: 0, end: 999 }, '尾部请求比文件长就从 0 开始');
});

test('起点越界或区间倒置返回无法满足', () => {
  assert.equal(parseByteRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=2000-3000', 1000), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=500-100', 1000), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=0-', 0), 'unsatisfiable', '空文件无法满足任何区间');
  assert.equal(parseByteRange('bytes=-10', 0), 'unsatisfiable');
});

test('多区间或不认识的写法按整段返回，不猜客户端想要哪一段', () => {
  assert.equal(parseByteRange('bytes=0-99,200-299', 1000), null);
  assert.equal(parseByteRange('bytes=abc-def', 1000), null);
  assert.equal(parseByteRange('items=0-99', 1000), null);
  assert.equal(parseByteRange('bytes=-', 1000), null);
});
