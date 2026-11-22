import test from 'node:test';
import assert from 'node:assert/strict';
import { visualQaChromiumOptions } from '../src/visual-qa';

test('visual QA selects SwiftShader only for an explicit CPU-only run', () => {
  assert.deepEqual(visualQaChromiumOptions(true), { gl: 'swiftshader' });
  assert.equal(visualQaChromiumOptions(false), undefined);
});
