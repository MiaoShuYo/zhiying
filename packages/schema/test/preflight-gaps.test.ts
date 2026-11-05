import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SceneSchema, StoryboardSchema, preflight, preflightCategories, preflightCategoryOf, preflightDelta, preflightGapCounts, preflightGaps, preflightGroups,
} from '../src/index';

const scene = (patch: Record<string, unknown> = {}) => SceneSchema.parse({ id: 'a', type: 'title', narration: '第一句。第二句。', visual: {}, duration: 6, ...patch });
const board = (scenes: Record<string, unknown>[], patch: Record<string, unknown> = {}) => StoryboardSchema.parse({ title: '例子', styleId: 'minimal-tech', scenes, ...patch });
// Every path is stale: that is the state a project is in when files were moved or deleted outside the app.
const gone = () => false;
const image = 'projects/p/assets/a.png';

test('两个场景引用同一张丢失的图片只占一行清单', () => {
  const shared = board([
    scene({ id: 'a', type: 'media', visual: { src: image }, audioSrc: 'audio/a.wav', audioDuration: 6 }),
    scene({ id: 'b', type: 'media', visual: { src: image }, audioSrc: 'audio/b.wav', audioDuration: 6 }),
  ]);
  const result = preflight(shared, [{ path: image, kind: 'image' }], { exists: gone });
  const images = preflightGaps(result).filter(gap => gap.kind === 'image');
  assert.equal(images.length, 1, '同一个文件不该按场景重复列出');
  assert.equal(images[0].path, image);
  assert.equal(images[0].severity, 'error');
  assert.equal(images[0].fix, 'upload_asset');
  assert.deepEqual(images[0].scenes.map(item => item.sceneIndex), [0, 1], '清单要记住所有引用它的场景');
  assert.match(images[0].message, /已不存在/);
});

test('没有语音的场景按场景各占一行，且给出生成语音的修复入口', () => {
  const result = preflight(board([scene({ id: 'a' }), scene({ id: 'b' })]), []);
  const audio = preflightGaps(result).filter(gap => gap.kind === 'audio');
  assert.equal(audio.length, 2);
  assert.equal(audio[0].fix, 'generate_audio');
  assert.equal(audio[0].path, null, '还没生成的语音没有文件路径');
  assert.equal(audio[0].scenes.length, 1);
  assert.notEqual(audio[0].key, audio[1].key);
});

test('缺失语音文件归入配音，缺失图片文件归入素材', () => {
  const result = preflight(board([
    scene({ id: 'a', type: 'media', visual: { src: image }, audioSrc: 'audio/a.wav', audioDuration: 6 }),
  ]), [{ path: image, kind: 'image' }], { exists: gone });
  const missing = result.issues.filter(issue => issue.code === 'missing_file');
  assert.equal(missing.length, 2, '图片与语音各报一条');
  assert.deepEqual(missing.map(issue => preflightCategoryOf(issue)), ['asset', 'voice']);
  assert.deepEqual(preflightGaps(result).map(gap => gap.kind).sort(), ['audio', 'image']);
});

test('未登记的图片给出打开素材的修复入口', () => {
  const stray = scene({ id: 'a', type: 'media', visual: { src: 'projects/p/assets/stray.png' }, audioSrc: 'audio/a.wav', audioDuration: 6 });
  const result = preflight(board([stray]), [{ path: image, kind: 'image' }], { exists: gone });
  const gap = preflightGaps(result).find(item => item.kind === 'image')!;
  assert.equal(gap.fix, 'open_assets');
  assert.equal(gap.path, 'projects/p/assets/stray.png');
  assert.match(gap.message, /没有登记/);
});

test('清单按严重程度和场景顺序排列，警告排在错误之后', () => {
  const result = preflight(board([
    scene({ id: 'a', type: 'media', visual: { src: image }, audioSrc: 'audio/a.wav', audioDuration: 6 }),
    scene({ id: 'b', audioSrc: 'audio/b.wav', audioDuration: 6, subtitleCues: [{ text: '很'.repeat(120), start: 0, end: 2 }] }),
  ]), [{ path: image, kind: 'image' }], { exists: gone });
  const gaps = preflightGaps(result);
  assert.equal(gaps[0].kind, 'image');
  assert.equal(gaps[0].severity, 'error', '阻断问题排在最前');
  const last = gaps[gaps.length - 1];
  assert.equal(last.kind, 'subtitle');
  assert.equal(last.severity, 'warning');
  assert.equal(last.fix, 'open_captions');
  assert.deepEqual(gaps.map(gap => gap.severity), [...gaps.map(gap => gap.severity)].sort((left, right) => (left === right ? 0 : left === 'error' ? -1 : 1)));
});

test('重复引用只保留一次场景、且不会因同一条问题多出两行', () => {
  const twice = board([
    scene({ id: 'a', type: 'media', visual: { src: image }, audioSrc: 'audio/a.wav', audioDuration: 6 }),
    scene({ id: 'b', type: 'media', visual: { src: image }, audioSrc: 'audio/b.wav', audioDuration: 6 }),
  ]);
  const result = preflight(twice, [{ path: image, kind: 'image' }], { exists: gone });
  const gap = preflightGaps(result).find(item => item.kind === 'image')!;
  assert.equal(new Set(gap.scenes.map(item => item.sceneIndex)).size, gap.scenes.length, '场景列表不能有重复项');
});

test('「缺失文件」计数不含字幕时间轴警告', () => {
  const longOnly = board([
    scene({ id: 'a', audioSrc: 'audio/a.wav', audioDuration: 6, subtitleCues: [{ text: '很'.repeat(120), start: 0, end: 2 }] }),
  ]);
  const onlyCaptions = preflightGaps(preflight(longOnly, [], { exists: () => true }));
  assert.equal(onlyCaptions.length, 1, '唯一的清单行是字幕问题');
  assert.deepEqual(preflightGapCounts(onlyCaptions), { files: 0, subtitles: 1 }, '字幕过长不算缺失文件');
  const withImage = board([
    scene({ id: 'a', type: 'media', visual: { src: image }, audioSrc: 'audio/a.wav', audioDuration: 6, subtitleCues: [{ text: '很'.repeat(120), start: 0, end: 2 }] }),
  ]);
  const mixed = preflightGaps(preflight(withImage, [{ path: image, kind: 'image' }], { exists: path => path !== image }));
  assert.deepEqual(preflightGapCounts(mixed), { files: 1, subtitles: 1 }, '缺图与字幕问题各自计数');
  assert.equal(preflightGapCounts([]).files, 0);
});

test('检查前后能说清修好了几项、还剩几项', () => {
  const before = preflight(board([scene({ id: 'a' })]), []);
  assert.ok(before.blocking > 0);
  assert.deepEqual(preflightDelta(null, before), { fixed: 0, added: 0, remaining: before.issues.length }, '第一次检查没有可比对象');
  const after = preflight(board([scene({ id: 'a', audioSrc: 'audio/a.wav', audioDuration: 6 })]), []);
  assert.equal(after.blocking, 0);
  assert.deepEqual(preflightDelta(before, after), { fixed: before.issues.length, added: 0, remaining: 0 });
  assert.deepEqual(preflightDelta(after, after), { fixed: 0, added: 0, remaining: 0 });
});

test('分组固定按语音、图片、字幕、素材、旁白、渲染的顺序出现', () => {
  const result = preflight(board([
    scene({ id: 'a', type: 'media', visual: { src: image }, audioSrc: 'audio/a.wav', audioDuration: 6 }),
    scene({ id: 'b', narration: ' ' }),
  ]), [{ path: image, kind: 'image' }], { exists: gone });
  const groups = preflightGroups(result);
  const order = groups.map(group => preflightCategories.indexOf(group.category));
  assert.deepEqual(order, [...order].sort((left, right) => left - right), '分组顺序必须与固定顺序一致');
  assert.ok(groups.some(group => group.category === 'voice' && group.blocking > 0));
  assert.ok(groups.some(group => group.category === 'narration' && group.warnings > 0));
  assert.equal(groups.reduce((total, group) => total + group.issues.length, 0), result.issues.length, '分组不能漏掉问题');
});
