import assert from 'node:assert/strict';
import test from 'node:test';
import { translateString } from '../src/components/language-switcher';

test('preflight error and warning counts stay in the selected language', () => {
  const summary = '91 错误 / 176 警告';
  assert.equal(translateString(summary, 'zh'), summary);
  assert.equal(translateString(summary, 'en'), '91 errors / 176 warnings');
  assert.equal(translateString(summary, 'ja'), 'エラー91件／警告176件');
});
