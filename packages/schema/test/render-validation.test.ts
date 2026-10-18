import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRender, renderValidationLabels, type ExpectedRender, type ProbeSummary } from '../src/index';

const expected: ExpectedRender = { width: 1920, height: 1080, duration: 12, requireAudio: true };
const probe = (patch: Partial<ProbeSummary> = {}): ProbeSummary => ({ width: 1920, height: 1080, duration: 12, videoCodec: 'h264', audioCodec: 'aac', hasVideo: true, hasAudio: true, ...patch });

test('a matching file passes with no issue', () => {
  const result = evaluateRender(probe(), expected, 4_096);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.fileBytes, 4_096);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  assert.equal(result.hasAudio, true);
  assert.deepEqual(result.expected, expected);
  assert.ok(!Number.isNaN(Date.parse(result.checkedAt)), '校验时间要可解析');
});

test('an unreadable file blocks delivery', () => {
  const result = evaluateRender(null, expected, 0);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(issue => issue.code), ['unreadable']);
  assert.equal(result.issues[0].blocking, true);
  assert.equal(result.hasAudio, false);
  assert.equal(result.width, undefined);
});

test('a zero-byte file is reported as an interrupted render', () => {
  const result = evaluateRender(probe(), expected, 0);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.blocking]), [['empty_file', true]]);
});

test('a file without a video track blocks delivery and skips the resolution check', () => {
  const result = evaluateRender(probe({ hasVideo: false, width: undefined, height: undefined }), expected, 1_024);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.blocking]), [['no_video', true]]);
});

test('a missing audio track is a reminder, not a blocker', () => {
  const result = evaluateRender(probe({ hasAudio: false, audioCodec: undefined }), expected, 1_024);
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.blocking]), [['no_audio', false]]);
  const silent = evaluateRender(probe({ hasAudio: false }), { ...expected, requireAudio: false }, 1_024);
  assert.equal(silent.ok, true, '无声分镜不该因为缺少音轨而报问题');
  assert.deepEqual(silent.issues, []);
});

test('resolution drift within 2 px is tolerated, larger drift is a reminder', () => {
  assert.equal(evaluateRender(probe({ width: 1922, height: 1078 }), expected, 1_024).ok, true);
  const off = evaluateRender(probe({ width: 1923 }), expected, 1_024);
  assert.equal(off.ok, false);
  assert.deepEqual(off.issues.map(issue => [issue.code, issue.blocking]), [['resolution_mismatch', false]]);
  assert.match(off.issues[0].message, /1923 × 1080/);
  assert.match(off.issues[0].message, /1920 × 1080/);
});

test('duration tolerance is the larger of 1.5 s and 2 %', () => {
  assert.equal(evaluateRender(probe({ duration: 13.4 }), expected, 1_024).ok, true, '短片的容差下限是 1.5 秒');
  const short = evaluateRender(probe({ duration: 13.6 }), expected, 1_024);
  assert.deepEqual(short.issues.map(issue => issue.code), ['duration_mismatch']);
  assert.match(short.issues[0].message, /相差 1\.6 秒/);
  const long = { ...expected, duration: 200 };
  assert.equal(evaluateRender(probe({ duration: 203.9 }), long, 1_024).ok, true, '长片按 2 % 放宽');
  assert.deepEqual(evaluateRender(probe({ duration: 204.5 }), long, 1_024).issues.map(issue => issue.code), ['duration_mismatch']);
});

test('an unknown duration is not reported as a mismatch', () => {
  assert.equal(evaluateRender(probe({ duration: undefined }), expected, 1_024).ok, true);
  assert.equal(evaluateRender(probe({ duration: Number.NaN }), expected, 1_024).ok, true);
});

test('every issue code has a Chinese label', () => {
  assert.deepEqual(Object.keys(renderValidationLabels).sort(), ['duration_mismatch', 'empty_file', 'no_audio', 'no_video', 'resolution_mismatch', 'unreadable']);
  for (const label of Object.values(renderValidationLabels)) assert.match(label, /[\u4e00-\u9fa5]/);
});
