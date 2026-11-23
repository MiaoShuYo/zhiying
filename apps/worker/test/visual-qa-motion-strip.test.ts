import test from 'node:test';
import assert from 'node:assert/strict';
import { visualQaMotionStripEntries } from '../src/visual-qa';

test('the motion strip contains cut boundaries when transitions are disabled', () => {
  const entries = visualQaMotionStripEntries({ entries: [
    { frame: 29, sceneId: 'a', roles: ['boundary'], preflight: true, afterRender: true, fromSceneId: 'a', toSceneId: 'b', transition: 'none' },
    { frame: 30, sceneId: 'b', roles: ['boundary'], preflight: true, afterRender: true, fromSceneId: 'a', toSceneId: 'b', transition: 'none' },
    { frame: 31, sceneId: 'b', roles: ['boundary'], preflight: true, afterRender: true, fromSceneId: 'a', toSceneId: 'b', transition: 'none' },
    { frame: 60, sceneId: 'b', roles: ['scene'], preflight: true, afterRender: true },
  ] });
  assert.deepEqual(entries.map(entry => entry.frame), [29, 30, 31]);
});

test('the motion strip retains transition samples', () => {
  const entries = visualQaMotionStripEntries({ entries: [
    { frame: 25, sceneId: 'b', roles: ['transition'], preflight: true, afterRender: true, fromSceneId: 'a', toSceneId: 'b', transition: 'crossfade' },
  ] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.transition, 'crossfade');
});
